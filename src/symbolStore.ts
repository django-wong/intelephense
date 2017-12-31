/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { PhpSymbol, SymbolKind, SymbolModifier, SymbolIdentifier } from './symbol';
import { Reference } from './reference';
import {
    TreeTraverser, Predicate, TreeVisitor, Traversable, BinarySearch, NameIndex, HashedLocation, FindByStartPositionTraverser,
    NameIndexNode
} from './types';
import { Position, Location, Range } from 'vscode-languageserver-types';
import { TypeString } from './typeString';
import * as builtInSymbols from './builtInSymbols.json';
import { ParsedDocument, ParsedDocumentChangeEventArgs } from './parsedDocument';
import { SymbolReader } from './symbolReader';
import { NameResolver } from './nameResolver';
import * as util from './util';
import { TypeAggregate, MemberMergeStrategy } from './typeAggregate';
import { ReferenceReader } from './referenceReader';
import * as uriMap from './uriMap';

const builtInsymbolsUri = 'php';

export class SymbolTable implements Traversable<PhpSymbol> {

    private _uri: string;
    private _root: PhpSymbol;

    constructor(uri: string, root: PhpSymbol) {
        this._uri = uri;
        this._root = root;
    }

    get uri() {
        return this._uri;
    }

    get root() {
        return this._root;
    }

    get symbols() {
        let traverser = new TreeTraverser([this.root]);
        let symbols = traverser.toArray();
        //remove root
        symbols.shift();
        return symbols;
    }

    get symbolCount() {
        let traverser = new TreeTraverser([this.root]);
        //subtract 1 for root
        return traverser.count() - 1;
    }

    pruneScopedVars() {
        let visitor = new ScopedVariablePruneVisitor();
        this.traverse(visitor);
    }

    parent(s: PhpSymbol) {
        let traverser = new TreeTraverser([this.root]);
        let fn = (x: PhpSymbol) => {
            return x === s;
        };
        if (!traverser.find(fn)) {
            return null;
        }

        return traverser.parent();
    }

    traverse<T extends TreeVisitor<PhpSymbol>>(visitor: T) {
        let traverser = new TreeTraverser([this.root]);
        traverser.traverse(visitor);
        return visitor;
    }

    createTraverser() {
        return new TreeTraverser([this.root]);
    }

    filter(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.filter(predicate)
    }

    find(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.find(predicate);
    }

    nameResolver(pos: Position) {
        let nameResolver = new NameResolver();
        let traverser = new TreeTraverser([this.root]);
        let visitor = new NameResolverVisitor(pos, nameResolver);
        traverser.traverse(visitor);
        return nameResolver;
    }

    scope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, false);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    absoluteScope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, true);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    scopeSymbols() {
        return this.filter(this._isScopeSymbol);
    }

    symbolAtPosition(position: Position) {

        let pred = (x: PhpSymbol) => {
            return x.location && util.positionEquality(x.location.range.start, position);
        };

        return this.filter(pred).pop();
    }

    contains(s: PhpSymbol) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ContainsVisitor(s);
        traverser.traverse(visitor);
        return visitor.found;
    }

    private _isScopeSymbol(s: PhpSymbol) {
        const mask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.None | SymbolKind.Function | SymbolKind.Method;
        return (s.kind & mask) > 0;
    }

    static fromData(data: any) {
        return new SymbolTable(data._uri, data._root);
    }

    static create(parsedDocument: ParsedDocument, externalOnly?: boolean) {

        let symbolReader = new SymbolReader(parsedDocument, new NameResolver());

        parsedDocument.traverse(symbolReader);
        return new SymbolTable(
            parsedDocument.uri,
            symbolReader.symbol
        );

    }

    static readBuiltInSymbols() {

        return new SymbolTable(builtInsymbolsUri, {
            kind: SymbolKind.None,
            name: '',
            location: HashedLocation.create(0, Range.create(0, 0, 1000000, 1000000)),
            children: <any>builtInSymbols
        });

    }

}

class ScopedVariablePruneVisitor implements TreeVisitor<PhpSymbol> {

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if ((node.kind === SymbolKind.Function || node.kind === SymbolKind.Method) && node.children) {
            node.children = node.children.filter(this._isNotVar);
        }

        return true;
    }

    private _isNotVar(s: PhpSymbol) {
        return s.kind !== SymbolKind.Variable;
    }


}

export interface HashedStartLocation {
    uriHash: number;
    start: Position;
}

