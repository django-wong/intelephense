/* Copyright © Ben Mewburn ben@mewburn.id.au
 * Licensed under the MIT Licence.
 */

'use strict';

export interface Position {
    line: number;
    char: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Predicate<T> {
    (t: T): boolean;
}


export interface TreeVisitor<T> {

    preOrder(t: T): void;
    inOrder(t: T): void;
    postOrder(t: T): void;
    shouldDescend(t: T): boolean;

}

export class TreeNode<T> {

    private _children: TreeNode<T>[];
    private _value: T;

    constructor(value: T) {
        this._value = value;
        this._children = [];
    }

    get value() {
        return this._value;
    }

    get children() {
        return this._children;
    }

    child(n: number) {
        return n < this._children.length ? this._children[n] : null;
    }

    addChild(childValue: T) {
        let node = new TreeNode<T>(childValue);
        this._children.push(node);
        return node;
    }

    addChildren(valueArray: T[]) {
        for (let n = 0; n < valueArray.length; ++n) {
            this.addChild(valueArray[n]);
        }
    }

    removeChild(child: TreeNode<T>) {
        let i = this._children.indexOf(child);
        if (i !== -1) {
            return this._children.splice(i, 1)[0];
        }
        return null;
    }

    /**
     * Pre-order flatten of tree
     */
    toArray() {
        let values: T[] = [];
        let visitor: TreeVisitor<T> = (v, d) => {
            values.push(v);
            return true;
        };

        this.preOrderTraverse(visitor);
        return values;
    }

    toString() {
        return this._value !== undefined && this._value !== null ? this._value.toString() : '';
    }

    traverse(visitor: TreeVisitor<T>) {

        visitor.preOrder(this.value);

        if (this._children.length && visitor.shouldDescend(this.value)) {

            for (let n = 0, l = this._children.length; n < l; ++n) {
                this._children[n].traverse(visitor);
            }

        } else {
            visitor.inOrder(this.value);
        }

        visitor.postOrder(this.value);

    }

}

export class BinarySearch<T> {

    private _sortedArray: T[];

    constructor(sortedArray: T[]) {
        this._sortedArray = sortedArray;
    }

    find(compare: (n: T) => number) {
        let result = this._search(compare);
        return result.isExactMatch ? this._sortedArray[result.rank] : null;
    }

    rank(compare: (n: T) => number) {
        return this._search(compare).rank;
    }

    range(compareLower: (n: T) => number, compareUpper: (T) => number) {
        let rankLower = this.rank(compareLower);
        return this._sortedArray.slice(rankLower, this._search(compareUpper, rankLower + 1).rank);
    }

    private _search(compare: (n: T) => number, left = 0): BinarySearchResult {

        let right = this._sortedArray.length - 1;
        let mid = 0;
        let compareResult = 0;
        let searchResult: BinarySearchResult;

        while (true) {

            if (left > right) {
                searchResult = { rank: left, isExactMatch: false };
                break;
            }

            mid = Math.floor((left + right) / 2);
            compareResult = compare(this._sortedArray[mid]);

            if (compareResult < 0) {
                left = mid + 1;
            } else if (compareResult > 0) {
                right = mid - 1;
            } else {
                searchResult = { rank: mid, isExactMatch: true };
                break;
            }

        }

        return searchResult;

    }

}

interface BinarySearchResult {
    rank: number;
    isExactMatch: boolean
}

interface SuffixDelegate<T> {
    (t: T): string[];
}

export class SuffixArray<T> {

    private _nodeArray: SuffixArrayNode<T>[];
    private _binarySearch: BinarySearch<SuffixArrayNode<T>>;
    private _collator: Intl.Collator;
    private _suffixDelegate: SuffixDelegate<T>;
    private _caseSensitive: boolean;

    constructor(suffixDelegate: SuffixDelegate<T>, caseSensitive = true) {
        this._nodeArray = [];
        this._binarySearch = new BinarySearch<SuffixArrayNode<T>>(this._nodeArray);
        this._collator = new Intl.Collator();
        this._suffixDelegate = suffixDelegate;
        this._caseSensitive = caseSensitive;
    }

    add(item: T) {

        let suffixes = this._suffixDelegate(item);
        let node: SuffixArrayNode<T>;

        for (let n = 0; n < suffixes.length; ++n) {

            node = this._nodeFind(suffixes[n]);

            if (node) {
                node.items.push(item);
            } else {
                this._insertNode({ key: suffixes[n], items: [item] });
            }
        }

    }

    addMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.add(items[n]);
        }
    }

    remove(item: T) {

        let suffixes = this._suffixDelegate(item);
        let node: SuffixArrayNode<T>;
        let i: number;

        for (let n = 0; n < suffixes.length; ++n) {

            node = this._nodeFind(suffixes[n]);
            if (!node) {
                continue;
            }

            i = node.items.indexOf(item);

            if (i !== -1) {
                node.items.splice(i, 1);
                if (!node.items.length) {
                    this._deleteNode(node);
                }
            }

        }

    }

    removeMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.remove(items[n]);
        }
    }

    /**
     * May contain duplicates
     */
    match(text: string) {

        let nodes = this._nodeMatch(text);
        let matches: T[] = [];

        for (let n = 0; n < nodes.length; ++n) {
            Array.prototype.push.apply(matches, nodes[n].items);
        }

        return matches;

    }

    private _nodeMatch(text: string) {

        let collator = this._collator;
        let lcText = this._caseSensitive ? text : text.toLowerCase();

        return this._binarySearch.range(
            (n: SuffixArrayNode<T>) => {
                return collator.compare(lcText, n.key);
            },
            (n: SuffixArrayNode<T>) => {
                return n.key.slice(0, lcText.length) === lcText ? 1 : -1;
            }
        );

    }

    private _nodeFind(text: string) {

        let lcText = this._caseSensitive ? text : text.toLowerCase();
        let collator = this._collator;

        return this._binarySearch.find((n) => {
            return collator.compare(lcText, n.key);
        });

    }

    private _insertNode(node: SuffixArrayNode<T>) {

        let collator = this._collator;
        let rank = this._binarySearch.rank((n) => {
            return collator.compare(node.key, n.key);
        });

        this._nodeArray.splice(rank, 0, node);

    }

    private _deleteNode(node: SuffixArrayNode<T>) {

        let collator = this._collator;
        let rank = this._binarySearch.rank((n) => {
            return collator.compare(node.key, n.key);
        });

        if (this._nodeArray[rank] === node) {
            this._nodeArray.splice(rank, 1);
        }

    }

}

interface SuffixArrayNode<T> {
    key: string;
    items: T[];
}
