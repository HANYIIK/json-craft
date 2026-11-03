import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const counts = new WeakMap<Text, Map<string, number>>();
const values = new Set([
  "Array",
  "Object",
  "String",
  "Number",
  "True",
  "False",
  "Null",
]);

export function getFoldedArrayCount(
  state: EditorState,
  range: { from: number; to: number },
): number | undefined {
  const { from, to } = range;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to < from ||
    to >= state.doc.length ||
    state.doc.sliceString(from - 1, from) !== "[" ||
    state.doc.sliceString(to, to + 1) !== "]"
  )
    return undefined;
  const key = `${from}:${to}`;
  const cached = counts.get(state.doc)?.get(key);
  if (cached !== undefined) return cached;
  const tree = syntaxTree(state);
  if (tree.length < to + 1) return undefined;
  let array: SyntaxNode | null = tree.resolveInner(from, -1);
  while (
    array &&
    (array.name !== "Array" || array.from !== from - 1 || array.to !== to + 1)
  )
    array = array.parent;
  if (!array) return undefined;
  const first = array.firstChild;
  const last = array.lastChild;
  if (
    first?.name !== "[" ||
    first.to !== from ||
    last?.name !== "]" ||
    last.from !== to
  )
    return undefined;
  let valid = true;
  let count = 0;
  let depth = -1;
  array.cursor().iterate(
    (node) => {
      depth++;
      if (node.type.isError) valid = false;
      if (depth === 1 && values.has(node.name)) count++;
    },
    () => depth--,
  );
  if (!valid) return undefined;
  let documentCounts = counts.get(state.doc);
  if (!documentCounts) counts.set(state.doc, (documentCounts = new Map()));
  documentCounts.set(key, count);
  return count;
}
