/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';
import * as tsp from 'typescript/lib/protocol';
import * as fs from 'fs';
import * as commandExists from 'command-exists';

import { CommandTypes, EventTypes } from './tsp-command-types';

import { Logger, PrefixingLogger } from './logger';
import { TspClient } from './tsp-client';

import { LspClient } from './lsp-client';
import { DiagnosticEventQueue } from './diagnostic-queue';
import { findPathToModule } from './modules-resolver';
import { toDocumentHighlight } from './protocol-translation';
import {
    uriToPath, toSymbolKind, toLocation, toPosition,
    completionKindsMapping, pathToUri, toTextEdit, toPlainText, toMarkDown, toTextDocumentEdit
} from './protocol-translation';
import { getTsserverExecutable } from './utils';
import { LspDocument } from './document';

export interface IServerOptions {
    logger: Logger
    tsserverPath?: string;
    tsserverLogFile?: string;
    tsserverLogVerbosity?: string;
    lspClient: LspClient;
}

export const WORKSPACE_EDIT_COMMAND = "workspace-edit";

export class LspServer {

    private initializeParams: lsp.InitializeParams;
    private initializeResult: lsp.InitializeResult;
    private tspClient: TspClient;
    private openedDocumentUris: Map<string, LspDocument> = new Map<string, LspDocument>();
    private diagnosticQueue: DiagnosticEventQueue;
    private logger: Logger;

    constructor(private options: IServerOptions) {
        this.logger = new PrefixingLogger(options.logger, '[lspserver]')
        this.diagnosticQueue = new DiagnosticEventQueue(
            diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
            this.logger);
    }

    public closeAll(): void {
        for (const [uri, doc] of this.openedDocumentUris) {
            this.didCloseTextDocument({
                textDocument: {
                    uri,
                    languageId: doc.languageId,
                    version: doc.version,
                    text: doc.getText()
                }
            });
        }
    }

    protected findTsserverPath(): string {
        if (this.options.tsserverPath) {
            return this.options.tsserverPath;
        }
        // 1) look into node_modules of workspace root
        let executable = findPathToModule(this.rootPath(), `.bin/${getTsserverExecutable()}`)
        if (executable) {
            return executable;
        }
        // 2) use globally installed tsserver
        if (commandExists.sync(getTsserverExecutable())) {
            return getTsserverExecutable();
        }
        // 3) look into node_modules of typescript-language-server
        const bundled = findPathToModule(__dirname, `.bin/${getTsserverExecutable()}`);
        if (!bundled) {
            throw Error(`Couldn't find '${getTsserverExecutable()}' executable`)
        }
        return bundled;
    }

    public async initialize(params: lsp.InitializeParams): Promise<lsp.InitializeResult> {
        this.logger.log('initialize', params);
        this.initializeParams = params;

        const tsserverPath = this.findTsserverPath();
        this.tspClient = new TspClient({
            tsserverPath,
            logFile: this.options.tsserverLogFile,
            logVerbosity: this.options.tsserverLogVerbosity,
            logger: this.options.logger,
            onEvent: this.onTsEvent.bind(this)
        });

        this.tspClient.start();

        this.initializeResult = {
            capabilities: {
                textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
                completionProvider: {
                    triggerCharacters: ['.'],
                    resolveProvider: true
                },
                codeActionProvider: true,
                definitionProvider: true,
                documentFormattingProvider: true,
                documentHighlightProvider: true,
                documentSymbolProvider: true,
                executeCommandProvider: {
                    commands: [WORKSPACE_EDIT_COMMAND]
                },
                hoverProvider: true,
                renameProvider: true,
                referencesProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['(', ',']
                },
                workspaceSymbolProvider: true,
                implementationProvider: true,
                typeDefinitionProvider: true,
                foldingRangeProvider: true
            }
        };

