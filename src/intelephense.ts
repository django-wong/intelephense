/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ParsedDocument, ParsedDocumentStore, ParsedDocumentChangeEventArgs, LanguageRange } from './parsedDocument';
import { SymbolStore, SymbolTable, SymbolStoreState } from './symbolStore';
import { SymbolProvider } from './symbolProvider';
import { CompletionProvider, CompletionOptions } from './completionProvider';
import { DiagnosticsProvider, PublishDiagnosticsEventArgs } from './diagnosticsProvider';
import { Debounce, Unsubscribe } from './types';
import { SignatureHelpProvider } from './signatureHelpProvider';
import { DefinitionProvider } from './definitionProvider';
import { PhraseType } from 'php7parser';
import { FormatProvider } from './formatProvider';
import * as lsp from 'vscode-languageserver-types';
import { NameTextEditProvider } from './commands';
import { ReferenceReader } from './referenceReader';
import { NameResolver } from './nameResolver';
import { ReferenceProvider } from './referenceProvider';
import { ReferenceStore } from './reference';
import { createCache, Cache } from './cache';
import { Log, LogWriter } from './logger';
import * as path from 'path';

export namespace Intelephense {

    const phpLanguageId = 'php';
    const htmlLanguageId = 'html';

    let documentStore: ParsedDocumentStore;
    let symbolStore: SymbolStore;
    let refStore: ReferenceStore;
    let symbolProvider: SymbolProvider;
    let completionProvider: CompletionProvider;
    let diagnosticsProvider: DiagnosticsProvider;
    let signatureHelpProvider: SignatureHelpProvider;
    let definitionProvider: DefinitionProvider;
    let formatProvider: FormatProvider;
    let nameTextEditProvider: NameTextEditProvider;
    let referenceProvider: ReferenceProvider;
    let cacheClear = false;
    let symbolCache: Cache;
    const symbolsCacheKey = 'symbols';

    let diagnosticsUnsubscribe: Unsubscribe;

    export function onPublishDiagnostics(fn: (args: PublishDiagnosticsEventArgs) => void) {
        if (diagnosticsUnsubscribe) {
            diagnosticsUnsubscribe();
        }

        if (fn) {
            diagnosticsUnsubscribe = diagnosticsProvider.publishDiagnosticsEvent.subscribe(fn);
        }
    }

    export function initialise(options: InitialisationOptions) {

        if (options.logWriter) {
            Log.writer = options.logWriter;
        }
        symbolCache = createCache(path.join(options.storagePath, 'intelephense', 'symbols'));
        documentStore = new ParsedDocumentStore();
        symbolStore = new SymbolStore();
        refStore = new ReferenceStore(createCache(path.join(options.storagePath, 'intelephense', 'references')));
        symbolProvider = new SymbolProvider(symbolStore);
        completionProvider = new CompletionProvider(symbolStore, documentStore, refStore);
        diagnosticsProvider = new DiagnosticsProvider();
        signatureHelpProvider = new SignatureHelpProvider(symbolStore, documentStore, refStore);
        definitionProvider = new DefinitionProvider(symbolStore, documentStore, refStore);
        formatProvider = new FormatProvider(documentStore);
        nameTextEditProvider = new NameTextEditProvider(symbolStore, documentStore, refStore);
        referenceProvider = new ReferenceProvider(documentStore, symbolStore, refStore);

        //keep stores in sync
        documentStore.parsedDocumentChangeEvent.subscribe((args) => {
            symbolStore.onParsedDocumentChange(args);
            let refTable = ReferenceReader.discoverReferences(args.parsedDocument, symbolStore);
            refStore.add(refTable);
        });

        return symbolCache.read(symbolsCacheKey).then((s: SymbolStoreState) => {

            if (s) {
                symbolStore.restoreState(s);
            } else {
                symbolStore.add(SymbolTable.readBuiltInSymbols());
            }

            return Promise.resolve();

        });

    }