export class SymbolStore {

    private _tableIndex: { [id: number]: SymbolTable };
    private _symbolIndex: NameIndex<HashedStartLocation>;
    private _symbolCount: number;

    constructor() {
        this._tableIndex = {};
        this._symbolIndex = new NameIndex<HashedStartLocation>();
        this._symbolCount = 0;
    }

    onParsedDocumentChange = (args: ParsedDocumentChangeEventArgs) => {
        this.remove(args.parsedDocument.uri);
        let table = SymbolTable.create(args.parsedDocument);
        this.add(table);
    };

    getSymbolTable(uri: string) {
        return this._tableIndex[uriMap.id(uri)];
    }

    get tableCount() {
        return Object.keys(this._tableIndex).length;
    }

    get symbolCount() {
        return this._symbolCount;
    }

    add(symbolTable: SymbolTable) {
        //if table already exists replace it
        this.remove(symbolTable.uri);
        let id = uriMap.id(symbolTable.uri);
        this._tableIndex[id] = symbolTable;
        let indexItems = symbolTable.traverse(new IndexableSymbolVisitor(id)).items;
        for (let n = 0; n < indexItems.length; ++n) {
            this._symbolIndex.add(indexItems[n].start, indexItems[n].keys);
        }
        this._symbolCount += symbolTable.symbolCount;
    }

    remove(uri: string) {
        let id = uriMap.id(uri);
        let symbolTable = this._tableIndex[id];
        if (!symbolTable) {
            return;
        }
        delete this._tableIndex[id];
        let indexItems = symbolTable.traverse(new IndexableSymbolVisitor(id)).items;
        for (let n = 0; n < indexItems.length; ++n) {
            this._symbolIndex.remove(indexItems[n].start, indexItems[n].keys);
        }
        this._symbolCount -= symbolTable.symbolCount;
    }

    toJSON() {
        return {
            _tableIndex: this._tableIndex,
            _symbolCount: this._symbolCount,
            _symbolIndex: this._symbolIndex.toJSON()
        }
    }

    restore(data: any) {
        this._symbolCount = data._symbolCount;
        this._tableIndex = {};
        let tableKeys = Object.keys(data._tableIndex);
        let table: SymbolTable;
        for (let n = 0, l = tableKeys.length; n < l; ++n) {
            this._tableIndex[tableKeys[n]] = SymbolTable.fromData(data._tableIndex[tableKeys[n]]);
        }
        this._symbolIndex.restore(data._symbolIndex);
    }

    /**
     * Finds all indexed symbols that match text exactly.
     * Case sensitive for constants and variables and insensitive for 
     * classes, traits, interfaces, functions, methods
     * @param text 
     * @param filter 
     */
    find(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let lcText = text.toLowerCase();
        let kindMask = SymbolKind.Constant | SymbolKind.Variable;
        let result = this._indexResultToSymbols(this._symbolIndex.find(text));
        let symbols: PhpSymbol[] = [];
        let s: PhpSymbol;

        for (let n = 0, l = result.length; n < l; ++n) {
            s = result[n];
            if ((!filter || filter(s)) &&
                (((s.kind & kindMask) > 0 && s.name === text) ||
                    (!(s.kind & kindMask) && s.name.toLowerCase() === lcText))) {
                symbols.push(s);
            }
        }

        return symbols;
    }

    /**
     * matches indexed symbols where symbol keys begin with text.
     * Case insensitive
     */
    match(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let matches: PhpSymbol[] = this._indexResultToSymbols(this._symbolIndex.match(text));

        if (!filter) {
            return matches;
        }

        let filtered: PhpSymbol[] = [];
        let s: PhpSymbol;

        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            if (filter(s)) {
                filtered.push(s);
            }
        }

