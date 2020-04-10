import { Parser, Options } from './commonmark/blocks';
import {
  BlockNode,
  isList,
  removeAllNode,
  removeNodeById,
  getNodeById,
  Node,
  SourcePos,
  isRefDef,
  RefDefNode
} from './commonmark/node';
import {
  removeNextUntil,
  getChildNodes,
  insertNodesBefore,
  prependChildNodes,
  updateNextLineNumbers,
  findChildNodeAtLine,
  findFirstNodeAtLine,
  findNodeAtPosition,
  findNodeById,
  invokeNextUntil
} from './nodeHelper';
import { reBulletListMarker, reOrderedListMarker } from './commonmark/blockStarts';
import { iterateObject, omit, isEmptyObj } from './helper';

const reLineEnding = /\r\n|\n|\r/;

export type Position = [number, number];

export type Range = [Position, Position];

type EventName = 'change';

type EventHandlerMap = {
  [key in EventName]: Function[];
};

interface EditResult {
  nodes: BlockNode[];
  removedNodeRange: [number, number] | null;
}

type ParseResult = EditResult & { nextNode: Node | null };
type RefDefState = {
  id: number;
  destination: string;
  title: string;
  deleted: boolean;
  sourcepos: SourcePos;
};

export type RefMap = {
  [k: string]: RefDefState;
};

export type RefLinkCandidateMap = {
  [k: number]: {
    block: BlockNode;
    refLabel: string;
  };
};

export type RefDefCandidateMap = {
  [k: number]: RefDefNode;
};

function canBeContinuedListItem(lineText: string) {
  const spaceMatch = lineText.match(/^[ \t]+/);
  if (spaceMatch && (spaceMatch[0].length >= 2 || /\t/.test(spaceMatch[0]))) {
    return true;
  }

  const leftTrimmed = spaceMatch ? lineText.slice(spaceMatch.length) : lineText;
  return reBulletListMarker.test(leftTrimmed) || reOrderedListMarker.test(leftTrimmed);
}

export function createRefDefState(node: RefDefNode) {
  const { id, title, sourcepos, dest } = node;
  return {
    id,
    title,
    sourcepos: sourcepos!,
    deleted: false,
    destination: dest
  };
}

export class ToastMark {
  public lineTexts: string[];
  private parser: Parser;
  private root: BlockNode;
  private eventHandlerMap: EventHandlerMap;
  private refMap: RefMap;
  private refLinkCandidateMap: RefLinkCandidateMap;
  private refDefCandidateMap: RefDefCandidateMap;

  constructor(contents?: string, options?: Partial<Options>) {
    this.refMap = {};
    this.refLinkCandidateMap = {};
    this.refDefCandidateMap = {};
    this.parser = new Parser(options);
    this.parser.setRefMaps(this.refMap, this.refLinkCandidateMap, this.refDefCandidateMap);
    this.eventHandlerMap = { change: [] };

    contents = contents || '';
    this.lineTexts = contents.split(reLineEnding);
    this.root = this.parser.parse(contents, false);
  }

  private updateLineTexts(startPos: Position, endPos: Position, newText: string) {
    const [startLine, startCol] = startPos;
    const [endLine, endCol] = endPos;
    const newLines = newText.split(reLineEnding);
    const newLineLen = newLines.length;
    const startLineText = this.lineTexts[startLine - 1];
    const endLineText = this.lineTexts[endLine - 1];
    newLines[0] = startLineText.slice(0, startCol - 1) + newLines[0];
    newLines[newLineLen - 1] = newLines[newLineLen - 1] + endLineText.slice(endCol - 1);

    const removedLineLen = endLine - startLine + 1;
    this.lineTexts.splice(startLine - 1, removedLineLen, ...newLines);

    return newLineLen - removedLineLen;
  }

  private updateRootNodeState() {
    if (this.lineTexts.length === 1 && this.lineTexts[0] === '') {
      this.root.lastLineBlank = true;
      this.root.sourcepos = [[1, 1] as Position, [1, 0] as Position];
      return;
    }

    if (this.root.lastChild) {
      this.root.lastLineBlank = (this.root.lastChild as BlockNode).lastLineBlank;
    }

    const { lineTexts } = this;
    let idx = lineTexts.length - 1;
    while (lineTexts[idx] === '') {
      idx -= 1;
    }
    if (lineTexts.length - 2 > idx) {
      idx += 1;
    }

    this.root.sourcepos![1] = [idx + 1, lineTexts[idx].length];
  }

