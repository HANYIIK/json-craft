import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJsonFromLog,
  MAX_LOG_RESULTS,
} from "../../../src/core/json/log-extract";
import { defaultOptions, MAX_FILE_BYTES } from "../../../src/shared/types";

const extract = (raw: string) => extractJsonFromLog(raw, defaultOptions);
const values = (raw: string) =>
  extract(raw).items.map((item) => JSON.parse(item.result.output));

test("finds multiple separate JSON documents in mixed logs", () => {
  const source =
    '2026-11-10 INFO payload={"id":1,"items":[1,2]} done\n' +
    'WARN body=[{"id":2},{"id":3}]\nINFO end={"ok":true}';
  const result = extract(source);
  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.items.length, 3);
  assert.deepEqual(values(source), [
    { id: 1, items: [1, 2] },
    [{ id: 2 }, { id: 3 }],
    { ok: true },
  ]);
  for (const item of result.items)
    assert.equal(source.slice(item.start, item.end), item.raw);
});

test("returns an empty result for empty or whitespace-only input", () => {
  for (const source of ["", " \r\n\t "]) {
    const result = extract(source);
    assert.deepEqual(result.items, []);
    assert.equal(result.truncated, false);
    assert.equal(result.error, undefined);
    assert.ok(Number.isFinite(result.elapsedMs));
  }
});

test("accepts empty objects and arrays", () => {
  assert.deepEqual(values("INFO value={} after=[] done"), [{}, []]);
});

test("keeps a valid parent and suppresses nested objects, arrays and JSON strings", () => {
  const source = JSON.stringify({
    nested: { value: [{ id: 1 }] },
    payload: '{"enabled":true}',
  });
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, source);
  assert.deepEqual(JSON.parse(result.items[0].result.output), {
    nested: { value: [{ id: 1 }] },
    payload: { enabled: true },
  });
});

test("recognizes an isolated quoted JSON string and multiple wrapping layers", () => {
  const source = '{"id":1,"items":["two"]}';
  const once = JSON.stringify(source);
  const twice = JSON.stringify(once);
  const result = extract(`INFO one=${once}\nINFO two=${twice}`);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].raw, once);
  assert.equal(result.items[1].raw, twice);
  assert.equal(result.items[0].result.decodedLayers, 1);
  assert.equal(result.items[1].result.decodedLayers, 2);
  assert.deepEqual(
    result.items.map((item) => JSON.parse(item.result.output)),
    [
      { id: 1, items: ["two"] },
      { id: 1, items: ["two"] },
    ],
  );
});

test("recognizes escaped envelopes even when their outer quotes are escaped", () => {
  const bare = String.raw`{\"id\":1,\"message\":\"brace } and [ remain text\"}`;
  const quoted = String.raw`\"{\\\"id\\\":2}\"`;
  const result = extract(`INFO raw=${bare}\nINFO quoted=${quoted}`);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].raw, bare);
  assert.equal(result.items[1].raw, quoted);
  assert.deepEqual(
    result.items.map((item) => JSON.parse(item.result.output)),
    [{ id: 1, message: "brace } and [ remain text" }, { id: 2 }],
  );
});

test("recognizes unquoted escaped arrays without mistaking placeholders for arrays", () => {
  const source = String.raw`INFO values=[\"REDACTED\",\"Plain text\"] after=[REDACTED]`;
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, String.raw`[\"REDACTED\",\"Plain text\"]`);
  assert.deepEqual(JSON.parse(result.items[0].result.output), [
    "REDACTED",
    "Plain text",
  ]);
});

test("leaves a quoted JSON candidate wrapped when auto-unescape is disabled", () => {
  const source = JSON.stringify('{"payload":"{\\"id\\":1}"}');
  const result = extractJsonFromLog(`INFO payload=${source}`, {
    ...defaultOptions,
    autoUnescape: false,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].result.decodedLayers, 0);
  assert.equal(result.items[0].result.output, source);
  assert.equal(typeof JSON.parse(result.items[0].result.output), "string");
});

test("applies recursive unescaping independently from outer unescaping", () => {
  const source = JSON.stringify(
    JSON.stringify({
      payload: '{"id":1}',
      values: ['{"active":true}', "Plain text", "[REDACTED]"],
    }),
  );
  const shallow = extractJsonFromLog(source, defaultOptions, false);
  const deep = extractJsonFromLog(source, defaultOptions, true);
  assert.equal(shallow.items.length, 1);
  assert.equal(deep.items.length, 1);
  assert.deepEqual(JSON.parse(shallow.items[0].result.output), {
    payload: '{"id":1}',
    values: ['{"active":true}', "Plain text", "[REDACTED]"],
  });
  assert.deepEqual(JSON.parse(deep.items[0].result.output), {
    payload: { id: 1 },
    values: [{ active: true }, "Plain text", "[REDACTED]"],
  });
});

