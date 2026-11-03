import assert from "node:assert/strict";
import test from "node:test";
import { json } from "@codemirror/lang-json";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { getJsonAncestors } from "../../../src/renderer/features/editor/json-context";

function state(doc: string) {
  const result = EditorState.create({ doc, extensions: [json()] });
  assert.ok(ensureSyntaxTree(result, doc.length, 1000));
  return result;
}

function paths(doc: string, position: number) {
  return getJsonAncestors(state(doc), position).map(
    (ancestor) => ancestor.path,
  );
}

test("returns only container ancestors and uses key ranges for navigation", () => {
  const doc = '{"outer":{"inner":{"leaf":1},"plain":2}}';
  const ancestors = getJsonAncestors(state(doc), doc.indexOf("leaf"));
  assert.deepEqual(
    ancestors.map((ancestor) => ancestor.path),
    ["$", "$.outer", "$.outer.inner"],
  );
  assert.deepEqual(ancestors[0], { label: "$", path: "$", from: 0, to: 0 });
  assert.equal(doc.slice(ancestors[1].from, ancestors[1].to), '"outer"');
  assert.equal(doc.slice(ancestors[2].from, ancestors[2].to), '"inner"');
  assert.deepEqual(paths(doc, doc.indexOf("plain")), ["$", "$.outer"]);
  assert.deepEqual(paths(doc, doc.indexOf("inner")), ["$", "$.outer"]);
});

test("includes named arrays and container elements while skipping primitive leaves", () => {
  const doc = '{"items":[0,false,null,"text",{"data":[[1,{"leaf":2}]]}]}';
  const ancestors = getJsonAncestors(state(doc), doc.indexOf("leaf"));
  assert.deepEqual(
    ancestors.map((ancestor) => ancestor.path),
    [
      "$",
      "$.items",
      "$.items[4]",
      "$.items[4].data",
      "$.items[4].data[0]",
      "$.items[4].data[0][1]",
    ],
  );
  assert.deepEqual(
    ancestors.map((ancestor) => ancestor.label),
    ["$", "items", "[4]", "data", "[0]", "[1]"],
  );
  assert.equal(doc.slice(ancestors[2].from, ancestors[2].to), "{");
  assert.equal(doc.slice(ancestors[4].from, ancestors[4].to), "[");
  assert.deepEqual(paths(doc, doc.indexOf("false")), ["$", "$.items"]);
});

test("handles root arrays and repeated arrays without confusing indices", () => {
  const doc = '[[0],{"rows":[{"x":1},{"x":2}]}]';
  assert.deepEqual(paths(doc, doc.lastIndexOf('"x"')), [
    "$",
    "$[1]",
    "$[1].rows",
    "$[1].rows[1]",
  ]);
  assert.deepEqual(paths(doc, doc.indexOf("0")), ["$", "$[0]"]);
});

test("decodes escaped keys and uses valid bracket notation for special names", () => {
  const key = 'a.b[0]"\\\n';
  const doc = JSON.stringify({
    [key]: { "": { 中文: { $value: { leaf: 1 } } } },
  });
  const ancestors = getJsonAncestors(state(doc), doc.indexOf("leaf"));
  assert.deepEqual(
    ancestors.map((ancestor) => ancestor.label),
    ["$", key, "", "中文", "$value"],
  );
  assert.equal(ancestors[1].path, `$[${JSON.stringify(key)}]`);
  assert.equal(
    ancestors.at(-1)?.path,
    `$[${JSON.stringify(key)}][""]["中文"].$value`,
  );
  const escaped = String.raw`{"\u0061":{"leaf":1}}`;
  assert.deepEqual(paths(escaped, escaped.indexOf("leaf")), ["$", "$.a"]);
});

test("distinguishes duplicate ancestor keys with unique source offsets", () => {
  const doc = '{"same":{"x":1},"same":{"x":2}}';
  const first = getJsonAncestors(state(doc), doc.indexOf('"x"'));
  const second = getJsonAncestors(state(doc), doc.lastIndexOf('"x"'));
  assert.equal(first[1].path, second[1].path);
  assert.notEqual(first[1].from, second[1].from);
  assert.equal(doc.slice(second[1].from, second[1].to), '"same"');
});

test("resolves whitespace, commas, and closing brackets to their actual containers", () => {
  const doc =
    '{\n  "a": {\n    "x": 1\n  },\n  "b": [\n    {"y": 2},\n    3\n  ]\n}';
  assert.deepEqual(paths(doc, doc.indexOf('    "x"')), ["$", "$.a"]);
  const firstClose = doc.indexOf("}");
  assert.deepEqual(paths(doc, firstClose), ["$", "$.a"]);
  assert.deepEqual(paths(doc, firstClose + 1), ["$"]);
  assert.deepEqual(paths(doc, firstClose + 2), ["$"]);
  const itemClose = doc.indexOf("},", firstClose + 1);
  assert.deepEqual(paths(doc, itemClose), ["$", "$.b", "$.b[0]"]);
  assert.deepEqual(paths(doc, itemClose + 1), ["$", "$.b"]);
  assert.deepEqual(paths(doc, doc.indexOf("]")), ["$", "$.b"]);
  assert.deepEqual(paths(doc, doc.length - 1), ["$"]);
  assert.deepEqual(paths(doc, doc.length), ["$"]);
});