        return filtered;
    }

    findSymbolsByReference(ref: Reference, memberMergeStrategy?: MemberMergeStrategy): PhpSymbol[] {
        if (!ref) {
            return [];
        }

        let symbols: PhpSymbol[];
        let fn: Predicate<PhpSymbol>;
        let lcName: string;
        let table: SymbolTable;

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
                fn = (x) => {
                    return (x.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
                };
                symbols = this.find(ref.name, fn);
                break;

            case SymbolKind.Function:
            case SymbolKind.Constant:
                fn = (x) => {
                    return x.kind === ref.kind;
                };
                symbols = this.find(ref.name, fn);
                if (symbols.length < 1 && ref.altName) {
                    symbols = this.find(ref.altName, fn);
                }
                break;

            case SymbolKind.Method:
                lcName = ref.name.toLowerCase();
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name.toLowerCase() === lcName;
                };
                symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Property:
                {
                    let name = ref.name;
                    fn = (x) => {
                        return x.kind === SymbolKind.Property && name === x.name;
                    };
                    symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                    break;
                }

            case SymbolKind.ClassConstant:
                fn = (x) => {
                    return x.kind === SymbolKind.ClassConstant && x.name === ref.name;
                };
                symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Variable:
            case SymbolKind.Parameter:
                //@todo global vars?
                table = this._tableIndex[ref.location.uriHash];
                if (table) {
                    let scope = table.scope(ref.location.range.start);

                    fn = (x) => {
                        return (x.kind & (SymbolKind.Parameter | SymbolKind.Variable)) > 0 &&
                            x.name === ref.name;
                    }
                    let s = scope.children ? scope.children.find(fn) : null;
                    if (s) {
                        symbols = [s];
                    }
                }
                break;

            case SymbolKind.Constructor:
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name.toLowerCase() === '__construct';
                };
                symbols = this.findMembers(ref.name, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            default:
                break;

        }

        return symbols || [];
    }

    findMembers(scope: string, memberMergeStrategy: MemberMergeStrategy, predicate?: Predicate<PhpSymbol>) {

        let fqnArray = TypeString.atomicClassArray(scope);
        let type: TypeAggregate;
        let members: PhpSymbol[] = [];
        for (let n = 0; n < fqnArray.length; ++n) {
            type = TypeAggregate.create(this, fqnArray[n]);
            if (type) {
                Array.prototype.push.apply(members, type.members(memberMergeStrategy, predicate));
            }
        }
        return Array.from(new Set<PhpSymbol>(members));
    }

    findBaseMember(symbol: PhpSymbol) {

        if (
            !symbol || !symbol.scope ||
            !(symbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (symbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return symbol;
        }

        let fn: Predicate<PhpSymbol>;

        if (symbol.kind === SymbolKind.Method) {
            let name = symbol.name.toLowerCase();
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && name === s.name.toLowerCase();
            };
        } else {
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && symbol.name === s.name;
            };
        }

        return this.findMembers(symbol.scope, MemberMergeStrategy.Base, fn).shift() || symbol;

    }

    /*
    findOverrides(baseSymbol: PhpSymbol): PhpSymbol[] {

        if (
            !baseSymbol ||
            !(baseSymbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (baseSymbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return [];
        }

        let baseTypeName = baseSymbol.scope ? baseSymbol.scope : '';
        let baseType = this.find(baseTypeName, PhpSymbol.isClassLike).shift();
        if (!baseType || baseType.kind === SymbolKind.Trait) {
            return [];
        }
        let store = this;
        let filterFn = (s: PhpSymbol) => {

            if (s.kind !== baseSymbol.kind || s.modifiers !== baseSymbol.modifiers || s === baseSymbol) {
                return false;
            }

            let type = store.find(s.scope).shift();
            if (!type) {
                return false;
            }

            if (PhpSymbol.isAssociated(type, baseTypeName)) {
                return true;
            }

            let aggregate = new TypeAggregate(store, type);
            return aggregate.isAssociated(baseTypeName);

        };
        return this.find(baseSymbol.name, filterFn);

    }
    */

    symbolLocation(symbol: PhpSymbol): Location {
        let table = this._tableIndex[symbol.location.uriHash];
        return table ? Location.create(table.uri, symbol.location.range) : undefined;
    }

    referenceToTypeString(ref: Reference) {

        if (!ref) {
            return '';
        }

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
            case SymbolKind.Constructor:
                return ref.name;

            case SymbolKind.Function:
            case SymbolKind.Method:
            case SymbolKind.Property:
                return this.findSymbolsByReference(ref, MemberMergeStrategy.Documented).reduce<string>((carry, val) => {
                    return TypeString.merge(carry, PhpSymbol.type(val));
                }, '');

            case SymbolKind.Variable:
                return ref.type || '';

            default:
                return '';


        }
    }

    private _indexResultToSymbols(results: HashedStartLocation[]) {

        let table: SymbolTable;
        let finder = new FindByStartPositionTraverser();
        let symbols = new Set<PhpSymbol>();
        let s: PhpSymbol;
        let item: HashedStartLocation;

        for (let n = 0, l = results.length; n < l; ++n) {
            item = results[n];
            table = this._tableIndex[item.uriHash];
            if ((s = <PhpSymbol>finder.find(item.start, table.root))) {
                symbols.add(s);
            }
        }

        return Array.from(symbols);

    }

    private _sortMatches(query: string, matches: PhpSymbol[]) {

        let map: { [index: string]: number } = {};
        let s: PhpSymbol;
        let name: string;
        let val: number;
        query = query.toLowerCase();

        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            name = s.name;
            if (map[name] === undefined) {
                val = (PhpSymbol.notFqn(s.name).toLowerCase().indexOf(query) + 1) * 10;
                if (val > 0) {
                    val = 1000 - val;
                }
                map[name] = val;
            }
            ++map[name];
        }

        let unique = Array.from(new Set(matches));

        let sortFn = (a: PhpSymbol, b: PhpSymbol) => {
            return map[b.name] - map[a.name];
        }

        unique.sort(sortFn);
        return unique;

    }

    private _classOrInterfaceFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface)) > 0;
    }

    private _classInterfaceTraitFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
    }

    private _indexSymbols(root: PhpSymbol) {

        let traverser = new TreeTraverser([root]);
        return traverser.filter(this._indexFilter);

    }

    /**
     * No vars, params or symbols with use modifier
     * @param s 
     */
    private _indexFilter(s: PhpSymbol) {
        return !(s.kind & (SymbolKind.Parameter | SymbolKind.File)) && //no params or files
            !(s.modifiers & SymbolModifier.Use) && //no use
            !(s.kind === SymbolKind.Variable && s.location) && //no variables that have a location (in built globals have no loc)
            s.name.length > 0;
    }

    private _symbolKeys(s: PhpSymbol) {

        if (s.kind === SymbolKind.Namespace) {
            let lcName = s.name.toLowerCase();
            let keys = new Set<string>();
            keys.add(lcName);
            Set.prototype.add.apply(keys, lcName.split('\\').filter((s) => { return s.length > 0 }));
            return Array.from(keys);
        }

        return PhpSymbol.keys(s);
    }

}

class NameResolverVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _kindMask = SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant;

    constructor(public pos: Position, public nameResolver: NameResolver) { }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if ((node.modifiers & SymbolModifier.Use) > 0 && (node.kind & this._kindMask) > 0) {
            this.nameResolver.rules.push(node);
        } else if (node.kind === SymbolKind.Namespace) {
            this.nameResolver.namespace = node;
        } else if (node.kind === SymbolKind.Class) {
            this.nameResolver.pushClass(node);
        }

        return true;

    }

    postorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (this.haltTraverse || (node.location && node.location.range.end.line > this.pos.line)) {
            this.haltTraverse = true;
            return;
        }

        if (node.kind === SymbolKind.Class) {
            this.nameResolver.popClass();
        }

    }
}

class ScopeVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _scopeStack: PhpSymbol[];
    private _kindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Function | SymbolKind.Method | SymbolKind.File;
    private _absolute = false;

    constructor(public pos: Position, absolute: boolean) {
        this._scopeStack = [];
        this._absolute = absolute;
    }

    get scope() {
        return this._scopeStack[this._scopeStack.length - 1];
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if (!node.location || util.isInRange(this.pos, node.location.range) !== 0) {
            return false;
        }

        if (
            (node.kind & this._kindMask) > 0 &&
            !(node.modifiers & SymbolModifier.Use) &&
            (!this._absolute || node.kind !== SymbolKind.Function || !(node.modifiers & SymbolModifier.Anonymous))
        ) {
            this._scopeStack.push(node);
        }

        return true;
    }

}

class ContainsVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    found = false;
    private _symbol: PhpSymbol;

    constructor(symbol: PhpSymbol) {
        this._symbol = symbol;
        if (!symbol.location) {
            throw new Error('Invalid Argument');
        }
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node === this._symbol) {
            this.found = true;
            this.haltTraverse = true;
            return false;
        }

        if (node.location && util.isInRange(this._symbol.location.range.start, node.location.range) !== 0) {
            return false;
        }

        return true;

    }

}

interface KeyedHashedStartLocation {
    keys: string[];
    start: HashedStartLocation;
}

namespace KeyedHashedStartLocation {

