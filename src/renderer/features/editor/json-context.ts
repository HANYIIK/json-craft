import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { NodeWeakMap, type SyntaxNode } from "@lezer/common";

export interface JsonAncestor {
  label: string;
  path: string;
  from: number;
  to: number;
}

interface ArrayCheckpoint {
  node: SyntaxNode;
  index: number;
}

interface ArrayIndexCache {
  from: number;
  checkpoints: ArrayCheckpoint[];
}

const arrayCheckpoints = new NodeWeakMap<ArrayIndexCache>();
const valueNames = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "True",
  "False",
  "Null",
]);

function isContainer(node: SyntaxNode) {
  return node.name === "Object" || node.name === "Array";
}

function arrayIndex(array: SyntaxNode, value: SyntaxNode): number | null {
  let cache = arrayCheckpoints.get(array);
  if (!cache || cache.from !== array.from) {
    cache = { from: array.from, checkpoints: [] };
    arrayCheckpoints.set(array, cache);
  }
  const { checkpoints } = cache;
  let low = 0;
  let high = checkpoints.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (checkpoints[middle].node.from <= value.from) low = middle + 1;
    else high = middle;
  }
  const checkpoint = checkpoints[low - 1];
  let node: SyntaxNode | null = checkpoint?.node ?? array.firstChild;
  let index = checkpoint?.index ?? 0;
  while (node && node.from <= value.from) {
    if (valueNames.has(node.name)) {
      if (
        index % 256 === 0 &&
        (!checkpoints.length ||
          node.from > checkpoints[checkpoints.length - 1].node.from)
      )
        checkpoints.push({ node, index });
      if (node.from === value.from && node.to === value.to) return index;
      index++;
    }
    node = node.nextSibling;
  }
  return null;
}

function containerSegment(
  state: EditorState,
  node: SyntaxNode,
): { label: string; suffix: string; from: number; to: number } | null {
  const parent = node.parent;
  if (parent?.name === "Property" && parent.parent?.name === "Object") {
    const name = parent.getChild("PropertyName");
    if (!name) return null;
    try {
      const label: unknown = JSON.parse(
        state.doc.sliceString(name.from, name.to),
      );
      if (typeof label !== "string") return null;
      return {
        label,
        suffix: /^[A-Za-z_$][\w$]*$/.test(label)
          ? `.${label}`
          : `[${JSON.stringify(label)}]`,
        from: name.from,
        to: name.to,
      };
    } catch {
      return null;
    }
  }
  if (parent?.name === "Array") {
    const index = arrayIndex(parent, node);
    if (index === null) return null;
    const label = `[${index}]`;
    return {
      label,
      suffix: label,
      from: node.from,
      to: Math.min(node.to, node.from + 1),
    };
  }
  return null;
}

export function getJsonAncestors(
  state: EditorState,
  position: number,
): JsonAncestor[] {
  const ancestors: JsonAncestor[] = [{ label: "$", path: "$", from: 0, to: 0 }];
  const pos = Math.max(
    0,
    Math.min(
      state.doc.length,
      Number.isNaN(position) ? 0 : Math.trunc(position),
    ),
  );
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 1), 6);
  if (!tree) return ancestors;
  let node = tree.resolveInner(pos, 1);
  if (pos === state.doc.length) node = node.enterUnfinishedNodesBefore(pos);
  const containers: SyntaxNode[] = [];
  for (let current: SyntaxNode | null = node; current; current = current.parent)
    if (isContainer(current)) containers.push(current);
  containers.reverse();
  for (const container of containers) {
    if (container.parent?.name === "JsonText") continue;
    const segment = containerSegment(state, container);
    if (!segment) break;
    const path = ancestors[ancestors.length - 1].path + segment.suffix;
    ancestors.push({
      label: segment.label,
      path,
      from: segment.from,
      to: segment.to,
    });
  }
  return ancestors;
}
