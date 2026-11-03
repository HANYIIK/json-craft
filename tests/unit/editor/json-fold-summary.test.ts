import assert from "node:assert/strict";
import test from "node:test";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { json } from "../../../src/renderer/features/editor/json-language";
import { getFoldedArrayCount } from "../../../src/renderer/features/editor/json-fold-summary";

function state(doc: string) {
  const result = EditorState.create({ doc, extensions: [json()] });
  assert.ok(ensureSyntaxTree(result, doc.length, 5_000));
  return result.update({}).state;
}

function rootCount(doc: string) {
  return getFoldedArrayCount(state(doc), { from: 1, to: doc.length - 1 });
}

test("counts only direct array members and treats nested values as one item", () => {
  for (const [doc, expected] of [
    ["[]", 0],
    ["[\n\n]", 0],
    ["[1]", 1],
    ['[0,false,true,null,"text",{},[]]', 7],
    ['[{"rows":[1,2,3]},[[],[4,5]],{"value":true}]', 3],
    ['[9007199254740993,1.2300e+04,-0,{"same":1,"same":2}]', 4],
  ] as const)
    assert.equal(rootCount(doc), expected, doc);
});

test("does not count delimiters in escaped strings or JSON string values", () => {
  const values = [
    ",,,",
    "[1,2,3]",
    '{"a":[1,2],"b":3}',
    'quote: ", bracket: ], slash: \\',
    "中文😀,[]{}",
  ];
  assert.equal(rootCount(JSON.stringify(values)), values.length);
});

test("matches the exact nested array fold range rather than its parent or sibling", () => {
  const doc = '{"rows":[[1,2],{"items":[3,4,5]},[]],"other":[0]}';
  const current = state(doc);
  const arrays: { from: number; to: number; count: number | undefined }[] = [];
  syntaxTree(current).iterate({
    enter(node) {
      if (node.name === "Array")
        arrays.push({
          from: node.from,
          to: node.to,
          count: getFoldedArrayCount(current, {
            from: node.from + 1,
            to: node.to - 1,
          }),
        });
    },
  });
  assert.deepEqual(
    arrays.map((array) => array.count),
    [3, 2, 3, 0, 1],
  );
  assert.equal(
    getFoldedArrayCount(current, { from: 1, to: doc.length - 1 }),
    undefined,
  );
  assert.equal(
    getFoldedArrayCount(current, {
      from: arrays[0].from + 1,
      to: arrays[1].to - 1,
    }),
    undefined,
  );
});

test("keeps malformed, incomplete, and non-array ranges without a fabricated count", () => {
  for (const doc of [
    "[1,]",
    "[,1]",
    "[1,,2]",
    "[1 2]",
    "[invalid]",
    '[{"missing":},2]',
    '["bad\\q"]',
    "[1,2",
    '{"items":[1,2]}',
  ])
    assert.equal(rootCount(doc), undefined, doc);
  const current = state("[1,2]");
  for (const range of [
    { from: -1, to: 4 },
    { from: 0, to: 4 },
    { from: 1, to: 5 },
    { from: 2, to: 4 },
    { from: 1, to: 3 },
    { from: 2, to: 1 },
    { from: NaN, to: 4 },
  ])
    assert.equal(getFoldedArrayCount(current, range), undefined);
});

test("recomputes counts after edits while retaining counts for previous immutable documents", () => {
  const original = state("[1,2]");
  assert.equal(getFoldedArrayCount(original, { from: 1, to: 4 }), 2);
  const updated = original.update({ changes: { from: 4, insert: ",3" } }).state;
  assert.ok(ensureSyntaxTree(updated, updated.doc.length, 5_000));
  assert.equal(getFoldedArrayCount(updated, { from: 1, to: 6 }), 3);
  assert.equal(getFoldedArrayCount(original, { from: 1, to: 4 }), 2);
});

test("uses completed syntax for a large array and giant escaped string without parsing JSON values", () => {
  const doc = JSON.stringify([
    '中文😀\\",[]{}'.repeat(4_000),
    ...Array.from({ length: 10_000 }, (_, index) => ({ id: index })),
  ]);
  let current = EditorState.create({ doc, extensions: [json()] });
  const range = { from: 1, to: doc.length - 1 };
  const initialTree = syntaxTree(current);
  if (initialTree.length < doc.length)
    assert.equal(getFoldedArrayCount(current, range), undefined);
  assert.ok(ensureSyntaxTree(current, doc.length, 5_000));
  current = current.update({}).state;
  assert.equal(getFoldedArrayCount(current, range), 10_001);
  assert.equal(getFoldedArrayCount(current, range), 10_001);
});
