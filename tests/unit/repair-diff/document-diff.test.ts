import assert from "node:assert/strict";
import test from "node:test";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import {
  computeDocumentDiff,
  type DocumentDiffOptions,
} from "../../../src/renderer/features/repair-diff/document-diff";

function verify(before: string, after: string, options?: DocumentDiffOptions) {
  const result = computeDocumentDiff(before, after, options);
  let cursorA = 0;
  let cursorB = 0;
  let rebuilt = "";
  for (const change of result.changes) {
    assert.ok(change.fromA >= cursorA && change.toA >= change.fromA);
    assert.ok(change.fromB >= cursorB && change.toB >= change.fromB);
    assert.ok(change.toA <= before.length && change.toB <= after.length);
    assert.equal(
      before.slice(cursorA, change.fromA),
      after.slice(cursorB, change.fromB),
    );
    rebuilt +=
      before.slice(cursorA, change.fromA) +
      after.slice(change.fromB, change.toB);
    cursorA = change.toA;
    cursorB = change.toB;
  }
  assert.equal(before.slice(cursorA), after.slice(cursorB));
  assert.equal(rebuilt + before.slice(cursorA), after);
  return result;
}

test("preserves exact text, UTF-16 offsets, line endings and empty documents", () => {
  for (const [before, after] of [
    ["", ""],
    ["same\r\n😀\n", "same\r\n😀\n"],
    ["", "new😀\r\n"],
    ["old😀\r\n", ""],
    ["first\r\nlast\r\n", "first\nlast"],
    ["first\nlast", "first\nlast\n"],
    ["first\nlast\n", "first\nlast"],
    ["a😀b😃c", "a😄b🙃c"],
    ["a😀b", "a\ud83db"],
    ["a\ud83db", "a😀b"],
    ["head\nrepeat\nrepeat\nrepeat\ntail", "head\nrepeat\nnew\nrepeat\ntail"],
    ["head\na\nb\nc\ntail", "head\nx\ny\nc\ntail"],
    ["first\nsecond\nthird\nfourth", "third\nfirst\nfourth\nsecond"],
  ]) {
    const result = verify(before, after);
    assert.equal(result.precise, true);
    if (before === after) assert.equal(result.changes.length, 0);
  }
  for (const change of verify("a😀b😃c", "a😄b🙃c").changes) {
    for (const position of [change.fromA, change.toA, change.fromB, change.toB])
      assert.ok(![2, 5].includes(position));
  }
});

test("keeps dispersed edits in a 12,000-line JSON array local and navigable", () => {
  const rows = Array.from({ length: 1_000 }, (_, index) =>
    Object.fromEntries(
      Array.from({ length: 10 }, (_, field) => [
        `field${field}`,
        field === 0 ? index : `value-${index}-${field}-${"x".repeat(22)}`,
      ]),
    ),
  );
  const edited = structuredClone(rows);
  for (let index = 5; index < edited.length; index += 20)
    edited[index].field5 = `changed-${edited[index].field5}`;
  const before = JSON.stringify(rows, null, 2);
  const after = JSON.stringify(edited, null, 2);
  const result = verify(before, after);
  assert.equal(result.precise, true);
  assert.equal(result.changes.length, 50);
  const a = Text.of(before.split("\n"));
  const b = Text.of(after.split("\n"));
  const chunks = Chunk.build(a, b, { override: () => [...result.changes] });
  assert.equal(chunks.length, 50);
  assert.ok(
    chunks.every(
      (chunk) => a.lineAt(chunk.fromA).number === a.lineAt(chunk.endA).number,
    ),
  );
});

test("retains local character highlights within changed lines", () => {
  const before = 'head\n  "label": "first old middle old last",\ntail';
  const after = 'head\n  "label": "first new middle new last",\ntail';
  const result = verify(before, after);
  assert.equal(result.precise, true);
  assert.deepEqual(
    result.changes.map((change) => before.slice(change.fromA, change.toA)),
    ["old", "old"],
  );
});

test("reconstructs mixed edits among repeated lines and Unicode content", () => {
  let seed = 71;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed % limit;
  };
  const tokens = ["repeat\n", "same\r\n", "😀", "😃", "中", "a", "\n", ""];
  for (let sample = 0; sample < 100; sample++) {
    const source = Array.from(
      { length: 60 },
      () => tokens[random(tokens.length)],
    );
    const edited = [...source];
    for (let edit = 0; edit < 8; edit++)
      edited.splice(
        random(edited.length + 1),
        random(3),
        tokens[random(tokens.length)],
      );
    assert.equal(verify(source.join(""), edited.join("")).precise, true);
  }
});

test("trims giant unchanged single-line prefixes and suffixes before refinement", () => {
  const prefix = "😀same".repeat(200_000);
  const suffix = "tail😃".repeat(200_000);
  const result = verify(prefix + "old" + suffix, prefix + "new" + suffix);
  assert.equal(result.precise, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].fromA, prefix.length);
  assert.equal(result.changes[0].toA, prefix.length + 3);
});

test("marks an oversized replacement approximate while preserving aligned anchors", () => {
  const common = Array.from(
    { length: 30 },
    (_, index) => `common ${index}`,
  ).join("\n");
  const before = `start\n${"a".repeat(40_000)}\n${common}\nold\nend`;
  const after = `start\n${"b".repeat(40_000)}\n${common}\nnew\nend`;
  const result = verify(before, after);
  assert.equal(result.precise, false);
  assert.equal(result.changes.length, 2);
  assert.ok(result.changes[0].toA < before.indexOf(common));
  assert.equal(
    before.slice(result.changes[1].fromA, result.changes[1].toA),
    "old",
  );
});

test("bounds character edit complexity without claiming an exact result", () => {
  const result = verify("a".repeat(2_000), "b".repeat(2_000));
  assert.equal(result.precise, false);
  assert.equal(result.changes.length, 1);
});

test("bounds line edit complexity for unrelated large documents", () => {
  const before = Array.from(
    { length: 3_000 },
    (_, index) => `before ${index}`,
  ).join("\n");
  const after = Array.from(
    { length: 3_000 },
    (_, index) => `after ${index}`,
  ).join("\n");
  const start = performance.now();
  const result = verify(before, after);
  assert.equal(result.precise, false);
  assert.equal(result.changes.length, 1);
  assert.ok(performance.now() - start < 1_000);
});

test("makes total budget exhaustion explicit and preserves both documents", () => {
  const result = verify("head\nold\ntail", "head\nnew\ntail", { timeout: 0 });
  assert.equal(result.precise, false);
  assert.equal(result.changes.length, 1);
});

test("retains unique line anchors even after the diff budget is exhausted", () => {
  const before = "old\nunique anchor one\nold\nunique anchor two\nold";
  const after = "new\nunique anchor one\nnew\nunique anchor two\nnew";
  const result = verify(before, after, { timeout: 0 });
  assert.equal(result.precise, false);
  assert.equal(result.changes.length, 3);
  assert.ok(result.changes.every((change) => change.toA - change.fromA === 3));
});