    export function shutdown() {

        if (cacheClear) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {

            let refs = false;
            let symbols = false;
            let onResolveOrRejectRefs = () => {
                refs = true;
                if (refs && symbols) {
                    resolve();
                }
            }
            let onResolveOrRejectSymbols = () => {
                symbols = true;
                if (refs && symbols) {
                    resolve();
                }
            }

            refStore.closeAll().then(() => {
                onResolveOrRejectRefs();
            }).catch((msg) => {
                Log.warn(msg);
                onResolveOrRejectRefs();
            });
            symbolCache.write(symbolsCacheKey, symbolStore.state()).then(() => {
                onResolveOrRejectSymbols();
            }).catch((msg) => {
                Log.warn(msg);
                onResolveOrRejectSymbols();
            });

        });

    }

    export function documentLanguageRanges(textDocument: lsp.TextDocumentItem): LanguageRange[] {
        let doc = documentStore.find(textDocument.uri);
        return doc ? doc.documentLanguageRanges() : [];
    }

    export function setConfig(config: IntelephenseConfig) {
        diagnosticsProvider.debounceWait = config.diagnosticsProvider.debounce;
        diagnosticsProvider.maxItems = config.diagnosticsProvider.maxItems;
        completionProvider.config = config.completionProvider;
    }

    export function openDocument(textDocument: lsp.TextDocumentItem) {

        if ((textDocument.languageId !== phpLanguageId && textDocument.languageId !== htmlLanguageId) || documentStore.has(textDocument.uri)) {
            return;
        }

        let parsedDocument = new ParsedDocument(textDocument.uri, textDocument.text);
        documentStore.add(parsedDocument);
        let symbolTable = SymbolTable.create(parsedDocument);
        symbolStore.add(symbolTable);
        let refTable = ReferenceReader.discoverReferences(parsedDocument, symbolStore);
        refStore.add(refTable);
        diagnosticsProvider.add(parsedDocument);

    }

    export function closeDocument(textDocument: lsp.TextDocumentIdentifier) {
        documentStore.remove(textDocument.uri);
        refStore.close(textDocument.uri);
        diagnosticsProvider.remove(textDocument.uri);
        let symbolTable = symbolStore.getSymbolTable(textDocument.uri);
        if (symbolTable) {
            symbolTable.pruneScopedVars();
        }
    }

    export function editDocument(
        textDocument: lsp.VersionedTextDocumentIdentifier,
        contentChanges: lsp.TextDocumentContentChangeEvent[]) {

        let parsedDocument = documentStore.find(textDocument.uri);
        if (parsedDocument) {
            parsedDocument.applyChanges(contentChanges);
        }

    }

    export function documentSymbols(textDocument: lsp.TextDocumentIdentifier) {
        flushParseDebounce(textDocument.uri);
        return symbolProvider.provideDocumentSymbols(textDocument.uri);
    }

    export function workspaceSymbols(query: string) {
        return query ? symbolProvider.provideWorkspaceSymbols(query) : [];
    }

    export function provideCompletions(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return completionProvider.provideCompletions(textDocument.uri, position);
    }

    export function provideSignatureHelp(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return signatureHelpProvider.provideSignatureHelp(textDocument.uri, position);
    }

    export function provideDefinition(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return definitionProvider.provideDefinition(textDocument.uri, position);
    }

    export function discoverSymbols(textDocument: lsp.TextDocumentItem) {

        let uri = textDocument.uri;

        if (documentStore.has(uri)) {
            //if document is in doc store/opened then dont rediscover
            //it will have symbols discovered already
            let symbolTable = symbolStore.getSymbolTable(uri);
            return symbolTable ? symbolTable.symbolCount : 0;
        }

        let text = textDocument.text;
        let parsedDocument = new ParsedDocument(uri, text);
        let symbolTable = SymbolTable.create(parsedDocument, true);
        symbolTable.pruneScopedVars();
        symbolStore.add(symbolTable);
        return symbolTable.symbolCount;

    }

    export function discoverReferences(textDocument: lsp.TextDocumentItem) {
        let uri = textDocument.uri;
        let refTable = refStore.getReferenceTable(uri);

        if (documentStore.has(uri)) {
            //if document is in doc store/opened then dont rediscover.
            //it should have had refs discovered already
            return refTable ? refTable.referenceCount : 0;
        }

        if (!symbolStore.getSymbolTable(uri)) {
            //symbols must be discovered first
            return 0;
        }

        let text = textDocument.text;
        let parsedDocument = new ParsedDocument(uri, text);
        refTable = ReferenceReader.discoverReferences(parsedDocument, symbolStore);
        refStore.add(refTable);
        refStore.close(refTable.uri);
        return refTable.referenceCount;
    }

    export function forget(uri: string) {
        symbolStore.remove(uri);
        refStore.remove(uri, true);
    }

    export function provideContractFqnTextEdits(uri: string, position: lsp.Position, alias?: string) {
        flushParseDebounce(uri);
        return nameTextEditProvider.provideContractFqnTextEdits(uri, position, alias);
    }

    export function numberDocumentsOpen() {
        return documentStore.count;
    }

    export function numberDocumentsKnown() {
        return symbolStore.tableCount;
    }

    export function numberSymbolsKnown() {
        return symbolStore.symbolCount;
    }

    export function provideDocumentFormattingEdits(doc: lsp.TextDocumentIdentifier, formatOptions: lsp.FormattingOptions) {
        flushParseDebounce(doc.uri);
        return formatProvider.provideDocumentFormattingEdits(doc, formatOptions);
    }

    export function provideDocumentRangeFormattingEdits(doc: lsp.TextDocumentIdentifier, range: lsp.Range, formatOptions: lsp.FormattingOptions) {
        flushParseDebounce(doc.uri);
        return formatProvider.provideDocumentRangeFormattingEdits(doc, range, formatOptions);
    }

    export function provideReferences(doc: lsp.TextDocumentIdentifier, pos: lsp.Position, context: lsp.ReferenceContext) {
        flushParseDebounce(doc.uri);
        return referenceProvider.provideReferenceLocations(doc.uri, pos, context);
    }

    function flushParseDebounce(uri: string) {
        let parsedDocument = documentStore.find(uri);
        if (parsedDocument) {
            parsedDocument.flush();
        }
    }

}

export interface IntelephenseConfig {
    debug: {
        enable: boolean;
    },
    diagnosticsProvider: {
        debounce: number,
        maxItems: number
    },
    completionProvider: {
        maxItems: number,
        addUseDeclaration: boolean,
        backslashPrefix: boolean
    },
    file: {
        maxSize: number
    }
}

export interface InitialisationOptions {
    storagePath: string;
    logWriter: LogWriter;
}

