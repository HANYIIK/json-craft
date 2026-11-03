import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { processJson } from "../../../src/core/json/json";
import { defaultOptions, type RepairStage } from "../../../src/shared/types";
import {
  nativeRepairChanges,
  longJsonLines,
  precedingLongLine,
  intersectLineGaps,
  matchedLongJsonLines,
  pairedDiffPosition,
  unchangedDiffRange,
  repairChangeChunk,
  repairDifferenceIndex,
  repairDiffLineCounts,
  validatedRepairChanges,
} from "../../../src/renderer/features/repair-diff/repair-diff-model";

function stage(
  before: string,
  edits: { start: number; end: number; after: string }[],
): RepairStage {
  const changes = edits.map((edit, index) => ({
    ...edit,
    id: `change-${index}`,
    before: before.slice(edit.start, edit.end),
    label: "test",
    line: 1,
    column: edit.start + 1,
    layer: 0,
    stageId: "repair",
  }));
  let after = before;
  for (const change of [...changes].reverse())
    after =
      after.slice(0, change.start) + change.after + after.slice(change.end);
  return {
    id: "repair",
    layer: 0,
    before,
    after,
    changes,
    diffTruncated: false,
  };
}

test("validates grouped edits at the start, in UTF-16 text, and at EOF", () => {
  const source = "a😀bc尾";
  const input = stage(source, [
    { start: 0, end: 0, after: "{" },
    { start: 1, end: 3, after: "换" },
    { start: 4, end: 5, after: "" },
    { start: source.length, end: source.length, after: "}" },
  ]);
  const changes = validatedRepairChanges(input);
  assert.ok(changes);
  assert.equal(changes.length, 4);
  let offsetA = 0;
  let offsetB = 0;
  for (const change of changes) {
    assert.equal(
      input.before.slice(offsetA, change.fromA),
      input.after.slice(offsetB, change.fromB),
    );
    assert.equal(
      input.after.slice(change.fromB, change.toB),
      input.changes.find((original) => original.id === change.id)?.after,
    );
    offsetA = change.toA;
    offsetB = change.toB;
  }
  assert.equal(input.before.slice(offsetA), input.after.slice(offsetB));
});

test("keeps every repair group navigable when native presentation combines a line", () => {
  const result = processJson('{"a":1 "b":2 "c":3}', defaultOptions);
  assert.equal(result.success, true);
  const repair = result.stages[0];
  const changes = validatedRepairChanges(repair);
  assert.ok(changes);
  assert.equal(changes.length, 2);
  const chunks = Chunk.build(
    Text.of(repair.before.split("\n")),
    Text.of(repair.after.split("\n")),
    { override: () => nativeRepairChanges(changes) },
  );
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    changes.map((change) => repairChangeChunk(chunks, change)),
    [0, 0],
  );
  assert.notEqual(changes[0].fromA, changes[1].fromA);
});

test("rejects incomplete, overlapping, corrupt, duplicate-ID and truncated edits", () => {
  const valid = stage("abcdef", [
    { start: 1, end: 2, after: "X" },
    { start: 4, end: 5, after: "Y" },
  ]);
  assert.ok(validatedRepairChanges(valid));
  assert.equal(validatedRepairChanges({ ...valid, diffTruncated: true }), null);
  assert.equal(validatedRepairChanges({ ...valid, changes: [] }), null);
  assert.equal(
    validatedRepairChanges({ ...valid, after: valid.after + "x" }),
    null,
  );
  assert.equal(
    validatedRepairChanges({
      ...valid,
      changes: valid.changes.map((change) => ({ ...change, id: "duplicate" })),
    }),
    null,
  );
  for (const patch of [
    { start: -1 },
    { end: 99 },
    { start: 1.5 },
    { before: "wrong" },
    { after: "wrong" },
    { end: 0 },
  ])
    assert.equal(
      validatedRepairChanges({
        ...valid,
        changes: [{ ...valid.changes[0], ...patch }, valid.changes[1]],
      }),
      null,
    );
  assert.equal(
    validatedRepairChanges({ ...valid, changes: [...valid.changes].reverse() }),
    null,
  );
  assert.deepEqual(validatedRepairChanges(stage("same", [])), []);
});

test("preserves CRLF, duplicate keys and raw numeric literals in exact comparison", () => {
  const before = '{\r\n"id":9007199254740993 "id":1e+12\r\n}';
  const input = stage(before, [
    {
      start: before.indexOf(' "id"'),
      end: before.indexOf(' "id"'),
      after: ",",
    },
  ]);
  const changes = validatedRepairChanges(input);
  assert.ok(changes);
  const doc = (value: string) =>
    EditorState.create({
      doc: value,
      extensions: EditorState.lineSeparator.of("\n"),
    }).doc;
  assert.equal(doc(input.before).toString(), input.before);
  assert.equal(doc(input.after).toString(), input.after);
  const chunks = Chunk.build(doc(input.before), doc(input.after), {
    override: (a, b) => {
      assert.equal(a, input.before);
      assert.equal(b, input.after);
      return nativeRepairChanges(changes);
    },
  });
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    repairDiffLineCounts(chunks, doc(input.before), doc(input.after)),
    { addedLines: 1, removedLines: 1 },
  );
});

