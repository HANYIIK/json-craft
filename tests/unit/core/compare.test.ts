import assert from "node:assert/strict";
import test from "node:test";
import { alignJsonKeys } from "../../../src/core/json/compare";
import { processStructuredJson } from "../../../src/core/json/extracted-json";
import { processJson } from "../../../src/core/json/json";
import { defaultOptions } from "../../../src/shared/types";

function align(left: string, right: string) {
  const result = alignJsonKeys(left, right, "2");
  assert.equal(result.success, true, result.error ?? "alignment failed");
  assert.equal(result.left, left);
  return result;
}

test("recursively aligns common keys and appends right-only keys in their original order", () => {
  const result = align(
    '{"name":0,"profile":{"first":0,"last":0},"enabled":false}',
    '{"extra":1,"enabled":true,"profile":{"unknown":2,"last":"B","first":"A","other":3},"name":"Person","tail":4}',
  );
  assert.equal(result.alignedObjects, 2);
  assert.equal(
    result.right,
    '{\n  "name": "Person",\n  "profile": {\n    "first": "A",\n    "last": "B",\n    "unknown": 2,\n    "other": 3\n  },\n  "enabled": true,\n  "extra": 1,\n  "tail": 4\n}',
  );
});

test("keeps array items in place and pairs nested object references by index", () => {
  const result = align(
    '[{"b":0,"a":0},{"a":0,"b":0},[{"y":0,"x":0}]]',
    '[{"a":1,"b":2},{"b":3,"a":4},[{"x":5,"y":6}],{"z":7,"a":8}]',
  );
  assert.deepEqual(JSON.parse(result.right), [
    { b: 2, a: 1 },
    { a: 4, b: 3 },
    [{ y: 6, x: 5 }],
    { z: 7, a: 8 },
  ]);
  assert.match(result.right, /"b": 2,\n    "a": 1/);
  assert.match(result.right, /"a": 4,\n    "b": 3/);
  assert.match(result.right, /"y": 6,\n      "x": 5/);
  assert.equal(result.alignedObjects, 3);
});

test("preserves large and unusual numeric lexemes and exact string escaping", () => {
  const result = align(
    '{"id":0,"number":0,"negative":0,"text":""}',
    String.raw`{"text":"\u0041\/\n\"","negative":-0,"number":1.2300e+04,"id":900719925474099312345}`,
  );
  assert.ok(result.right.includes("900719925474099312345"));
  assert.ok(result.right.includes("1.2300e+04"));
  assert.ok(result.right.includes('"negative": -0'));
  assert.ok(result.right.includes(String.raw`"text": "\u0041\/\n\""`));
});

test("matches duplicate key occurrences in order without dropping any properties", () => {
  const result = align(
    '{"repeat":{"b":0,"a":0},"other":0,"repeat":{"a":0,"b":0}}',
    '{"extra":9,"repeat":{"a":1,"b":2},"repeat":{"b":3,"a":4},"other":5,"repeat":{"d":6,"c":7}}',
  );
  assert.equal(result.right.match(/"repeat"/g)?.length, 3);
  assert.equal(
    result.right,
    '{\n  "repeat": {\n    "b": 2,\n    "a": 1\n  },\n  "other": 5,\n  "repeat": {\n    "a": 4,\n    "b": 3\n  },\n  "extra": 9,\n  "repeat": {\n    "d": 6,\n    "c": 7\n  }\n}',
  );
});

test("matches decoded key names while preserving right key spelling and source numeric key order", () => {
  const result = align(
    String.raw`{"2":0,"1":0,"\u0061":0,"__proto__":0,"constructor":0}`,
    '{"constructor":1,"a":2,"1":3,"__proto__":4,"2":5}',
  );
  assert.equal(
    result.right,
    '{\n  "2": 5,\n  "1": 3,\n  "a": 2,\n  "__proto__": 4,\n  "constructor": 1\n}',
  );
});

test("does not invent missing fields or align unmatched and type-incompatible descendants", () => {
  const result = align(
    '{"missing":1,"present":{"a":0},"different":[{"a":0,"b":0}]}',
    '{"different":{"b":2,"a":1},"present":null,"new":{"b":4,"a":3}}',
  );
  assert.equal(
    result.right,
    '{\n  "present": null,\n  "different": {\n    "b": 2,\n    "a": 1\n  },\n  "new": {\n    "b": 4,\n    "a": 3\n  }\n}',
  );
});

test("accepts scalar roots and empty containers", () => {
  for (const right of ['"literal { [ text"', "-0", "false", "null", "{}", "[]"])
    assert.equal(align("{}", right).right, right);
});

test("formats with the existing indentation conventions", () => {
  for (const indent of ["2", "4", "tab"] as const) {
    const result = alignJsonKeys(
      '{"a":0,"b":0}',
      '{"b":[{"x":1}],"a":{}}',
      indent,
    );
    assert.equal(result.success, true, result.error ?? "alignment failed");
    assert.equal(
      result.right,
      processJson('{"a":{},"b":[{"x":1}]}', { ...defaultOptions, indent })
        .output,
    );
  }
});

test("compares prepared recursively decoded and repaired JSON with exact value tokens", () => {
  const left = processStructuredJson(
    '{"data":"{\\"id\\":9007199254740993,\\"name\\":\\"A\\"}"}',
    defaultOptions,
    true,
  );
  const right = processStructuredJson(
    '{data:"{\\"name\\":\\"B\\",\\"id\\":9007199254740993}"}',
    defaultOptions,
    true,
  );
  assert.equal(left.success, true);
  assert.equal(right.success, true);
  const result = align(left.output, right.output);
  assert.match(result.right, /"id": 9007199254740993,\n    "name": "B"/);
});

test("rejects invalid and excessively deep documents without returning partial output", () => {
  for (const [left, right] of [
    ["", "{}"],
    ["{}", '{"a":1,}'],
    ["/*comment*/{}", "{}"],
    ["{}", "[".repeat(513) + "0" + "]".repeat(513)],
  ]) {
    const result = alignJsonKeys(left, right, "2");
    assert.equal(result.success, false);
    assert.equal(result.left, left);
    assert.equal(result.right, right);
    assert.equal(result.alignedObjects, 0);
    assert.ok(result.error);
  }
});

test("handles bounded deep nesting without recursive rendering or output loss", () => {
  const left = "[".repeat(400) + '{"a":0,"b":0}' + "]".repeat(400);
  const right = "[".repeat(400) + '{"b":2,"a":1}' + "]".repeat(400);
  const result = align(left, right);
  assert.match(result.right, /"a": 1,\n\s+"b": 2/);
  assert.equal(result.alignedObjects, 1);
  assert.deepEqual(JSON.parse(result.right), JSON.parse(right));
});

test("handles wide objects in linear matching passes without numeric precision loss", () => {
  const count = 20_000;
  const keys = Array.from({ length: count }, (_, index) => `field-${index}`);
  const left = "{" + keys.map((key) => `"${key}":0`).join(",") + "}";
  const right =
    "{" +
    [...keys]
      .reverse()
      .map((key) => `"${key}":9007199254740993`)
      .join(",") +
    "}";
  const result = align(left, right);
  assert.equal(result.alignedObjects, 1);
  assert.equal(result.right.match(/9007199254740993/g)?.length, count);
  assert.ok(
    result.right.indexOf('"field-0"') < result.right.indexOf('"field-19999"'),
  );
});
