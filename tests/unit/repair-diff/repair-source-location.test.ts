import assert from "node:assert/strict";
import test from "node:test";
import { findKeyValues } from "../../../src/core/json/extract";
import { processStructuredJson } from "../../../src/core/json/extracted-json";
import { processJson } from "../../../src/core/json/json";
import { defaultOptions, type ExtractedValue } from "../../../src/shared/types";
import { collectRepairRecords } from "../../../src/renderer/features/repair-diff/repair-records";
import { createRepairSourceLocator } from "../../../src/renderer/features/repair-diff/repair-source-location";

function extracted(raw: string, occurrence = 1) {
  const search = findKeyValues(raw, "payload", defaultOptions);
  const match = search.matches.find((item) => item.occurrence === occurrence)!;
  assert.ok(match);
  const extraction: ExtractedValue = {
    key: "payload",
    path: match.path,
    occurrence,
    occurrences: match.occurrences,
    matchId: match.id,
    raw: search.preparation.output.slice(match.start, match.end),
    preparation: search.preparation,
  };
  const result = processStructuredJson(extraction.raw, defaultOptions);
  return {
    extraction,
    records: collectRepairRecords(result, search.preparation),
  };
}

test("locates original layer-zero edits without treating decoded offsets as source positions", () => {
  const raw = '{\n  "first":1\n  "next":2\n}';
  const records = collectRepairRecords(processJson(raw, defaultOptions));
  const locate = createRepairSourceLocator(raw, undefined, records.stages);
  assert.ok(records.changes.length);
  for (const change of records.changes) {
    const stage = records.stages.find((item) => item.id === change.stageId)!;
    assert.deepEqual(locate(change, stage), {
      from: change.start,
      to: change.end,
      line: change.line,
      column: change.column,
      exact: true,
    });
  }
});

test("selects the serialized nested string at its real original line", () => {
  const child = '{"active":True}';
  const raw = JSON.stringify(
    { note: "source", users: [{ details: child }] },
    null,
    2,
  );
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const stage = records.stages[0];
  assert.equal(stage.path, "$.users[0].details");
  const from = raw.indexOf(JSON.stringify(child));
  const location = createRepairSourceLocator(
    raw,
    undefined,
    records.stages,
  )(records.changes[0], stage)!;
  assert.deepEqual(location, {
    from,
    to: from + JSON.stringify(child).length,
    line: 5,
    column: 18,
    exact: false,
  });
  assert.equal(raw.slice(location.from, location.to), JSON.stringify(child));
});

test("combines extracted and relative paths and respects the selected duplicate occurrence", () => {
  const first = JSON.stringify('{"active":True}');
  const second = JSON.stringify('{"active":False}');
  const raw = `{"payload":{"details":${first}},"payload":{"details":${second}}}`;
  const { extraction, records } = extracted(raw, 2);
  const stage = records.stages.find((item) => item.origin === "extracted")!;
  const change = stage.changes[0];
  const location = createRepairSourceLocator(
    raw,
    extraction,
    records.stages,
  )(change, stage)!;
  assert.equal(raw.slice(location.from, location.to), second);
  assert.equal(location.from, raw.indexOf(second));
  assert.equal(location.exact, false);
});

test("maps quoted property names and array indices without splitting escaped path characters", () => {
  const child = '{"active":True}';
  const key = 'a.b["x"]';
  const raw = JSON.stringify({ [key]: [{ "": child }] }, null, 2);
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const stage = records.stages[0];
  const location = createRepairSourceLocator(
    raw,
    undefined,
    records.stages,
  )(stage.changes[0], stage)!;
  assert.equal(raw.slice(location.from, location.to), JSON.stringify(child));
});

test("selects the nearest original encoded container when deeper fields exist only after decoding", () => {
  const container = JSON.stringify({ details: '{"active":True}' });
  const raw = JSON.stringify({ before: true, payload: container }, null, 2);
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const stage = records.stages[0];
  assert.equal(stage.path, "$.payload.details");
  const location = createRepairSourceLocator(
    raw,
    undefined,
    records.stages,
  )(stage.changes[0], stage)!;
  assert.equal(
    raw.slice(location.from, location.to),
    JSON.stringify(container),
  );
  assert.equal(location.line, 3);
  assert.equal(location.exact, false);
});