test("keeps the innermost unfinished container at EOF and trailing whitespace", () => {
  for (const doc of ['{"a":{"x":1,', '{"a": {\n  ', '{"a":[0, {"x":1,\n  ']) {
    assert.deepEqual(
      paths(doc, doc.length),
      doc.includes("[") ? ["$", "$.a", "$.a[1]"] : ["$", "$.a"],
    );
  }
  const closedChild = '{"a":{"x":1}    ';
  assert.deepEqual(paths(closedChild, closedChild.length), ["$"]);
  const incompleteArray = '{"a": [1, 2\n ';
  assert.deepEqual(paths(incompleteArray, incompleteArray.length), [
    "$",
    "$.a",
  ]);
});

test("retains useful paths around recoverable syntax errors", () => {
  const doc = '{"items":[0,, {"x":1}, bad, [2]]}';
  assert.deepEqual(paths(doc, doc.indexOf('"x"')), [
    "$",
    "$.items",
    "$.items[1]",
  ]);
  assert.deepEqual(paths(doc, doc.indexOf("2")), [
    "$",
    "$.items",
    "$.items[2]",
  ]);
  assert.doesNotThrow(() => getJsonAncestors(state('{"broken'), 4));
});

test("does not interpret JSON embedded in a string or include scalar properties", () => {
  const doc = JSON.stringify({
    outer: { payload: '{"embedded":{"key":1}}', value: false },
  });
  assert.deepEqual(paths(doc, doc.indexOf("embedded")), ["$", "$.outer"]);
  assert.deepEqual(paths(doc, doc.indexOf("false")), ["$", "$.outer"]);
  for (const doc of ["42", '"{\\\"fake\\\":{}}"', "null", "true", "", " \n "])
    assert.deepEqual(paths(doc, Math.floor(doc.length / 2)), ["$"]);
});

test("clamps positions and works without an installed JSON language", () => {
  const doc = '{"a":{"leaf":1}}';
  assert.deepEqual(paths(doc, -10), ["$"]);
  assert.deepEqual(paths(doc, doc.length + 20), ["$"]);
  assert.deepEqual(paths(doc, Number.NaN), ["$"]);
  assert.deepEqual(getJsonAncestors(EditorState.create({ doc }), 10), [
    { label: "$", path: "$", from: 0, to: 0 },
  ]);
});

test("reuses array checkpoints in either scroll direction and invalidates after edits", () => {
  const doc = JSON.stringify({
    items: Array.from({ length: 2400 }, (_, id) => ({ id })),
  });
  const editor = state(doc);
  for (const index of [2300, 256, 2048, 240, 2399, 0, 1024]) {
    const position = doc.indexOf(`"id":${index}}`);
    assert.equal(
      getJsonAncestors(editor, position).at(-1)?.path,
      `$.items[${index}]`,
    );
  }
  const insertion = doc.indexOf("[") + 1;
  const changed = editor.update({
    changes: { from: insertion, insert: '{"added":true},' },
  }).state;
  assert.ok(ensureSyntaxTree(changed, changed.doc.length, 1000));
  const position = changed.doc.toString().indexOf('"id":2300}');
  assert.equal(
    getJsonAncestors(changed, position).at(-1)?.path,
    "$.items[2301]",
  );
});

test("keeps cached array indices and source offsets correct after edits before the array", () => {
  const doc = JSON.stringify({
    prefix: "x".repeat(512),
    items: Array.from({ length: 2400 }, (_, id) => ({ id })),
  });
  for (const change of [
    { from: 0, insert: " \n  " },
    { from: 1, insert: '"before":{"x":1},' },
  ]) {
    const original = state(doc);
    const tail = doc.indexOf('"id":2300}');
    assert.equal(
      getJsonAncestors(original, tail).at(-1)?.path,
      "$.items[2300]",
    );
    const edited = original.update({ changes: change }).state;
    assert.ok(ensureSyntaxTree(edited, edited.doc.length, 1000));
    const text = edited.doc.toString();
    const position = text.indexOf('"id":2300}');
    const ancestors = getJsonAncestors(edited, position);
    assert.deepEqual(
      ancestors.map((ancestor) => ancestor.path),
      ["$", "$.items", "$.items[2300]"],
    );
    assert.equal(text.slice(ancestors[1].from, ancestors[1].to), '"items"');
    assert.equal(ancestors[2].from, position - 1);
    assert.equal(text.slice(ancestors[2].from, ancestors[2].to), "{");
    assert.equal(
      getJsonAncestors(edited, text.indexOf('"id":256}')).at(-1)?.path,
      "$.items[256]",
    );
  }
});
