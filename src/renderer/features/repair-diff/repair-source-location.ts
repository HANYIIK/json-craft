import { parseTree, type Node, type ParseError } from "jsonc-parser";
import type { ExtractedValue } from "../../../shared/types";
import type { RepairRecordChange, RepairRecordStage } from "./repair-records";
import {
  validatedRepairChanges,
  type RepairDiffChange,
} from "./repair-diff-model";

export interface RepairSourceSelection {
  from: number;
  to: number;
  line: number;
  column: number;
  exact: boolean;
}

interface Target {
  node: Node;
  complete: boolean;
}

interface SourceIndex {
  text: string;
  root: Node;
  changes?: readonly RepairDiffChange[];
}

function pathSegments(path: string): (string | number)[] | undefined {
  if (!path.startsWith("$")) return undefined;
  const segments: (string | number)[] = [];
  for (let offset = 1; offset < path.length;) {
    if (path[offset] === ".") {
      const match = /^[A-Za-z_$][\w$]*/.exec(path.slice(offset + 1));
      if (!match) return undefined;
      segments.push(match[0]);
      offset += match[0].length + 1;
    } else if (path[offset] === "[") {
      const start = ++offset;
      if (path[offset] === '"') {
        offset++;
        while (offset < path.length && path[offset] !== '"') {
          if (path[offset] === "\\") offset++;
          offset++;
        }
        if (path[offset] !== '"' || path[offset + 1] !== "]") return undefined;
        try {
          segments.push(JSON.parse(path.slice(start, offset + 1)) as string);
        } catch {
          return undefined;
        }
        offset += 2;
      } else {
        const end = path.indexOf("]", offset);
        if (end < 0 || !/^(0|[1-9]\d*)$/.test(path.slice(start, end)))
          return undefined;
        const index = Number(path.slice(start, end));
        if (!Number.isSafeInteger(index)) return undefined;
        segments.push(index);
        offset = end + 1;
      }
    } else return undefined;
  }
  return segments;
}

function documentTree(text: string, requireValid = false): Node | undefined {
  let depth = 0;
  let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (quoted) {
      if (character === "\\") offset++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > 512) return undefined;
    } else if (character === "}" || character === "]") depth--;
  }
  try {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
    return root && (!requireValid || !errors.length) ? root : undefined;
  } catch {
    return undefined;
  }
}

function descendants(
  targets: Target[],
  segments: readonly (string | number)[],
): Target[] {
  for (const segment of segments) {
    const next: Target[] = [];
    for (const target of targets) {
      const { node, complete } = target;
      if (!complete || node.type === "string")
        next.push({ node, complete: false });
      else if (typeof segment === "number" && node.type === "array") {
        const child = node.children?.[segment];
        if (child) next.push({ node: child, complete: true });
      } else if (typeof segment === "string" && node.type === "object") {
        for (const property of node.children ?? []) {
          if (property.children?.[0]?.value === segment && property.children[1])
            next.push({ node: property.children[1], complete: true });
          if (next.length > 1_024) return [];
        }
      }
    }
    if (!next.length || next.length > 1_024) return [];
    targets = next;
  }
  return targets;
}

function originalOffset(
  offset: number,
  changes: readonly RepairDiffChange[],
  end: boolean,
): number {
  let delta = 0;
  for (const change of changes) {
    if (offset < change.fromB) break;
    if (offset <= change.toB) return end ? change.toA : change.fromA;
    delta = change.toB - change.toA;
  }
  return offset - delta;
}

function matchesStage(
  index: SourceIndex,
  node: Node,
  stage: RepairRecordStage,
): boolean {
  let text = index.text.slice(node.offset, node.offset + node.length);
  for (let layer = 0; layer <= 8; layer++) {
    if (text === stage.before) return true;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "string") return false;
      text = value;
    } catch {
      return false;
    }
  }
  return false;
}