test("selects an outer serialized string instead of jumping to inner decoded line numbers", () => {
  for (const raw of [
    JSON.stringify('{\n"active":True\n}'),
    JSON.stringify(JSON.stringify({ details: '{"active":True}' })),
  ]) {
    const records = collectRepairRecords(
      processStructuredJson(raw, defaultOptions),
    );
    const stage = records.stages[0];
    const location = createRepairSourceLocator(
      raw,
      undefined,
      records.stages,
    )(stage.changes[0], stage)!;
    assert.deepEqual(location, {
      from: 0,
      to: raw.length,
      line: 1,
      column: 1,
      exact: false,
    });
  }
});

test("uses verified inverse root repairs to locate values behind unquoted source keys", () => {
  const container = JSON.stringify({ details: '{"active":True}' });
  const literal = JSON.stringify(container);
  const raw = `{payload:${literal}, keep:true}`;
  const { extraction, records } = extracted(raw);
  const stage = records.stages.find((item) => item.origin === "extracted")!;
  const location = createRepairSourceLocator(
    raw,
    extraction,
    records.stages,
  )(stage.changes[0], stage)!;
  assert.equal(location.from, raw.indexOf(literal));
  assert.equal(raw.slice(location.from, location.to), literal);
  assert.equal(location.exact, false);
});

test("keeps duplicate source paths ambiguous unless the recorded text uniquely identifies a value", () => {
  const a = JSON.stringify('{"active":True}');
  const b = JSON.stringify('{"active":False}');
  const raw = `{"details":${a},"details":${b}}`;
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const locate = createRepairSourceLocator(raw, undefined, records.stages);
  for (const stage of records.stages) {
    const location = locate(stage.changes[0], stage)!;
    assert.equal(
      JSON.parse(raw.slice(location.from, location.to)),
      stage.before,
    );
  }
  const ambiguous = `{"details":${a},"details":${a}}`;
  const duplicateRecords = collectRepairRecords(
    processStructuredJson(ambiguous, defaultOptions),
  );
  const duplicateStage = duplicateRecords.stages[0];
  assert.equal(
    createRepairSourceLocator(
      ambiguous,
      undefined,
      duplicateRecords.stages,
    )(duplicateStage.changes[0], duplicateStage),
    undefined,
  );
});

test("returns no location for stale stages, invalid ranges, missing paths or missing extraction context", () => {
  const raw = '{"details":"{\\"active\\":True}"}';
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const stage = records.stages[0];
  const change = stage.changes[0];
  const locate = createRepairSourceLocator(raw, undefined, records.stages);
  assert.equal(locate({ ...change, path: "$.missing" }, stage), undefined);
  assert.equal(locate({ ...change, start: Number.NaN }, stage), undefined);
  assert.equal(locate({ ...change, origin: "extracted" }, stage), undefined);
  assert.equal(locate(change, { ...stage, id: "stale" }), undefined);
  const direct = collectRepairRecords(
    processJson('{"a":1 "b":2}', defaultOptions),
  );
  assert.equal(
    createRepairSourceLocator(' {"a":1 "b":2}')(
      direct.changes[0],
      direct.stages[0],
    ),
    undefined,
  );
});

test("computes source coordinates across large lines, CRLF and Unicode without decoding source tokens", () => {
  const child = '{"active":True}';
  const raw =
    '{\r\n"pad":"' +
    "😀".repeat(8_000) +
    '",\r\n"details":' +
    JSON.stringify(child) +
    "\r\n}";
  const records = collectRepairRecords(
    processStructuredJson(raw, defaultOptions),
  );
  const stage = records.stages[0];
  const locate = createRepairSourceLocator(raw, undefined, records.stages);
  const first = locate(stage.changes[0], stage)!;
  assert.equal(first.line, 3);
  assert.equal(first.column, 11);
  assert.deepEqual(locate(stage.changes[0], stage), first);
  assert.equal(raw.slice(first.from, first.to), JSON.stringify(child));
});
