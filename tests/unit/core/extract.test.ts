import assert from "node:assert/strict";
import test from "node:test";
import { findKeyValues } from "../../../src/core/json/extract";
import { processJson } from "../../../src/core/json/json";
import {
  defaultOptions,
  type KeySearchResult,
} from "../../../src/shared/types";

const values = (result: KeySearchResult) =>
  result.matches.map((match) =>
    result.preparation.output.slice(match.start, match.end),
  );

test("finds the same key at the root and through nested objects and arrays", () => {
  const source =
    '{"data":{"data":[{"data":false},[{"data":null}]]},"list":[{"data":0}]}';
  const result = findKeyValues(source, "data", defaultOptions);
  assert.equal(result.preparation.success, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.matches.map((match) => match.path),
    [
      "$.data",
      "$.data.data",
      "$.data.data[0].data",
      "$.data.data[1][0].data",
      "$.list[0].data",
    ],
  );
  assert.deepEqual(
    result.matches.map((match) => match.type),
    ["object", "array", "boolean", "null", "number"],
  );
  assert.deepEqual(values(result).slice(2), ["false", "null", "0"]);
});

test("extracts a list value without losing large numbers or repeated properties", () => {
  const source = String.raw`{"payload":[{"id":9007199254740993,"id":1.2300e+04,"text":"\u0041\/\n\""},-0]}`;
  const result = findKeyValues(source, "payload", defaultOptions);
  assert.equal(result.matches.length, 1);
  const selected = values(result)[0];
  const formatted = processJson(selected, defaultOptions);
  assert.equal(formatted.success, true);
  assert.match(formatted.output, /9007199254740993/);
  assert.match(formatted.output, /1\.2300e\+04/);
  assert.match(formatted.output, /-0/);
  assert.equal(formatted.output.match(/"id"/g)?.length, 2);
  assert.ok(formatted.output.includes(String.raw`"text": "\u0041\/\n\""`));
});

test("retains a compressed JSON string for the existing decode and repair pipeline", () => {
  const inner = '{"enabled":True,"ids":[9007199254740993,]}';
  const source = JSON.stringify({ wrapper: { payload: inner } });
  const result = findKeyValues(source, "payload", defaultOptions);
  assert.equal(result.matches[0].type, "string");
  assert.equal(values(result)[0], JSON.stringify(inner));
  const formatted = processJson(values(result)[0], defaultOptions);
  assert.equal(formatted.success, true);
  assert.equal(formatted.decodedLayers, 1);
  assert.equal(formatted.stages.length, 1);
  assert.match(formatted.output, /9007199254740993/);
  assert.match(formatted.output, /"enabled": true/);
});

test("distinguishes duplicate keys and duplicate ancestors using occurrences and unique ids", () => {
  const result = findKeyValues(
    '{"a":{"item":1,"item":2},"a":{"item":3}}',
    "item",
    defaultOptions,
  );
  assert.deepEqual(
    result.matches.map((match) => match.path),
    ["$.a.item", "$.a.item", "$.a.item"],
  );
  assert.deepEqual(
    result.matches.map((match) => match.occurrence),
    [1, 2, 3],
  );
  assert.deepEqual(
    result.matches.map((match) => match.occurrences),
    [3, 3, 3],
  );
  assert.equal(new Set(result.matches.map((match) => match.id)).size, 3);
  assert.deepEqual(values(result), ["1", "2", "3"]);
});

test("handles special names literally and produces unambiguous JSONPath labels", () => {
  const source = JSON.stringify({
    "a.b": { "[0]": { 'a"b': 1 } },
    a: { b: 2 },
    "0": 3,
    中文: 4,
    " white key ": 5,
  });
  assert.equal(
    findKeyValues(source, "a.b", defaultOptions).matches[0].path,
    '$["a.b"]',
  );
  assert.equal(
    findKeyValues(source, "[0]", defaultOptions).matches[0].path,
    '$["a.b"]["[0]"]',
  );
  assert.equal(
    findKeyValues(source, 'a"b', defaultOptions).matches[0].path,
    '$["a.b"]["[0]"]["a\\"b"]',
  );
  assert.equal(
    findKeyValues(source, "0", defaultOptions).matches[0].path,
    '$["0"]',
  );
  assert.equal(
    findKeyValues(source, "中文", defaultOptions).matches[0].path,
    '$["中文"]',
  );
  assert.equal(
    findKeyValues(source, " white key ", defaultOptions).matches[0].path,
    '$[" white key "]',
  );
});

test("uses decoded key names for matching and treats case distinctly", () => {
  const source = String.raw`{"\u0064ata":1,"Data":2,"data":3,"__proto__":4,"constructor":5}`;
  assert.deepEqual(values(findKeyValues(source, "data", defaultOptions)), [
    "1",
    "3",
  ]);
  assert.deepEqual(values(findKeyValues(source, "Data", defaultOptions)), [
    "2",
  ]);
  assert.deepEqual(values(findKeyValues(source, "__proto__", defaultOptions)), [
    "4",
  ]);
  assert.deepEqual(
    values(findKeyValues(source, "constructor", defaultOptions)),
    ["5"],
  );
});

