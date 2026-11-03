import assert from "node:assert/strict";
import test from "node:test";
import { jsonLanguage as original } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { getJsonAncestors } from "../../../src/renderer/features/editor/json-context";
import {
  optimizedJsonLanguage,
  json,
} from "../../../src/renderer/features/editor/json-language";
import { TreeFragment, type Tree } from "@lezer/common";

function nodes(tree: Tree) {
  const result: [string, number, number][] = [];
  tree.iterate({
    enter: (node) => {
      result.push([node.name, node.from, node.to]);
    },
  });
  return result;
}

function compare(raw: string) {
  assert.deepEqual(
    nodes(optimizedJsonLanguage.parser.parse(raw)),
    nodes(original.parser.parse(raw)),
  );
}

test("reuses strictly valid giant value and property-name strings without changing the syntax tree", () => {
  const long = '中文😀\\"'.repeat(4_000);
  compare(
    JSON.stringify({
      before: true,
      [long]: { large: long, after: [1, false, null] },
    }),
  );
  compare(JSON.stringify(long));
});

test("invalid escapes, controls and missing quotes retain original error recovery", () => {
  const long = "x".repeat(20_000);
  for (const raw of [
    `{"a":"${long}`,
    `{"a":"${long}\\q"}`,
    `{"a":"${long}\t"}`,
    `{"${long}":type}`,
    `{"a":"${long}\\u12xz"}`,
    `["${long}":1]`,
    `{"key":"${long}":1}`,
    `{"${long}"\n  :1}`,
  ])
    compare(raw);
});

test("incremental edits preserve the full tree and string offsets", () => {
  let state = EditorState.create({
    doc: JSON.stringify({ large: "a".repeat(30_000), after: [1, 2] }),
    extensions: [json()],
  });
  for (const insert of ["😀", '"', "\\", "\t", "\n", "text"]) {
    const position = Math.floor(state.doc.length / 2);
    state = state.update({ changes: { from: position, insert } }).state;
    const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
    assert.ok(tree);
    assert.deepEqual(
      nodes(tree),
      nodes(original.parser.parse(state.doc.toString())),
    );
  }
});

test("partial and discontiguous parse ranges only reuse fully covered string tokens", () => {
  const raw = `{"before":0,"large":${JSON.stringify('😀\\"x'.repeat(5_000))},"after":[1,2]}`;
  const start = raw.indexOf('"😀');
  const end = raw.indexOf(',"after"');
  for (const ranges of [
    [{ from: 0, to: raw.length }],
    [{ from: start, to: end }],
    [{ from: start + 1, to: end - 1 }],
    [
      { from: 0, to: start + 100 },
      { from: end - 100, to: raw.length },
    ],
    [
      { from: 0, to: 1 },
      { from: start, to: end },
      { from: raw.length - 1, to: raw.length },
    ],
  ])
    assert.deepEqual(
      nodes(optimizedJsonLanguage.parser.parse(raw, [], ranges)),
      nodes(original.parser.parse(raw, [], ranges)),
    );
});

test("viewport stops and resumed parses retain original parent structures", () => {
  const raw = JSON.stringify({
    outer: [{ large: "x".repeat(40_000), after: [true, false] }],
  });
  for (const stop of [100, 3_000, 20_000, raw.length - 1]) {
    const read = (language: typeof original) => {
      const parsing = language.parser.startParse(raw);
      parsing.stopAt(stop);
      for (let step = 0; step < 100_000; step++) {
        const tree = parsing.advance();
        if (tree) return tree;
      }
      throw new Error("Parse did not finish");
    };
    const partial = read(optimizedJsonLanguage);
    assert.deepEqual(nodes(partial), nodes(read(original)));
    const resumed = optimizedJsonLanguage.parser.parse(
      raw,
      TreeFragment.addTree(partial, [], true),
    );
    assert.deepEqual(nodes(resumed), nodes(original.parser.parse(raw)));
  }
});

test("duplicated keys, raw surrogates and all JSON escape forms retain exact nodes", () => {
  const long = "x".repeat(17_000);
  const valid = String.raw`\"\\\/\b\f\n\r\t\uD800\uDC00`;
  for (const suffix of [
    valid,
    "😀",
    "\ud800",
    "\udc00",
    '\ud800"\udc00',
    "\u2028\u2029",
    String.raw`\u12`,
    String.raw`\v`,
    String.raw`\'`,
  ])
    compare(
      `{"same":"${long}${suffix}","same":{"large":"${long}","after":[]}}`,
    );
});

test("incremental line insertions and deletions keep sibling fragments and breadcrumb offsets current", () => {
  const value = "x".repeat(20_000);
  let state = EditorState.create({
    doc: `{"outer":[\n{"large":"${value}"},\n{"large":"${value}"}\n],"tail":true}`,
    extensions: [json()],
  });
  for (const change of [
    { from: 0, insert: "\n\n" },
    { from: 0, to: 1, insert: "" },
    { from: 15, insert: " " },
    { from: 15, to: 16, insert: "" },
    { from: 0, to: 1, insert: " " },
  ]) {
    state = state.update({ changes: change }).state;
    const complete = ensureSyntaxTree(state, state.doc.length, 5_000);
    assert.ok(complete);
    assert.deepEqual(
      nodes(complete),
      nodes(original.parser.parse(state.doc.toString())),
    );
  }
  const second = state.doc.toString().lastIndexOf('"large"');
  assert.equal(
    getJsonAncestors(state, second + 100).at(-1)?.path,
    "$.outer[1]",
  );
});

test("native prefilter retains long strings at every block boundary and slash parity", () => {
  for (const prefix of [0, 1, 4_094, 4_095, 4_096, 4_097, 8_191, 8_192]) {
    for (const value of [
      "x".repeat(16_400),
      '😀\\"'.repeat(4_100),
      "\\".repeat(8_201),
      "\\".repeat(8_202) + '"',
    ])
      compare(" ".repeat(prefix) + JSON.stringify({ key: value }));
  }
});

test("native prefilter preserves deterministic mixed dense and giant-token documents", () => {
  let seed = 17;
  const next = () =>
    (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0);
  for (let sample = 0; sample < 12; sample++) {
    const padding = " ".repeat(next() % 4_097);
    const short = JSON.stringify({ a: "short", b: 'escaped\\"', c: 0 });
    const count = next() % 600;
    const value = Array.from(
      { length: 10_000 },
      () => ["a", "😀", "\\", '"'][next() % 4],
    ).join("");
    compare(
      padding +
        `[${Array(count).fill(short).concat(JSON.stringify(value)).join(",")}]`,
    );
  }
  const short = JSON.stringify({ a: "short", b: 'escaped\\"', c: 0 });
  compare(`[${Array(1_000).fill(short).join(",")}]`);
});