  private replaceRangeNodes(
    startNode: BlockNode | null,
    endNode: BlockNode | null,
    newNodes: BlockNode[]
  ) {
    if (!startNode) {
      if (endNode) {
        insertNodesBefore(endNode, newNodes);
        removeNodeById(endNode.id);
        endNode.unlink();
      } else {
        prependChildNodes(this.root, newNodes);
      }
    } else {
      insertNodesBefore(startNode, newNodes);
      removeNextUntil(startNode, endNode!);
      [startNode.id, endNode!.id].forEach(removeNodeById);
      startNode.unlink();
    }
  }

  private getNodeRange(startPos: Position, endPos: Position) {
    const startNode = findChildNodeAtLine(this.root, startPos[0]);
    let endNode = findChildNodeAtLine(this.root, endPos[0]);

    // extend node range to include a following block which doesn't have preceding blank line
    if (endNode && endNode.next && endPos[0] + 1 === endNode.next.sourcepos![0][0]) {
      endNode = endNode.next;
    }

    return [startNode, endNode] as [BlockNode, BlockNode];
  }

  private trigger(eventName: EventName, param: any) {
    this.eventHandlerMap[eventName].forEach(handler => {
      handler(param);
    });
  }

  private extendEndLine(line: number) {
    while (this.lineTexts[line] === '') {
      line += 1;
    }
    return line;
  }

  private parseRange(
    startNode: BlockNode | null,
    endNode: BlockNode | null,
    startLine: number,
    endLine: number
  ) {
    // extends starting range if the first node can be a continued list item
    if (
      startNode &&
      startNode.prev &&
      isList(startNode.prev) &&
      canBeContinuedListItem(this.lineTexts[startLine - 1])
    ) {
      startNode = startNode.prev;
      startLine = startNode.sourcepos![0][0];
    }

    const editedLines = this.lineTexts.slice(startLine - 1, endLine);
    const root = this.parser.partialParseStart(startLine, editedLines);

    // extends ending range if the following node can be a continued list item
    let nextNode = endNode ? endNode.next : this.root.firstChild;
    while (
      root.lastChild &&
      isList(root.lastChild) &&
      nextNode &&
      (nextNode.type === 'list' || nextNode.sourcepos![0][1] >= 2)
    ) {
      const newEndLine = this.extendEndLine(nextNode.sourcepos![1][0]);
      this.parser.partialParseExtends(this.lineTexts.slice(endLine, newEndLine));

      if (!startNode) {
        startNode = endNode;
      }
      endNode = nextNode as BlockNode;
      endLine = newEndLine;
      nextNode = nextNode.next;
    }

    this.parser.partialParseFinish();

    const newNodes = getChildNodes(root)! as BlockNode[];
    return { newNodes, extStartNode: startNode, extEndNode: endNode };
  }

  private getRemovedNodeRange(
    extStartNode: BlockNode | null,
    extEndNode: BlockNode | null
  ): [number, number] | null {
    return !extStartNode ||
      (extStartNode && isRefDef(extStartNode)) ||
      (extEndNode && isRefDef(extEndNode))
      ? null
      : [extStartNode.id, extEndNode!.id];
  }

  private markDeletedRefMap(extStartNode: BlockNode | null, extEndNode: BlockNode | null) {
    if (isEmptyObj(this.refMap)) {
      return;
    }
    const callback = (node: BlockNode) => {
      if (isRefDef(node)) {
        const refDefState = this.refMap[node.label];
        if (refDefState && node.id === refDefState.id) {
          refDefState.deleted = true;
        }
      }
    };
    if (extStartNode) {
      const walker = extStartNode.parent!.walker();
      walker.resumeAt(extStartNode, true);
      invokeNextUntil(walker, callback, extStartNode, extEndNode);
    }
    if (extEndNode) {
      invokeNextUntil(extEndNode.walker(), callback, extEndNode);
    }
  }

  private assignNewRefDefState(nodes: BlockNode[]) {
    const { refMap } = this;

    if (isEmptyObj(refMap)) {
      return;
    }

    const callback = (node: BlockNode) => {
      if (isRefDef(node)) {
        const { label } = node;
        const refDefState = refMap[label];
        if (!refDefState || refDefState.deleted) {
          refMap[label] = createRefDefState(node);
        }
      }
    };
    nodes.forEach(node => {
      const walker = node.walker();
      walker.resumeAt(node.firstChild!, true);
      invokeNextUntil(walker, callback, node);
    });
  }