test("returns correct offsets and positions within prepared JSON", () => {
  const source = '{"emoji":"😀","inner":{"payload":[false,0]}}';
  const result = findKeyValues(source, "payload", defaultOptions);
  const match = result.matches[0];
  const prefix = result.preparation.output.slice(0, match.start);
  assert.equal(match.line, prefix.split("\n").length);
  assert.equal(match.column, match.start - prefix.lastIndexOf("\n"));
  assert.equal(values(result)[0], "[\n      false,\n      0\n    ]");
});

test("keeps falsy values and empty containers as valid matches", () => {
  const source =
    '{"values":[{"value":null},{"value":false},{"value":0},{"value":""},{"value":[]},{"value":{}}]}';
  const result = findKeyValues(source, "value", defaultOptions);
  assert.deepEqual(values(result), ["null", "false", "0", '""', "[]", "{}"]);
  assert.deepEqual(
    result.matches.map((match) => match.type),
    ["null", "boolean", "number", "string", "array", "object"],
  );
});

test("repairs and decodes the root before searching while retaining preparation records", () => {
  const source = JSON.stringify("{payload: [1,2,]}");
  const result = findKeyValues(source, "payload", defaultOptions);
  assert.equal(result.preparation.success, true);
  assert.equal(result.preparation.decodedLayers, 1);
  assert.equal(result.preparation.stages.length, 1);
  assert.equal(result.preparation.stages[0].layer, 1);
  assert.equal(result.matches[0].path, "$.payload");
  assert.deepEqual(JSON.parse(values(result)[0]), [1, 2]);
});

test("does not recursively parse field strings while looking for a key", () => {
  const result = findKeyValues(
    JSON.stringify({ payload: '{"target":1}', nested: { target: 2 } }),
    "target",
    defaultOptions,
  );
  assert.deepEqual(
    result.matches.map((match) => match.path),
    ["$.nested.target"],
  );
  assert.deepEqual(values(result), ["2"]);
});

test("returns no matches without inventing an error when a key is absent", () => {
  const result = findKeyValues('{"payload":1}', "missing", defaultOptions);
  assert.equal(result.preparation.success, true);
  assert.deepEqual(result.matches, []);
  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
});

test("returns source errors without partial or fabricated matches", () => {
  const result = findKeyValues(
    String.raw`{"payload":"\uZZZZ"}`,
    "payload",
    defaultOptions,
  );
  assert.equal(result.preparation.success, false);
  assert.ok(result.preparation.error?.message);
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, false);
  const disabledRepair = findKeyValues("{payload:1}", "payload", {
    ...defaultOptions,
    repair: false,
  });
  assert.equal(disabledRepair.preparation.success, false);
  assert.deepEqual(disabledRepair.matches, []);
});

test("rejects an empty key but accepts a whitespace property name literally", () => {
  const empty = findKeyValues("{}", "", defaultOptions);
  assert.match(empty.error ?? "", /key/);
  assert.deepEqual(empty.matches, []);
  assert.deepEqual(values(findKeyValues('{" ":1}', " ", defaultOptions)), [
    "1",
  ]);
});

test("reports truncation only when more than 1000 matches exist and counts duplicate paths accurately", () => {
  const source =
    "{" +
    Array.from({ length: 1_002 }, (_, index) => `"payload":${index}`).join(
      ",",
    ) +
    "}";
  const result = findKeyValues(source, "payload", defaultOptions);
  assert.equal(result.matches.length, 1_000);
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0].occurrences, 1_002);
  assert.equal(result.matches[999].occurrence, 1_000);
  assert.equal(values(result)[999], "999");
  const exact =
    "[" + Array.from({ length: 1_000 }, () => '{"payload":1}').join(",") + "]";
  const exactResult = findKeyValues(exact, "payload", defaultOptions);
  assert.equal(exactResult.matches.length, 1_000);
  assert.equal(exactResult.truncated, false);
});

test("keeps summaries bounded even for a very large value", () => {
  const result = findKeyValues(
    JSON.stringify({ payload: "x".repeat(20_000) }),
    "payload",
    defaultOptions,
  );
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].preview.length <= 100);
  assert.ok(result.matches[0].preview.endsWith("…"));
  assert.equal(JSON.parse(values(result)[0]).length, 20_000);
});

test("preserves whitespace within string values in candidate previews", () => {
  const value = "  a   b  \t c ";
  const stringResult = findKeyValues(
    JSON.stringify({ payload: value }),
    "payload",
    defaultOptions,
  );
  assert.equal(stringResult.matches[0].preview, JSON.stringify(value));
  const objectResult = findKeyValues(
    JSON.stringify({ payload: { label: "a   b" } }),
    "payload",
    defaultOptions,
  );
  assert.equal(objectResult.matches[0].preview, '{ "label": "a   b" }');
});

test("rejects extreme nesting explicitly before recursive parser traversal", () => {
  const source = "[".repeat(513) + '{"payload":1}' + "]".repeat(513);
  const result = findKeyValues(source, "payload", defaultOptions);
  assert.equal(result.preparation.success, true);
  assert.match(result.error ?? "", /512/);
  assert.deepEqual(result.matches, []);
});
