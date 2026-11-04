import assert from "node:assert/strict";
import test from "node:test";
import { createScanner } from "jsonc-parser";
import { processJson } from "../../../src/core/json/json";
import {
  defaultOptions,
  MAX_FILE_BYTES,
  type ProcessingResult,
} from "../../../src/shared/types";

function applyChanges(stage: ProcessingResult["stages"][number]) {
  let output = stage.before;
  for (const change of [...stage.changes].reverse()) {
    assert.equal(stage.before.slice(change.start, change.end), change.before);
    output =
      output.slice(0, change.start) + change.after + output.slice(change.end);
  }
  return output;
}

test("formats tokens without changing large numbers, duplicate keys, or string escapes", () => {
  const raw = String.raw` { "id":9007199254740993,"id":1.2300e+04,"negative":-0,"text":"\u0041\/\n\"" } `;
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(
    result.output,
    String.raw`{
  "id": 9007199254740993,
  "id": 1.2300e+04,
  "negative": -0,
  "text": "\u0041\/\n\""
}`,
  );
  assert.equal(result.changeCount, 0);
  assert.deepEqual(result.stages, []);
});

test("formats nested and empty containers with each indentation option", () => {
  const raw = '{"list":[1,{},[],{"ready":true}],"empty":null}';
  const spaces = processJson(raw, { ...defaultOptions, indent: "4" });
  assert.equal(spaces.success, true);
  assert.match(spaces.output, /\n {8}\{\n {12}"ready": true\n {8}\}/);
  assert.deepEqual(JSON.parse(spaces.output), JSON.parse(raw));
  const tabs = processJson(raw, { ...defaultOptions, indent: "tab" });
  assert.match(tabs.output, /\n\t"list": \[/);
  assert.match(tabs.output, /\n\t\t\{\}/);
});

test("preserves every JSON token across large output chunks and long escaped strings", () => {
  const longValue = JSON.stringify('中文😀\\"\u2028\t'.repeat(8_000));
  const item = String.raw`{"id":9007199254740993,"id":1.2300e+04,"negative":-0,"text":"\\\"\u0041\/\n"}`;
  const raw = `{"rows":[${Array(2_000).fill(item).join(",")}],"large":${longValue}}`;
  const tokens = (text: string) => {
    const scanner = createScanner(text, true);
    const values: string[] = [];
    while (true) {
      scanner.scan();
      if (scanner.getTokenLength() === 0) break;
      values.push(
        text.slice(
          scanner.getTokenOffset(),
          scanner.getTokenOffset() + scanner.getTokenLength(),
        ),
      );
    }
    return values;
  };
  const expected = tokens(raw);
  for (const indent of ["2", "4", "tab"] as const) {
    const result = processJson(raw, { ...defaultOptions, indent });
    assert.equal(result.success, true);
    assert.deepEqual(tokens(result.output), expected);
    assert.deepEqual(result.stages, []);
    assert.equal(result.changeCount, 0);
  }
});

test("formats deep JSON without changing values beyond cached indentation levels", () => {
  const raw = "[".repeat(180) + '{"value":-0}' + "]".repeat(180);
  for (const indent of ["2", "4", "tab"] as const) {
    const result = processJson(raw, { ...defaultOptions, indent });
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(result.output), JSON.parse(raw));
    assert.match(result.output, /"value": -0/);
  }
});

test("repairs invalid JSON and returns actual, reversible character edits", () => {
  const raw = "\n\n  {name: 'Craft', active: True,}";
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.output), { name: "Craft", active: true });
  assert.equal(result.stages.length, 1);
  const stage = result.stages[0];
  assert.equal(stage.before, raw);
  assert.equal(stage.layer, 0);
  assert.equal(stage.diffTruncated, false);
  assert.equal(applyChanges(stage), stage.after);
  assert.equal(result.changeCount, stage.changes.length);
  const first = stage.changes[0];
  assert.equal(first.line, 3);
  assert.equal(first.column, 4);
  assert.equal(first.start, 5);
});