        this.logger.log('onInitialize result', this.initializeResult);
        return this.initializeResult;
    }

    public requestDiagnostics(): Promise<tsp.RequestCompletedEvent> {
        const files: string[] = []
        // sort by least recently usage
        const orderedUris = [...this.openedDocumentUris.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed).map(e => e[0]);
        for (const uri of orderedUris) {
            files.push(uriToPath(uri));
        }
        const args: tsp.GeterrRequestArgs = {
            delay: 0,
            files: files
        };
        return this.tspClient.request(CommandTypes.Geterr, args);
    }

    public didOpenTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('onDidOpenTextDocument', params, path);
        if (this.openedDocumentUris.get(params.textDocument.uri) !== undefined) {
            this.logger.log(`Cannot open already opened doc '${params.textDocument.uri}'.`);
            this.didChangeTextDocument({
                textDocument: params.textDocument,
                contentChanges: [
                    {
                        text: params.textDocument.text
                    }
                ]
            })
        } else {
            this.tspClient.notify(CommandTypes.Open, {
                file: path,
                fileContent: params.textDocument.text,
                scriptKindName: this.getScriptKindName(params.textDocument.languageId),
                projectRootPath: this.rootPath()
            });
            this.openedDocumentUris.set(params.textDocument.uri, new LspDocument(params.textDocument));
            this.requestDiagnostics();
        }
    }

    protected getScriptKindName(languageId: string): tsp.ScriptKindName | undefined {
        switch (languageId) {
            case 'typescript': return 'TS';
            case 'typescriptreact': return 'TSX';
            case 'javascript': return 'JS';
            case 'javascriptreact': return 'JSX';
        }
        return undefined;
    }

    public didCloseTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('onDidCloseTextDocument', params, path);
        this.tspClient.notify(CommandTypes.Close, { file: path });
        this.openedDocumentUris.delete(params.textDocument.uri)

        // We won't be updating diagnostics anymore for that file, so clear them
        // so we don't leave stale ones.
        this.options.lspClient.publishDiagnostics({
            uri: params.textDocument.uri,
            diagnostics: [],
        });
    }

    public didChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        const path = uriToPath(params.textDocument.uri)

        this.logger.log('onDidChangeTextDocument', params, path);
        const document = this.openedDocumentUris.get(params.textDocument.uri);
        if (!document) {
            this.logger.error("Received change on non-opened document " + params.textDocument.uri);
            throw new Error("Received change on non-opened document " + params.textDocument.uri);
        }
        document.markAccessed();

        for (const change of params.contentChanges) {
            let line, offset, endLine, endOffset = 0;
            if (!change.range) {
                line = 1;
                offset = 1;
                const endPos = document.positionAt(document.getText().length);
                endLine = endPos.line + 1;
                endOffset = endPos.character + 1;
            } else {
                line = change.range.start.line + 1;
                offset = change.range.start.character + 1;
                endLine = change.range.end.line + 1;
                endOffset = change.range.end.character + 1;
            }
            this.tspClient.notify(CommandTypes.Change, {
                file: path,
                line,
                offset,
                endLine,
                endOffset,
                insertString: change.text
            });
        }
        this.requestDiagnostics();
    }

    public didSaveTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        // do nothing
    }

    async definition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        // TODO: implement version checking and if semver.gte(version, 270) use `definitionAndBoundSpan` instead
        return this.getDefinition({
            type: 'definition',
            params
        });
    }

    async implementation(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'implementation',
            params
        });
    }

    async typeDefinition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'typeDefinition',
            params
        });
    }

    protected async getDefinition({ type, params }: {
        type: 'definition' | 'implementation' | 'typeDefinition',
        params: lsp.TextDocumentPositionParams
    }): Promise<lsp.Definition> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log(type, params, path);

        const result = await this.tspClient.request(type as CommandTypes.Definition, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        return result.body ? result.body.map(fileSpan => toLocation(fileSpan)) : [];
    }

    public async documentSymbol(params: lsp.TextDocumentPositionParams): Promise<lsp.SymbolInformation[]> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('symbol', params, path);

        const response = await this.tspClient.request(CommandTypes.NavTree, {
            file: path
        });
        if (!response.body) {
            return [];
        }
        const result: lsp.SymbolInformation[] = [];
        const collectSymbol: (element: tsp.NavigationTree, parent: string | undefined, acceptor: (sym: lsp.SymbolInformation) => void) => void =
            (element, parent, acceptor) => {
                const start = element.spans[0];
                const end = element.spans[element.spans.length - 1];
                if (start && end) {
                    const symbol = lsp.SymbolInformation.create(
                        element.text,
                        toSymbolKind(element.kind),
                        { start: toPosition(start.start), end: toPosition(end.end) },
                        params.textDocument.uri,
                        parent
                    );
                    acceptor(symbol);
                }
                if (element.childItems) {
                    for (const child of element.childItems) {
                        collectSymbol(child, element.text, acceptor);
                    }
                }
            };
        collectSymbol(response.body, undefined, sym => result.push(sym));
        return result;
    }

    public async completion(params: lsp.TextDocumentPositionParams): Promise<lsp.CompletionList> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('completion', params, path);

        const result = await this.tspClient.request(CommandTypes.Completions, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1,
            prefix: '',
            includeExternalModuleExports: true,
            includeInsertTextCompletions: true
        });
        return {
            isIncomplete: false,
            items: result.body ? result.body
                .map(item => {
                    return <lsp.CompletionItem>{
                        label: item.name,
                        kind: completionKindsMapping[item.kind],
                        // store information for resolve
                        data: {
                            file: path,
                            line: params.position.line + 1,
                            offset: params.position.character + 1
                        }
                    };
                }) : []
        };
    }

    public async completionResolve(item: lsp.CompletionItem): Promise<lsp.CompletionItem> {
        this.logger.log('completion/resolve', item);
        const result = await this.tspClient.request(CommandTypes.CompletionDetails, <tsp.CompletionDetailsRequestArgs>{
            entryNames: [item.label],
            file: item.data.file as string,
            line: item.data.line as number,
            offset: item.data.offset as number,
        })
        if (!result.body) {
            return item
        }
        const documentation = result.body[0] && result.body[0].documentation;
        if (documentation) {
            item.documentation = documentation.map(i => i.text).join('\n');
        }
        return item;
    }

    public async hover(params: lsp.TextDocumentPositionParams): Promise<lsp.Hover> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('hover', params, path);

        let result
        try {
            result = await this.tspClient.request(CommandTypes.Quickinfo, {
                file: path,
                line: params.position.line + 1,
                offset: params.position.character + 1
            });
        } catch (err) {
            return <lsp.Hover>{
                contents: []
            }
        }
        if (!result.body) {
            return <lsp.Hover>{
                contents: []
            }
        }
        const range = {
            start: toPosition(result.body.start),
            end: toPosition(result.body.end)
        };
        const contents: lsp.MarkedString[] = [
            { language: 'typescript', value: result.body.displayString }
        ];
        if (result.body.documentation) {
            contents.push(result.body.documentation)
        }
        return {
            contents,
            range
        }
    }

    public async rename(params: lsp.RenameParams): Promise<lsp.WorkspaceEdit> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('onRename', params, path);

        const result = await this.tspClient.request(CommandTypes.Rename, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });

        const workspaceEdit = {
            changes: {}
        };

        if (!result.body || !result.body.info.canRename || result.body.locs.length === 0) {
            return workspaceEdit;
        }
        result.body.locs
            .forEach((spanGroup) => {
                const uri = pathToUri(spanGroup.file),
                    textEdits = workspaceEdit.changes[uri] || (workspaceEdit.changes[uri] = []);

                spanGroup.locs.forEach((textSpan) => {
                    textEdits.push({
                        newText: params.newName,
                        range: {
                            start: toPosition(textSpan.start),
                            end: toPosition(textSpan.end)
                        }
                    });
                });
            });

        return workspaceEdit;
    }

    public async references(params: lsp.TextDocumentPositionParams): Promise<lsp.Location[]> {
        const path = uriToPath(params.textDocument.uri);

        this.logger.log('onReferences', params, path);

        const result = await this.tspClient.request(CommandTypes.References, {
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!result.body) {
            return [];
        }
        return result.body.refs
            .map(fileSpan => toLocation(fileSpan));
    }

    public async documentFormatting(params: lsp.DocumentFormattingParams): Promise<lsp.TextEdit[]> {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('documentFormatting', params, path);

        let opts = <tsp.FormatCodeSettings>{
            ...params.options
        }

        // translate
        if (opts.convertTabsToSpaces === undefined) {
            opts.convertTabsToSpaces = params.options.insertSpaces
        }
        if (opts.indentSize === undefined) {
            opts.indentSize = params.options.tabSize
        }

        try {
            opts = JSON.parse(fs.readFileSync(this.rootPath() + "/tsfmt.json", 'utf-8'));
        } catch (err) {
            this.logger.log("No formatting options found " + err)
        }

        // options are not yet supported in tsserver, but we can send a configure request first
        await this.tspClient.request(CommandTypes.Configure, <tsp.ConfigureRequestArguments>{
            formatOptions: opts
        });

        const response = await this.tspClient.request(CommandTypes.Format, <tsp.FormatRequestArgs>{
            file: path,
            line: 1,
            offset: 1,
            endLine: Number.MAX_SAFE_INTEGER,
            endOffset: Number.MAX_SAFE_INTEGER,
            options: opts
        });
        if (response.body) {
            return response.body.map(e => toTextEdit(e));
        }
        return [];
    }

    public async signatureHelp(params: lsp.TextDocumentPositionParams): Promise<lsp.SignatureHelp> {
        const path = uriToPath(params.textDocument.uri);
        this.logger.log('signatureHelp', params, path);

        const response = await this.tspClient.request(CommandTypes.SignatureHelp, <tsp.SignatureHelpRequestArgs>{
            file: path,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!response.body) {
            return {
                signatures: [],
                activeSignature: null,
                activeParameter: null
            };
        }
        const info = response.body;

        const signatures: lsp.SignatureInformation[] = [];
        let activeSignature = response.body.selectedItemIndex;
        let activeParameter = response.body.argumentIndex;

        response.body.items.forEach((item, i) => {
            // keep active parameter in bounds
            if (i === info.selectedItemIndex && item.isVariadic) {
                activeParameter = Math.min(info.argumentIndex, item.parameters.length - 1);
            }

            let label = toPlainText(item.prefixDisplayParts);
            const parameters: lsp.ParameterInformation[] = [];
            item.parameters.forEach((p, i, a) => {
                const parameter = lsp.ParameterInformation.create(
                    toPlainText(p.displayParts),
                    toPlainText(p.documentation));
                label += parameter.label;
                parameters.push(parameter);
                if (i < a.length - 1) {
                    label += toPlainText(item.separatorDisplayParts);
                }
            });
            label += toPlainText(item.suffixDisplayParts);
            const documentation = toMarkDown(item.documentation, item.tags);
            signatures.push({
                label,
                documentation,
                parameters
            });
        });

        return {
            signatures,
            activeSignature,
            activeParameter
        }
    }

    public async codeAction(arg: lsp.CodeActionParams): Promise<lsp.Command[]> {
        this.logger.log('codeAction', arg);
        let response
        try {
            response = await this.tspClient.request(CommandTypes.GetCodeFixes, <tsp.CodeFixRequestArgs>{
                file: uriToPath(arg.textDocument.uri),
                startLine: arg.range.start.line + 1,
                startOffset: arg.range.start.character + 1,
                endLine: arg.range.end.line + 1,
                endOffset: arg.range.end.character + 1,
                errorCodes: arg.context.diagnostics.map(d => d.code)
            })
        } catch (err) {
            return [];
        }
        if (!response.body) {
            return []
        }
        const result: lsp.Command[] = [];
        for (const fix of response.body) {
            result.push({
                title: fix.description,
                command: WORKSPACE_EDIT_COMMAND,
                arguments: [<lsp.WorkspaceEdit>{
                    documentChanges: fix.changes.map(c => toTextDocumentEdit(c))
                }]
            })
        }
        return result;
    }

    public executeCommand(arg: lsp.ExecuteCommandParams): void {
        this.logger.log('executeCommand', arg);
        if (arg.command === WORKSPACE_EDIT_COMMAND && arg.arguments) {
            const edit = arg.arguments[0] as lsp.WorkspaceEdit;
            this.options.lspClient.applyWorkspaceEdit({
                edit
            });
        } else {
            this.logger.error(`Unknown command ${arg.command}.`)
        }
    }

    public async documentHighlight(arg: lsp.TextDocumentPositionParams): Promise<lsp.DocumentHighlight[]> {
        this.logger.log('documentHighlight', arg);
        let response: tsp.DocumentHighlightsResponse
        const file = uriToPath(arg.textDocument.uri);
        try {
            response = await this.tspClient.request(CommandTypes.DocumentHighlights, <tsp.DocumentHighlightsRequestArgs>{
                file: file,
                line: arg.position.line + 1,
                offset: arg.position.character + 1,
                filesToSearch: [file]
            })
        } catch (err) {
            return [];
        }
        if (!response.body) {
            return []
        }
        const result: lsp.DocumentHighlight[] = [];
        for (const item of response.body) {
            if (item.file === file) {
                const highlights = toDocumentHighlight(item);
                result.push(...highlights)
            }
        }
        return result;
    }

    private rootPath(): string {
        return this.initializeParams.rootUri ? uriToPath(this.initializeParams.rootUri) : this.initializeParams.rootPath!;
    }

    private lastFileOrDummy(): string {
        for (const uri of this.openedDocumentUris.keys()) {
            return uriToPath(uri);
        }
        return this.rootPath();
    }

    public async workspaceSymbol(params: lsp.WorkspaceSymbolParams): Promise<lsp.SymbolInformation[]> {
        const result = await this.tspClient.request(CommandTypes.Navto, {
            file: this.lastFileOrDummy(),
            searchValue: params.query
        });
        if (!result.body) {
            return []
        }
        return result.body.map(item => {
            return <lsp.SymbolInformation>{
                location: {
                    uri: pathToUri(item.file),
                    range: {
                        start: toPosition(item.start),
                        end: toPosition(item.end)
                    }
                },
                kind: toSymbolKind(item.kind),
                name: item.name
            };
        });
    }

    /**
     * implemented based on https://github.com/Microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/folding.ts
     */
    async foldingRanges(params: lsp.FoldingRangeRequestParam): Promise<lsp.FoldingRange[] | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('foldingRanges', params, file);
        const document = this.openedDocumentUris.get(params.textDocument.uri);
        if (!document) {
            throw new Error("The document should be opened for foldingRanges', file: " + file);
        }
        const { body } = await this.tspClient.request(CommandTypes.GetOutliningSpans, { file });
        if (!body) {
            return undefined;
        }
        const foldingRanges: lsp.FoldingRange[] = [];
        for (const span of body) {
            const foldingRange = this.asFoldingRange(span, document);
            if (foldingRange) {
                foldingRanges.push(foldingRange);
            }
        }
        return foldingRanges;
    }
    protected asFoldingRange(span: tsp.OutliningSpan, document: LspDocument): lsp.FoldingRange | undefined {
        const range = this.asRange(span.textSpan);
        const kind = this.asFoldingRangeKind(span);

        // workaround for https://github.com/Microsoft/vscode/issues/49904
        if (span.kind === 'comment') {
            const line = document.getLine(range.start.line);
            if (line.match(/\/\/\s*#endregion/gi)) {
                return undefined;
            }
        }

        const startLine = range.start.line;

        // workaround for https://github.com/Microsoft/vscode/issues/47240
        const endLine = (range.end.character > 0 && document.getText(lsp.Range.create(
            lsp.Position.create(range.end.line, range.end.character - 1),
            range.end
        )) === '}') ? Math.max(range.end.line - 1, range.start.line) : range.end.line;

        return {
            startLine,
            endLine,
            kind
        }
    }
    protected asRange(span: tsp.TextSpan): lsp.Range {
        return lsp.Range.create(
            Math.max(0, span.start.line - 1), Math.max(span.start.offset - 1, 0),
            Math.max(0, span.end.line - 1), Math.max(0, span.end.offset - 1)
        );
    }
    protected asFoldingRangeKind(span: tsp.OutliningSpan): lsp.FoldingRangeKind | undefined {
        switch (span.kind) {
            case 'comment': return lsp.FoldingRangeKind.Comment;
            case 'region': return lsp.FoldingRangeKind.Region;
            case 'imports': return lsp.FoldingRangeKind.Imports;
            case 'code':
            default: return undefined;
        }
    }

    protected onTsEvent(event: protocol.Event): void {
        if (event.event === EventTypes.SementicDiag) {
            this.diagnosticQueue.addSemanticDiagnostic(event);
        } else if (event.event === EventTypes.SyntaxDiag) {
            this.diagnosticQueue.addSyntacticDiagnostic(event);
        } else {
            this.logger.log("Ignored event", {
                "event": event.event
            });
        }
    }
}