test("counts inserted and deleted lines without counting a trailing newline sentinel", () => {
  for (const [before, after, expected] of [
    ["", "x\n", { addedLines: 1, removedLines: 0 }],
    ["x\n", "", { addedLines: 0, removedLines: 1 }],
    ["x", "x\n", { addedLines: 1, removedLines: 1 }],
    ["x\n", "x", { addedLines: 1, removedLines: 1 }],
    ["same", "same", { addedLines: 0, removedLines: 0 }],
    ["\na\nb", "\nx\ny", { addedLines: 2, removedLines: 2 }],
  ] as const) {
    const a = Text.of(before.split("\n"));
    const b = Text.of(after.split("\n"));
    assert.deepEqual(repairDiffLineCounts(Chunk.build(a, b), a, b), expected);
  }
});

test("maps change navigation to chunks and accepts the last-item request", () => {
  const input = stage("a\nb\nc\nd\ne\nf\ng\nh", [
    { start: 2, end: 3, after: "new" },
    { start: 14, end: 15, after: "last" },
  ]);
  const changes = validatedRepairChanges(input)!;
  const chunks = Chunk.build(
    Text.of(input.before.split("\n")),
    Text.of(input.after.split("\n")),
    { override: () => nativeRepairChanges(changes) },
  );
  assert.deepEqual(
    changes.map((change) => repairChangeChunk(chunks, change)),
    [0, 1],
  );
  assert.equal(repairDifferenceIndex(-1, 2), 1);
  assert.equal(repairDifferenceIndex(30, 2), 1);
  assert.equal(repairDifferenceIndex(-5, 2), 0);
  assert.equal(repairDifferenceIndex(0, 0), -1);
  assert.equal(repairDifferenceIndex(NaN, 2), 0);
  assert.equal(repairChangeChunk([], changes[0]), -1);
});

test("indexes long logical lines and finds the preceding measurement anchor", () => {
  const doc = Text.of([
    "short",
    "中".repeat(10_000),
    "tail",
    "x".repeat(20_000),
    "last",
  ]);
  const lines = longJsonLines(doc);
  assert.deepEqual(lines, [
    { from: 6, to: 10_006 },
    { from: 10_012, to: 30_012 },
  ]);
  assert.equal(precedingLongLine(lines, 0), undefined);
  assert.equal(precedingLongLine(lines, 10_005), undefined);
  assert.equal(precedingLongLine(lines, 10_006), lines[0]);
  assert.equal(precedingLongLine(lines, 15_000), lines[0]);
  assert.equal(precedingLongLine(lines, doc.length), lines[1]);
});

test("shares only mutually hidden ranges while preserving either side's visible targets", () => {
  const gap = (from: number, to: number, density: number) => ({
    from,
    to,
    size: (to - from) * density,
    displaySize: (to - from) * density,
  });
  const a = [gap(0, 100, 2), gap(120, 200, 2)];
  const b = [gap(0, 140, 4), gap(160, 200, 4)];
  assert.deepEqual(intersectLineGaps(a, b), [
    gap(0, 100, 2),
    gap(120, 140, 2),
    gap(160, 200, 2),
  ]);
  assert.deepEqual(intersectLineGaps(a, []), []);
  assert.deepEqual(intersectLineGaps(a, a), a);
  const shared = intersectLineGaps(
    [gap(0, 20, 1), gap(40, 100, 1)],
    [gap(0, 60, 9), gap(80, 100, 9)],
  );
  assert.equal(
    shared.some((range) => range.from < 30 && range.to > 30),
    false,
  );
  assert.equal(
    shared.some((range) => range.from < 70 && range.to > 70),
    false,
  );
});

test("pairs repeated unchanged long-line occurrences by chunk offsets rather than text identity", () => {
  const long = "x".repeat(20_001);
  const before = Text.of(["old", long, "middle", long, "tail"]);
  const after = Text.of(["new-prefix", long, "middle", long, "tail"]);
  const chunks = Chunk.build(before, after);
  const pairs = matchedLongJsonLines(before, after, chunks);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].fromA, 4);
  assert.equal(pairs[0].fromB, 11);
  assert.equal(
    pairs[1].fromA - pairs[0].fromA,
    pairs[1].fromB - pairs[0].fromB,
  );
  const changed = Text.of([
    "new-prefix",
    long.replace("xxx", "YYY"),
    "middle",
    long,
    "tail",
  ]);
  assert.equal(
    matchedLongJsonLines(before, changed, Chunk.build(before, changed)).length,
    1,
  );
});