test("keeps UTF-16 editor offsets correct around emoji and CRLF lines", () => {
  const raw = '{"emoji":"😀",\r\n  "enabled":True}';
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  const stage = result.stages[0];
  assert.equal(applyChanges(stage), stage.after);
  const replacement = stage.changes.find((change) => change.before === "T");
  assert.ok(replacement);
  assert.equal(replacement.start, raw.indexOf("True"));
  assert.equal(replacement.line, 2);
  assert.equal(replacement.column, 13);
});

test("decodes multiple wrapped JSON strings while preserving inner string escapes", () => {
  const inner = String.raw`{"message":"line\nnext","id":9007199254740993}`;
  const raw = JSON.stringify(JSON.stringify(inner));
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.decodedLayers, 2);
  assert.match(result.output, /"message": "line\\nnext"/);
  assert.match(result.output, /9007199254740993/);
  assert.equal(result.changeCount, 0);
});

test("decodes unwrapped escaped JSON and retains escape sequences in field values", () => {
  const inner = String.raw`{"message":"line\nnext","quote":"a\"b"}`;
  const raw = JSON.stringify(inner).slice(1, -1);
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.decodedLayers, 1);
  assert.equal(result.stages.length, 0);
  assert.deepEqual(JSON.parse(result.output), JSON.parse(inner));
  assert.match(result.output, /line\\nnext/);
});

test("decodes an escaped array with nested objects", () => {
  const inner = '[{"id":42},"x"]';
  const raw = JSON.stringify(inner).slice(1, -1);
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.decodedLayers, 1);
  assert.deepEqual(JSON.parse(result.output), [{ id: 42 }, "x"]);
});

test("decodes several unwrapped escaping layers", () => {
  let raw = '{"id":9007199254740993}';
  for (let index = 0; index < 3; index++)
    raw = JSON.stringify(raw).slice(1, -1);
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.decodedLayers, 3);
  assert.match(result.output, /9007199254740993/);
  assert.equal(result.changeCount, 0);
});

test("retains every repair layer before and after decoding", () => {
  const inner = '{"enabled":True}';
  const raw = `'${inner}'`;
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.decodedLayers, 1);
  assert.equal(result.stages.length, 2);
  assert.deepEqual(
    result.stages.map((stage) => stage.layer),
    [0, 1],
  );
  assert.equal(result.stages[0].before, raw);
  assert.equal(result.stages[1].before, inner);
  for (const stage of result.stages)
    assert.equal(applyChanges(stage), stage.after);
  assert.equal(
    result.changeCount,
    result.stages.reduce((count, stage) => count + stage.changes.length, 0),
  );
});

test("does not unescape an ordinary JSON string or legal field escapes", () => {
  for (const raw of [
    String.raw`"hello\nworld"`,
    String.raw`{"text":"hello\nworld","quote":"\"hello\""}`,
  ]) {
    const result = processJson(raw, defaultOptions);
    assert.equal(result.success, true);
    assert.equal(result.decodedLayers, 0);
    assert.equal(result.changeCount, 0);
    assert.deepEqual(JSON.parse(result.output), JSON.parse(raw));
  }
});

test("does not unwrap Markdown text as JSON at any string-wrapper layer", () => {
  for (const text of [
    "[查看简历](https://example.com/resume)",
    '[查看简历](https://example.com/resume "详情")',
    "[查看简历][resume]",
    "[notice] ordinary text",
  ]) {
    let raw = JSON.stringify(text);
    for (let layer = 0; layer < 3; layer++) {
      const result = processJson(raw, defaultOptions);
      assert.equal(result.success, true);
      assert.equal(result.output, raw);
      assert.equal(result.decodedLayers, 0);
      assert.deepEqual(result.stages, []);
      raw = JSON.stringify(raw);
    }
  }
});

test("leaves wrapped JSON as a string when automatic unescaping is disabled", () => {
  const raw = JSON.stringify('{"id":42}');
  const result = processJson(raw, { ...defaultOptions, autoUnescape: false });
  assert.equal(result.success, true);
  assert.equal(result.output, raw);
  assert.equal(result.decodedLayers, 0);
});

