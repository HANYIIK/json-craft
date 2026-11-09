import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "@codemirror/merge";
import { EditorState, Text } from "@codemirror/state";
import { processJson } from "../../../src/core/json/json";
import { defaultOptions, type RepairStage } from "../../../src/shared/types";
import {
  nativeRepairChanges,
  mapProjectedChunks,
  repairChunkRange,
  unchangedDiffRange,
  repairChangeChunk,
  repairDifferenceIndex,
  repairDiffLineCounts,
  alignedDiffRows,
  validatedRepairChanges,
} from "../../../src/renderer/features/repair-diff/repair-diff-model";
import { projectDiffTexts } from "../../../src/renderer/features/repair-diff/diff-text-projection";

test("budgets the combined aligned height of insertions on opposite sides", () => {
  const common = Array.from(
    { length: 12 },
    (_, index) => `common unchanged row ${index}`,
  );
  const before = Text.of(["start", "left-1", "left-2", ...common, "tail"]);
  const after = Text.of(["start", ...common, "right-1", "right-2", "tail"]);
  const chunks = Chunk.build(before, after);
  assert.equal(chunks.length, 2);
  assert.equal(alignedDiffRows(chunks, before, after), before.lines + 2);
  assert.equal(alignedDiffRows([], before, before), before.lines);
});

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

test("separate projected hunks map to exact source edits within one giant logical line", () => {
  const before = JSON.stringify({ payload: "x ".repeat(12_000) });
  const first = before.indexOf("x ");
  const input = stage(before, [
    { start: first + 1_000, end: first + 1_001, after: "A" },
    { start: first + 18_000, end: first + 18_001, after: "B" },
  ]);
  const exact = validatedRepairChanges(input)!;
  const sourceA = Text.of(input.before.split("\n"));
  const sourceB = Text.of(input.after.split("\n"));
  const sourceChunks = Chunk.build(sourceA, sourceB, {
    override: () => nativeRepairChanges(exact),
  });
  assert.equal(sourceChunks.length, 1);
  const originalChunks = JSON.stringify(sourceChunks);
  const projected = projectDiffTexts(
    input.before,
    input.after,
    nativeRepairChanges(exact),
    true,
    {
      width: 80,
      measure: (text) => text.length,
    },
  );
  const displayChunks = Chunk.build(projected.a.doc, projected.b.doc, {
    override: () => projected.changes,
  });
  assert.equal(displayChunks.length, 2);
  const originalDisplay = JSON.stringify(displayChunks);
  const mapped = mapProjectedChunks(displayChunks, projected.a, projected.b);
  assert.deepEqual(
    mapped.map(repairChunkRange),
    exact.map(({ fromA, toA, fromB, toB }) => ({ fromA, toA, fromB, toB })),
  );
  for (let index = 0; index < mapped.length; index++) {
    const original = displayChunks[index];
    const chunk = mapped[index];
    assert.equal(chunk.fromA, projected.a.toSource(original.fromA));
    assert.equal(chunk.endA, projected.a.toSource(original.endA));
    assert.equal(chunk.fromB, projected.b.toSource(original.fromB));
    assert.equal(chunk.endB, projected.b.toSource(original.endB));
    assert.equal(chunk.precise, original.precise);
    assert.ok(repairChunkRange(chunk).toA - repairChunkRange(chunk).fromA < 80);
  }
  assert.deepEqual(
    exact.map((change) => repairChangeChunk(mapped, change)),
    [0, 1],
  );
  assert.deepEqual(repairDiffLineCounts(sourceChunks, sourceA, sourceB), {
    addedLines: 1,
    removedLines: 1,
  });
  assert.equal(JSON.stringify(sourceChunks), originalChunks);
  assert.equal(JSON.stringify(displayChunks), originalDisplay);
  assert.equal(projected.a.source, input.before);
  assert.equal(projected.b.source, input.after);
});

test("mapped chunk boundaries preserve empty sides, end sentinels and precise flags", () => {
  for (const [before, after] of [
    ["", "x".repeat(10_000)],
    ["x".repeat(10_000), ""],
    ["x", "xy\n"],
    ["x\n", "x"],
  ]) {
    const sourceA = Text.of(before.split("\n"));
    const sourceB = Text.of(after.split("\n"));
    const original = Chunk.build(sourceA, sourceB);
    const changes = original.flatMap((chunk) =>
      chunk.changes.map((change) => ({
        ...change,
        id: "test",
        fromA: chunk.fromA + change.fromA,
        toA: chunk.fromA + change.toA,
        fromB: chunk.fromB + change.fromB,
        toB: chunk.fromB + change.toB,
      })),
    );
    const projected = projectDiffTexts(
      before,
      after,
      nativeRepairChanges(changes),
    );
    const display = Chunk.build(projected.a.doc, projected.b.doc, {
      override: () => projected.changes,
    }).map(
      (chunk) =>
        new Chunk(
          chunk.changes,
          chunk.fromA,
          chunk.toA,
          chunk.fromB,
          chunk.toB,
          false,
        ),
    );
    const mapped = mapProjectedChunks(display, projected.a, projected.b);
    assert.ok(mapped.every((chunk) => chunk.precise === false));
    for (let index = 0; index < display.length; index++) {
      const chunk = display[index];
      const mappedChunk = mapped[index];
      assert.equal(
        mappedChunk.fromA === mappedChunk.toA,
        chunk.fromA === chunk.toA,
      );
      assert.equal(
        mappedChunk.fromB === mappedChunk.toB,
        chunk.fromB === chunk.toB,
      );
      assert.equal(mappedChunk.endA, projected.a.toSource(chunk.endA));
      assert.equal(mappedChunk.endB, projected.b.toSource(chunk.endB));
    }
  }
});

test("actual chunk ranges use the first and last relative change or empty fallback", () => {
  const input = stage("a\nb\nc\nd", [{ start: 2, end: 3, after: "new" }]);
  const exact = validatedRepairChanges(input)!;
  const native = Chunk.build(
    Text.of(input.before.split("\n")),
    Text.of(input.after.split("\n")),
    { override: () => nativeRepairChanges(exact) },
  );
  const identity = projectDiffTexts(
    input.before,
    input.after,
    nativeRepairChanges(exact),
    false,
  );
  assert.equal(mapProjectedChunks(native, identity.a, identity.b), native);
  assert.deepEqual(repairChunkRange(new Chunk([], 3, 8, 10, 10, false)), {
    fromA: 3,
    toA: 7,
    fromB: 10,
    toB: 10,
  });
  assert.deepEqual(repairChunkRange(native[0]), {
    fromA: 2,
    toA: 3,
    fromB: 2,
    toB: 5,
  });
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
