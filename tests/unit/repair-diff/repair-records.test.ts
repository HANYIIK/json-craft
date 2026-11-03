import assert from "node:assert/strict";
import test from "node:test";
import { findKeyValues } from "../../../src/core/json/extract";
import { processStructuredJson } from "../../../src/core/json/extracted-json";
import { processJson } from "../../../src/core/json/json";
import {
  collectRepairRecords,
  getRepairSummary,
} from "../../../src/renderer/features/repair-diff/repair-records";
import {
  defaultOptions,
  type ProcessingResult,
  type RepairStage,
} from "../../../src/shared/types";

function fixture() {
  const found = findKeyValues(
    '{payload:"{value:1,}", keep:true,}',
    "payload",
    defaultOptions,
  );
  assert.equal(found.matches.length, 1);
  const match = found.matches[0];
  const result = processJson(
    found.preparation.output.slice(match.start, match.end),
    defaultOptions,
  );
  assert.equal(result.success, true);
  assert.ok(found.preparation.stages.length);
  assert.ok(result.stages.length);
  return { preparation: found.preparation, result };
}

function verifyRepair(stage: RepairStage) {
  let text = stage.before;
  for (const change of [...stage.changes].reverse()) {
    assert.equal(change.stageId, stage.id);
    assert.equal(stage.before.slice(change.start, change.end), change.before);
    text = text.slice(0, change.start) + change.after + text.slice(change.end);
  }
  assert.equal(text, stage.after);
}

function freeze(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) freeze(nested);
  Object.freeze(value);
}

test("source and extracted repairs with identical original IDs stay distinct and reversible", () => {
  const { preparation, result } = fixture();
  assert.equal(preparation.stages[0].id, result.stages[0].id);
  assert.equal(
    preparation.stages[0].changes[0].id,
    result.stages[0].changes[0].id,
  );
  const records = collectRepairRecords(result, preparation);
  assert.deepEqual(
    records.stages.map((stage) => stage.origin),
    ["source", "extracted"],
  );
  assert.ok(records.stages[0].id.startsWith("source:"));
  assert.ok(records.stages[1].id.startsWith("extracted:"));
  assert.equal(new Set(records.stages.map((stage) => stage.id)).size, 2);
  assert.equal(
    new Set(records.changes.map((change) => change.id)).size,
    records.changes.length,
  );
  for (const stage of records.stages) verifyRepair(stage);
  assert.equal(records.changeCount, records.changes.length);
  assert.deepEqual(getRepairSummary(result, preparation), {
    stageCount: 2,
    changeCount: records.changes.length,
  });
});

test("formatting the whole source keeps its existing IDs and counts each repair once", () => {
  const { preparation } = fixture();
  const records = collectRepairRecords(preparation);
  assert.equal(records.stages.length, preparation.stages.length);
  assert.deepEqual(
    records.changes.map((change) => change.id),
    preparation.stages.flatMap((stage) =>
      stage.changes.map((change) => change.id),
    ),
  );
  assert.deepEqual(
    records.stages.map((stage) => stage.id),
    preparation.stages.map((stage) => stage.id),
  );
  assert.ok(records.stages.every((stage) => stage.origin === "source"));
  assert.equal(records.changeCount, preparation.changeCount);
  assert.deepEqual(getRepairSummary(preparation), {
    stageCount: preparation.stages.length,
    changeCount: preparation.changeCount,
  });
});

test("truncated or unknown nonempty repair sets retain stages and make the total unknown", () => {
  const { preparation, result } = fixture();
  for (const uncertain of [
    {
      ...result,
      changeCount: 0,
      stages: result.stages.map((stage) => ({
        ...stage,
        changes: [],
        diffTruncated: true,
      })),
    },
    { ...result, changeCount: null },
  ]) {
    const records = collectRepairRecords(uncertain, preparation);
    assert.equal(records.stages.length, 2);
    assert.equal(records.changeCount, null);
    assert.equal(getRepairSummary(uncertain, preparation).changeCount, null);
    assert.ok(records.changes.some((change) => change.origin === "source"));
  }
  assert.equal(
    collectRepairRecords({ ...result, changeCount: 999 }).changeCount,
    result.stages.reduce((sum, stage) => sum + stage.changes.length, 0),
  );
});

test("partial extracted failures retain both source repairs and any completed value repairs", () => {
  const { preparation, result } = fixture();
  const failure: ProcessingResult = {
    ...result,
    success: false,
    output: "",
    error: { message: "Later processing failed" },
  };
  const records = collectRepairRecords(failure, preparation);
  assert.equal(records.stages.length, 2);
  assert.ok(records.changes.some((change) => change.origin === "extracted"));
  const noValue = { ...failure, stages: [], changeCount: null };
  assert.equal(
    collectRepairRecords(noValue, preparation).changeCount,
    preparation.changeCount,
  );
  assert.equal(collectRepairRecords(undefined, preparation).stages.length, 1);
  assert.deepEqual(collectRepairRecords(), {
    stages: [],
    changes: [],
    changeCount: 0,
    sourceDecodedLayers: 0,
  });
});

test("source decoding without source repairs still gives the value its own namespace", () => {
  const { result } = fixture();
  const preparation = processJson(
    JSON.stringify('{"payload":1}'),
    defaultOptions,
  );
  assert.equal(preparation.stages.length, 0);
  assert.equal(preparation.decodedLayers, 1);
  const records = collectRepairRecords(result, preparation);
  assert.equal(records.sourceDecodedLayers, 1);
  assert.ok(records.stages.every((stage) => stage.origin === "extracted"));
  assert.ok(records.stages.every((stage) => stage.id.startsWith("extracted:")));
});

test("collecting preserves nested paths, exact text, layers and frozen inputs", () => {
  const { preparation } = fixture();
  const result = processStructuredJson(
    JSON.stringify({ nested: ["{id:1,}", '{label:"😀",}'] }),
    defaultOptions,
  );
  const previous = structuredClone({ result, preparation });
  freeze(result);
  freeze(preparation);
  const records = collectRepairRecords(result, preparation);
  const nested = records.stages.filter((stage) => stage.origin === "extracted");
  assert.deepEqual(
    nested.map((stage) => stage.path),
    ["$.nested[0]", "$.nested[1]"],
  );
  for (const [index, stage] of nested.entries()) {
    const original = result.stages[index];
    assert.equal(stage.before, original.before);
    assert.equal(stage.after, original.after);
    assert.equal(stage.layer, original.layer);
    assert.equal(stage.diffTruncated, original.diffTruncated);
    assert.deepEqual(
      stage.changes.map(({ start, end, line, column, path, layer }) => ({
        start,
        end,
        line,
        column,
        path,
        layer,
      })),
      original.changes.map(({ start, end, line, column, path, layer }) => ({
        start,
        end,
        line,
        column,
        path,
        layer,
      })),
    );
    verifyRepair(stage);
  }
  assert.deepEqual({ result, preparation }, previous);
  assert.equal(
    getRepairSummary(result, preparation).stageCount,
    records.stages.length,
  );
});