  private assignRefDefCandidate() {
    const { refMap, refDefCandidateMap } = this;

    if (isEmptyObj(refDefCandidateMap)) {
      return;
    }

    iterateObject(refDefCandidateMap, (id, candidate) => {
      const node = candidate[id];
      const { label, sourcepos } = node;
      const refDefState = refMap[label];

      if (!refDefState || refDefState.deleted || refDefState.sourcepos[0][0] > sourcepos![0][0]) {
        refMap[label] = createRefDefState(node);
      }
    });
  }

  private parse(startPos: Position, endPos: Position, lineDiff = 0): ParseResult {
    const range = this.getNodeRange(startPos, endPos);
    const startNode = range[0];
    let endNode = range[1];
    const startLine = startNode ? Math.min(startNode.sourcepos![0][0], startPos[0]) : startPos[0];
    let endLine = this.extendEndLine(
      (endNode ? Math.max(endNode.sourcepos![1][0], endPos[0]) : endPos[0]) + lineDiff
    );

    let nextNode = findChildNodeAtLine(this.root, endLine + 1);

    if (nextNode && isRefDef(nextNode) && nextNode !== startNode && nextNode !== endNode) {
      endNode = nextNode;
      endLine = this.extendEndLine(endNode.sourcepos![1][0] + lineDiff);
    }

    const parseResult = this.parseRange(startNode, endNode, startLine, endLine);
    const { newNodes, extStartNode, extEndNode } = parseResult;
    const removedNodeRange = this.getRemovedNodeRange(extStartNode, extEndNode);

    nextNode = extEndNode ? extEndNode.next : this.root.firstChild;

    this.markDeletedRefMap(extStartNode, extEndNode);
    this.replaceRangeNodes(extStartNode, extEndNode, newNodes);
    this.assignNewRefDefState(newNodes);

    return { nodes: newNodes, removedNodeRange, nextNode };
  }

  private parseRefLink() {
    const { refMap, refLinkCandidateMap } = this;

    if (isEmptyObj(refMap)) {
      return null;
    }

    const result: EditResult[] = [];

    iterateObject(refMap, (label, obj) => {
      const { id, deleted } = obj[label];
      const unlinked = deleted || !getNodeById(id);

      if (unlinked) {
        delete refMap[label];
      }
      iterateObject(refLinkCandidateMap, (id, candidate) => {
        const { block, refLabel } = candidate[id];
        if (refLabel === label) {
          result.push(this.parse(block.sourcepos![0], block.sourcepos![1]));
        }
      });
    });

    return result;
  }

  private removeUnlinkedCandidate() {
    [this.refLinkCandidateMap, this.refDefCandidateMap].forEach(candidateMap => {
      iterateObject(candidateMap, (id, obj) => {
        if (!getNodeById(id)) {
          delete obj[id];
        }
      });
    });
  }

  public editMarkdown(startPos: Position, endPos: Position, newText: string) {
    const lineDiff = this.updateLineTexts(startPos, endPos, newText);
    const parseResult = this.parse(startPos, endPos, lineDiff);
    const editResult = omit(parseResult, 'nextNode');

    updateNextLineNumbers(parseResult.nextNode, lineDiff);
    this.updateRootNodeState();
    this.removeUnlinkedCandidate();
    this.assignRefDefCandidate();

    let result: EditResult[] = [editResult];

    const refLink = this.parseRefLink();
    result = refLink ? result.concat(refLink) : result;

    this.trigger('change', result);

    return result;
  }

  public getLineTexts() {
    return this.lineTexts;
  }

  public getRootNode() {
    return this.root;
  }

  public findNodeAtPosition(pos: Position) {
    const node = findNodeAtPosition(this.root, pos);
    if (!node || node === this.root) {
      return null;
    }
    return node;
  }

  public findFirstNodeAtLine(line: number) {
    return findFirstNodeAtLine(this.root, line);
  }

  public on(eventName: EventName, callback: Function) {
    this.eventHandlerMap[eventName].push(callback);
  }

  public off(eventName: EventName, callback: Function) {
    const handlers = this.eventHandlerMap[eventName];
    const idx = handlers.indexOf(callback);
    handlers.splice(idx, 1);
  }

  public findNodeById(id: number) {
    return findNodeById(id);
  }

  public removeAllNode() {
    removeAllNode();
  }
}