test("does not infer JSON arrays from isolated unquoted bracketed text", () => {
  for (const text of [
    "[REDACTED]",
    "[MASKED]",
    "[hidden]",
    "[text]",
    "[not available]",
    "[token-id]",
    "[null-value]",
    "[true-story]",
    "[123-456]",
    String.raw`[\x]`,
    " [REDACTED] ",
  ]) {
    let raw = JSON.stringify(text);
    for (let layer = 0; layer < 3; layer++) {
      const result = processJson(raw, defaultOptions);
      assert.equal(result.success, true);
      assert.equal(result.output, raw);
      assert.equal(result.decodedLayers, 0);
      assert.equal(result.changeCount, 0);
      assert.deepEqual(result.stages, []);
      raw = JSON.stringify(raw);
    }
  }
  const explicit = processJson("[REDACTED]", defaultOptions);
  assert.equal(explicit.success, true);
  assert.deepEqual(JSON.parse(explicit.output), ["REDACTED"]);
  assert.ok(explicit.stages.length > 0);
});

test("reports excessive escaping explicitly rather than stopping silently", () => {
  let raw = '{"id":42}';
  for (let index = 0; index < 9; index++) raw = JSON.stringify(raw);
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, false);
  assert.equal(result.output, "");
  assert.equal(result.decodedLayers, 8);
  assert.match(result.error?.message ?? "", /超过 8 层/);
});

test("returns a useful error location when repair is disabled", () => {
  const raw = '\n\n  {"id":}';
  const result = processJson(raw, { ...defaultOptions, repair: false });
  assert.equal(result.success, false);
  assert.equal(result.stages.length, 0);
  assert.equal(result.error?.line, 3);
  assert.equal(result.error?.column, 9);
  assert.equal(result.error?.offset, raw.indexOf("}"));
  assert.equal(result.error?.layer, 0);
});

test("repairs missing values inside a repaired wrapper", () => {
  const raw = `'${'{"id":}'}'`;
  const result = processJson(raw, { ...defaultOptions, repair: true });
  assert.equal(result.success, true);
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].layer, 0);
  assert.equal(result.stages[1].layer, 1);
  assert.deepEqual(JSON.parse(result.output), { id: null });
});

test("preserves completed repair stages when a later decoded layer fails", () => {
  const raw = `'${'{"id":1 + 2}'}'`;
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, false);
  assert.equal(result.output, "");
  assert.equal(result.decodedLayers, 1);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].layer, 0);
  assert.equal(applyChanges(result.stages[0]), result.stages[0].after);
  assert.equal(result.error?.layer, 1);
});

test("marks large repair diffs as truncated without inventing exact counts", () => {
  const raw = `{"text":"${"x".repeat(260_000)}",}`;
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.changeCount, null);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].diffTruncated, true);
  assert.deepEqual(result.stages[0].changes, []);
  assert.equal(result.stages[0].before, raw);
  assert.ok(result.stages[0].after.endsWith('"}'));
});

test("aborts complex differences without returning partial counts", () => {
  const raw = `[${Array.from({ length: 1_100 }, () => "'x'").join(",")}]`;
  const result = processJson(raw, defaultOptions);
  assert.equal(result.success, true);
  assert.equal(result.changeCount, null);
  assert.equal(result.stages[0].diffTruncated, true);
  assert.deepEqual(result.stages[0].changes, []);
});

test("formats scalar values without normalizing their spelling", () => {
  for (const raw of ["null", "true", "false", "-0", "1.000e+90", "1e9999"]) {
    const result = processJson(raw, defaultOptions);
    assert.equal(result.success, true);
    assert.equal(result.output, raw);
    assert.equal(result.changeCount, 0);
  }
});

test("enforces the shared 20 MiB input limit using UTF-8 byte size", () => {
  const result = processJson(
    `"${"中".repeat(Math.ceil(MAX_FILE_BYTES / 3))}"`,
    defaultOptions,
  );
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /20 MiB/);
});

test("rejects empty input without repairing it into a fabricated value", () => {
  const result = processJson(" \n\t", defaultOptions);
  assert.equal(result.success, false);
  assert.equal(result.changeCount, 0);
  assert.equal(result.error?.offset, 0);
});