test("repairs JSON-like fragments only when repair is enabled", () => {
  const damaged = "{name:'Example',enabled:True,items:[1,2,],}";
  const source = `INFO payload=${damaged}\nINFO next={"ok":true}`;
  const repaired = extract(source);
  assert.equal(repaired.items.length, 2);
  assert.ok(repaired.items[0].result.stages.length > 0);
  assert.deepEqual(JSON.parse(repaired.items[0].result.output), {
    name: "Example",
    enabled: true,
    items: [1, 2],
  });
  const strict = extractJsonFromLog(source, {
    ...defaultOptions,
    repair: false,
  });
  assert.equal(strict.items.length, 1);
  assert.equal(strict.items[0].raw, '{"ok":true}');
});

test("supports JSON comments without treating braces inside comments as boundaries", () => {
  const source = 'INFO payload={/* } [ */"id":1,// [{\n"value":2,} done';
  assert.deepEqual(values(source), [{ id: 1, value: 2 }]);
});

test("does not repair ordinary bracketed labels, links or unquoted lists", () => {
  const source = [
    "[INFO] [DEBUG] [trace-id] [REDACTED] [Alice, Bob]",
    "[View profile](https://example.com/profile?id=1)",
    '[1](https://example.com) [{"id":1}](https://example.com)',
    "{not JSON} {plain words, more words}",
    'INFO message="[REDACTED]" detail="[View](https://example.com)"',
  ].join("\n");
  assert.deepEqual(extract(source).items, []);
});

test("does not treat JavaScript function bodies and their nested literals as log JSON", () => {
  const source = [
    'const run = () => { return {"id":1}; };',
    "function run() { const data = {enabled:true}; return data; }",
    'if (ready) { console.log({"ok":true}); }',
  ].join("\n");
  assert.deepEqual(extract(source).items, []);
});

test("keeps braces and escaped quotes inside strings out of the bracket stack", () => {
  const value = {
    message: 'keep { and ] and "quoted" text',
    path: "C:\\files\\name.json",
    payload: '{"text":"literal } and ["}',
  };
  const source = JSON.stringify(value);
  const result = extract(`INFO before=${source} after={"next":true}`);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].raw, source);
  assert.equal(
    JSON.parse(result.items[0].result.output).message,
    value.message,
  );
  assert.equal(JSON.parse(result.items[0].result.output).path, value.path);
});

test("accepts JSON inside a single-quoted curl argument without including shell quotes", () => {
  const source = `curl --data '{"id":1,"items":[2]}' https://example.com`;
  assert.deepEqual(values(source), [{ id: 1, items: [2] }]);
});

test("preserves distinct repeated fragments at their original locations", () => {
  const source = 'INFO {"id":1} repeat {"id":1}\nINFO {"id":1}';
  const result = extract(source);
  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map((item) => item.id)).size, 3);
  assert.deepEqual(
    result.items.map((item) => item.line),
    [1, 1, 2],
  );
  assert.ok(result.items[0].start < result.items[1].start);
  assert.ok(result.items[1].start < result.items[2].start);
});

test("preserves number spellings, duplicate keys and legal string escapes", () => {
  const source = String.raw`{"id":900719925474099312345,"id":1.2300e+04,"zero":-0,"text":"\u0041\/\n\""}`;
  const result = extract(`INFO data=${source}`);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.raw, source);
  assert.match(item.result.output, /900719925474099312345/);
  assert.match(item.result.output, /1\.2300e\+04/);
  assert.match(item.result.output, /"zero": -0/);
  assert.equal(item.result.output.match(/"id"/g)?.length, 2);
  assert.ok(item.result.output.includes(String.raw`"text": "\u0041\/\n\""`));
});

test("reports UTF-16 source offsets and original CRLF line and column numbers", () => {
  const first = '{"a":1}';
  const second = JSON.stringify('{"b":2}');
  const source = `heading\r\n😀 INFO ${first}\r\n  payload=${second}\r\n`;
  const result = extract(source);
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map(({ line, column }) => ({ line, column })),
    [
      { line: 2, column: 9 },
      { line: 3, column: 11 },
    ],
  );
  assert.equal(result.items[0].start, source.indexOf(first));
  assert.equal(result.items[1].start, source.indexOf(second));
  for (const item of result.items)
    assert.equal(source.slice(item.start, item.end), item.raw);
});