    function keys(s: PhpSymbol) {
        if (s.kind === SymbolKind.Namespace) {
            let lcName = s.name.toLowerCase();
            let keys = new Set<string>();
            keys.add(lcName);
            Set.prototype.add.apply(keys, lcName.split('\\').filter((s) => { return s.length > 0 }));
            return Array.from(keys);
        }

        return PhpSymbol.keys(s);
    }

    export function create(s: PhpSymbol) {
        return <KeyedHashedStartLocation>{
            keys: keys(s),
            start: {
                uriHash: s.location.uriHash,
                start: s.location.range.start
            }
        }
    }
}

class IndexableSymbolVisitor implements TreeVisitor<PhpSymbol> {

    private _items: KeyedHashedStartLocation[];

    constructor(private uriId: number) {
        this._items = [];
    }

    get items() {
        return this._items;
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {
        if (
            !(node.kind & (SymbolKind.Parameter | SymbolKind.File | SymbolKind.Variable)) && //no params or files
            !(node.modifiers & SymbolModifier.Use) && //no use
            node.name.length > 0
        ) {
            this._items.push(KeyedHashedStartLocation.create(node));
        }
        return true;
    }

}

/*
export class SymbolTableIndex {

    private _tables: SymbolTableIndexNode[];
    private _search: BinarySearch<SymbolTableIndexNode>;
    private _count = 0;

    constructor() {
        this._tables = [];
        this._search = new BinarySearch<SymbolTableIndexNode>(this._tables);
    }

    count() {
        return this._count;
    }

    *tables() {
        let node: SymbolTableIndexNode;
        for (let n = 0, nl = this._tables.length; n < nl; ++n) {
            node = this._tables[n];
            for (let k = 0, tl = node.tables.length; k < tl; ++k) {
                yield node.tables[k];
            }
        }
    }

    add(table: SymbolTable) {
        let fn = this._createCompareFn(table.uri);
        let search = this._search.search(fn);
        if (search.isExactMatch) {
            let node = this._tables[search.rank];
            if (node.tables.find(this._createUriFindFn(table.uri))) {
                --this._count;
                throw new Error(`Duplicate key ${table.uri}`);
            }
            node.tables.push(table);
        } else {
            let node = <SymbolTableIndexNode>{ hash: table.hash, tables: [table] };
            this._tables.splice(search.rank, 0, node);
        }
        ++this._count;
    }

    remove(uri: string) {
        let fn = this._createCompareFn(uri);
        let node = this._search.find(fn);
        if (node) {
            let i = node.tables.findIndex(this._createUriFindFn(uri));
            if (i > -1) {
                --this._count;
                return node.tables.splice(i, 1).pop();
            }
        }
    }

    find(uri: string) {
        let fn = this._createCompareFn(uri);
        let node = this._search.find(fn);
        return node ? node.tables.find(this._createUriFindFn(uri)) : null;
    }

    findBySymbol(s: PhpSymbol) {
        if (!s.location) {
            return undefined;
        }

        let node = this._search.find((x) => {
            return x.hash - s.location.uriHash;
        });

        if (!node || !node.tables.length) {
            return undefined;
        } else if (node.tables.length === 1) {
            return node.tables[0];
        } else {
            let table: SymbolTable;
            for (let n = 0; n < node.tables.length; ++n) {
                table = node.tables[n];
                if (table.contains(s)) {
                    return table;
                }
            }
        }

        return undefined;
    }

    toJSON() {
        return {
            _tables: this._tables,
            _count: this._count
        }
    }

    fromJSON(data: any) {
        this._count = data._count;
        this._tables = [];
        let node: any;
        let newNode: SymbolTableIndexNode;
        for (let n = 0; n < data._tables.length; ++n) {
            node = data._tables[n];
            newNode = {
                hash: node.hash,
                tables: []
            }
            for (let k = 0; k < node.tables.length; ++k) {
                newNode.tables.push(SymbolTable.fromJSON(node.tables[k]));
            }
            this._tables.push(newNode);
        }
        this._search = new BinarySearch<SymbolTableIndexNode>(this._tables);
    }

    private _createCompareFn(uri: string) {
        let hash = Math.abs(util.hash32(uri));
        return (x: SymbolTableIndexNode) => {
            return x.hash - hash;
        };
    }

    private _createUriFindFn(uri: string) {
        return (x: SymbolTable) => {
            return x.uri === uri;
        };
    }

}

export interface SymbolTableIndexNode {
    hash: number;
    tables: SymbolTable[];
}
*/