export function createRepairSourceLocator(
  raw: string,
  extraction?: Pick<ExtractedValue, "path" | "occurrence">,
  stages: readonly RepairRecordStage[] = [],
) {
  let cachedIndex: SourceIndex | undefined;
  let indexed = false;
  const checkpoints = [{ line: 1, column: 1 }];
  let scanned = 0;
  let line = 1;
  let column = 1;
  const coordinates = (offset: number) => {
    while (scanned < offset) {
      if (raw[scanned++] === "\n") {
        line++;
        column = 1;
      } else column++;
      if (scanned % 4_096 === 0) checkpoints.push({ line, column });
    }
    const block = Math.floor(offset / 4_096);
    let { line: atLine, column: atColumn } = checkpoints[block];
    for (let cursor = block * 4_096; cursor < offset; cursor++) {
      if (raw[cursor] === "\n") {
        atLine++;
        atColumn = 1;
      } else atColumn++;
    }
    return { line: atLine, column: atColumn };
  };
  const selection = (
    from: number,
    to: number,
    exact: boolean,
  ): RepairSourceSelection | undefined => {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to > raw.length
    )
      return undefined;
    return { from, to, ...coordinates(from), exact };
  };
  const sourceIndex = () => {
    if (indexed) return cachedIndex;
    indexed = true;
    for (const stage of stages) {
      if (
        stage.origin !== "source" ||
        stage.layer !== 0 ||
        stage.path ||
        stage.before !== raw
      )
        continue;
      const changes = validatedRepairChanges(stage);
      if (!changes) continue;
      const root = documentTree(stage.after, true);
      if (root) return (cachedIndex = { text: stage.after, root, changes });
    }
    const root = documentTree(raw);
    if (root) cachedIndex = { text: raw, root };
    return cachedIndex;
  };

  return (
    change: RepairRecordChange,
    stage?: RepairRecordStage,
  ): RepairSourceSelection | undefined => {
    if (
      !Number.isInteger(change.start) ||
      !Number.isInteger(change.end) ||
      change.start < 0 ||
      change.end < change.start
    )
      return undefined;
    if (
      stage &&
      (stage.id !== change.stageId ||
        change.start < 0 ||
        change.end < change.start ||
        change.end > stage.before.length ||
        stage.before.slice(change.start, change.end) !== change.before)
    )
      return undefined;
    const path = change.path ?? stage?.path;
    if (change.origin === "source" && change.layer === 0 && !path) {
      if (stage && stage.before !== raw) return undefined;
      if (raw.slice(change.start, change.end) !== change.before)
        return undefined;
      return selection(change.start, change.end, true);
    }
    const index = sourceIndex();
    if (!index) return undefined;
    let targets: Target[] = [{ node: index.root, complete: true }];
    if (change.origin === "extracted") {
      if (!extraction) return undefined;
      const base = pathSegments(extraction.path);
      if (!base) return undefined;
      targets = descendants(targets, base);
      if (targets.length === 1 && !targets[0].complete)
        targets = targets.slice(0, 1);
      else {
        const target = targets[extraction.occurrence - 1];
        targets = target ? [target] : [];
      }
    } else if (!path && index.root.type !== "string") return undefined;
    const relative = pathSegments(path ?? "$");
    if (!relative) return undefined;
    targets = descendants(targets, relative);
    if (targets.length > 1 && stage)
      targets = targets.filter(({ node }) => matchesStage(index, node, stage));
    if (targets.length !== 1) return undefined;
    const target = targets[0];
    const start = target.node.offset;
    const end = start + target.node.length;
    if (
      !index.changes &&
      target.complete &&
      change.layer === 0 &&
      stage?.before === raw.slice(start, end)
    )
      return selection(start + change.start, start + change.end, true);
    return index.changes
      ? selection(
          originalOffset(start, index.changes, false),
          originalOffset(end, index.changes, true),
          false,
        )
      : selection(start, end, false);
  };
}