test("maps real unchanged character anchors through separate insertion and deletion chunks", () => {
  const first = Array.from({ length: 8 }, (_, index) => `unchanged-a${index}`);
  const second = Array.from({ length: 8 }, (_, index) => `unchanged-b${index}`);
  const before = Text.of([
    "header",
    ...first,
    "remove-one",
    "remove-two",
    ...second,
    "尾部😀",
  ]);
  const after = Text.of([
    "header",
    "insert-extra-long",
    "insert-two",
    ...first,
    ...second,
    "尾部😀",
  ]);
  const chunks = Chunk.build(before, after);
  assert.equal(chunks.length, 2);
  for (const value of [
    "header",
    first[0],
    first[7],
    second[0],
    second[7],
    "尾部😀",
  ]) {
    const a = before.toString().indexOf(value);
    const b = after.toString().indexOf(value);
    for (const offset of [0, 1, value.length - 1]) {
      assert.equal(pairedDiffPosition(chunks, a + offset, true), b + offset);
      assert.equal(pairedDiffPosition(chunks, b + offset, false), a + offset);
    }
  }
  assert.equal(pairedDiffPosition(chunks, before.length, true), after.length);
  assert.equal(pairedDiffPosition(chunks, after.length, false), before.length);
});

test("maps inserted and deleted ranges to their counterpart boundary without overshooting", () => {
  const unchanged = Array.from({ length: 8 }, (_, index) => `shared-${index}`);
  const before = Text.of([
    "head",
    ...unchanged,
    "deleted-one",
    "deleted-two",
    "tail",
  ]);
  const after = Text.of([
    "head",
    "added-one",
    "added-two",
    ...unchanged,
    "tail",
  ]);
  const chunks = Chunk.build(before, after);
  const inserted = chunks.find((chunk) => chunk.fromA === chunk.toA);
  const deleted = chunks.find((chunk) => chunk.fromB === chunk.toB);
  assert.ok(inserted);
  assert.ok(deleted);
  for (const position of [inserted.fromB, inserted.fromB + 3, inserted.toB - 1])
    assert.equal(pairedDiffPosition(chunks, position, false), inserted.fromA);
  assert.equal(pairedDiffPosition(chunks, inserted.toA, true), inserted.toB);
  assert.equal(pairedDiffPosition(chunks, inserted.toB, false), inserted.toA);
  for (const position of [deleted.fromA, deleted.fromA + 3, deleted.toA - 1])
    assert.equal(pairedDiffPosition(chunks, position, true), deleted.fromB);
  assert.equal(pairedDiffPosition(chunks, deleted.toA, true), deleted.toB);
  assert.equal(pairedDiffPosition(chunks, deleted.toB, false), deleted.toA);
  assert.equal(pairedDiffPosition([], 42, true), 42);
  assert.equal(pairedDiffPosition([], 42, false), 42);
});

test("maps UTF-16 unchanged ranges on the correct side of insertion and deletion boundaries", () => {
  const input = stage("前😀AB删除CD尾", [
    { start: 3, end: 3, after: "新增" },
    { start: 5, end: 7, after: "" },
  ]);
  const changes = validatedRepairChanges(input)!;
  for (const [fromA, toA, fromB, toB] of [
    [0, 3, 0, 3],
    [3, 5, 5, 7],
    [7, 10, 7, 10],
  ]) {
    assert.deepEqual(unchangedDiffRange(changes, fromA, toA, true), {
      from: fromB,
      to: toB,
    });
    assert.deepEqual(unchangedDiffRange(changes, fromB, toB, false), {
      from: fromA,
      to: toA,
    });
    assert.equal(input.before.slice(fromA, toA), input.after.slice(fromB, toB));
  }
});

test("rejects new, deleted, empty and edit-crossing ranges instead of pairing unrelated content", () => {
  const input = stage("前😀AB删除CD尾", [
    { start: 3, end: 3, after: "新增" },
    { start: 5, end: 7, after: "" },
  ]);
  const changes = validatedRepairChanges(input)!;
  assert.equal(input.after.slice(3, 5), "新增");
  assert.equal(input.before.slice(5, 7), "删除");
  for (const [from, to, fromA] of [
    [3, 5, false],
    [4, 5, false],
    [5, 7, true],
    [6, 7, true],
    [0, 5, true],
    [3, 10, true],
    [5, 10, false],
    [3, 3, true],
    [7, 7, false],
  ] as const)
    assert.equal(unchangedDiffRange(changes, from, to, fromA), undefined);
});