test("recovers subsequent log entries after an unfinished object or string", () => {
  for (const broken of ['{"missing":1', '{"message":"unfinished']) {
    const source = `INFO payload=${broken}\nINFO payload={"ok":true}`;
    const result = extract(source);
    assert.equal(result.items.length, 2);
    assert.deepEqual(JSON.parse(result.items[1].result.output), { ok: true });
    assert.equal(result.items[1].line, 2);
    const strict = extractJsonFromLog(source, {
      ...defaultOptions,
      repair: false,
    });
    assert.equal(strict.items.length, 1);
    assert.equal(strict.items[0].raw, '{"ok":true}');
  }
});

test("repairs an unfinished final JSON fragment without fabricating extra fragments", () => {
  const source = 'INFO payload={"id":1,"items":[2,3';
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, '{"id":1,"items":[2,3');
  assert.deepEqual(JSON.parse(result.items[0].result.output), {
    id: 1,
    items: [2, 3],
  });
});

test("recovers balanced child fragments from an invalid log wrapper", () => {
  const source = 'INFO {invalid syntax here ( ) {"id":1} trailing}';
  const result = extractJsonFromLog(source, {
    ...defaultOptions,
    repair: false,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, '{"id":1}');
});

test("recovers JSON-string children when their enclosing text is not valid JSON", () => {
  const literal = JSON.stringify('{"id":1}');
  const source = `INFO {invalid body ( ) payload=${literal} trailing}`;
  const result = extractJsonFromLog(source, {
    ...defaultOptions,
    repair: false,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, literal);
});

test("applies indentation settings to every extracted result", () => {
  const result = extractJsonFromLog('INFO {"id":1} {"id":2}', {
    ...defaultOptions,
    indent: "tab",
  });
  assert.equal(result.items.length, 2);
  for (const item of result.items) assert.match(item.result.output, /\n\t"id"/);
});

test("limits result count while retaining complete original fragments", () => {
  const source = Array.from(
    { length: MAX_LOG_RESULTS + 1 },
    (_, id) => `INFO {"id":${id}}`,
  ).join("\n");
  const result = extract(source);
  assert.equal(result.items.length, MAX_LOG_RESULTS);
  assert.equal(result.truncated, true);
  assert.deepEqual(JSON.parse(result.items.at(-1)!.result.output), {
    id: MAX_LOG_RESULTS - 1,
  });
  const exact = extract(source.slice(0, source.lastIndexOf("\n")));
  assert.equal(exact.items.length, MAX_LOG_RESULTS);
  assert.equal(exact.truncated, false);
});

test("does not spend candidate storage on ordinary quoted log words", () => {
  const source = 'INFO "ordinary text" '.repeat(25_000) + '{"ok":true}';
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.items[0].raw, '{"ok":true}');
});

test("keeps a large valid array intact when child candidate storage is exhausted", () => {
  const source = `[${'{"id":1},'.repeat(22_000)}{"id":2}]`;
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.items[0].raw, source);
  assert.equal(JSON.parse(result.items[0].result.output).length, 22_001);
});

test("bounds pathological nesting without overflowing the JavaScript stack", () => {
  for (const source of [
    "[".repeat(30_000),
    "[".repeat(30_000) + "]".repeat(30_000),
  ]) {
    const result = extract(source);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.items, []);
  }
});

test("scans long bracket-label noise and unfinished quotes without hiding the next log", () => {
  const source =
    "[INFO] [trace-id] plain text ".repeat(100_000) +
    '"' +
    "x".repeat(500_000) +
    '\nINFO payload={"ok":true}';
  const result = extract(source);
  assert.equal(result.items.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.items[0].raw, '{"ok":true}');
});

test("does not rescan the entire active stack for every mismatched closing bracket", () => {
  const source =
    "{".repeat(1_024) +
    "]".repeat(5 * 1024 * 1024) +
    '\nINFO payload={"ok":true}';
  const result = extract(source);
  assert.equal(result.items.at(-1)?.raw, '{"ok":true}');
  assert.ok(result.elapsedMs < 5_000);
});

test("enforces the byte limit for ASCII and multibyte logs", () => {
  for (const source of [
    " ".repeat(MAX_FILE_BYTES + 1),
    "中".repeat(Math.floor(MAX_FILE_BYTES / 3) + 1),
  ]) {
    const result = extract(source);
    assert.match(result.error!, /20 MiB/);
    assert.deepEqual(result.items, []);
  }
});
