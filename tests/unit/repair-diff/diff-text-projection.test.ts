import assert from "node:assert/strict";
import test from "node:test";
import { Change, Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import {
  DiffTextProjection,
  projectDiffTexts,
} from "../../../src/renderer/features/repair-diff/diff-text-projection";

function edit(
  before: string,
  edits: readonly { from: number; to: number; insert: string }[],
) {
  const parts: string[] = [];
  const changes: Change[] = [];
  let cursor = 0;
  let offset = 0;
  for (const item of edits) {
    parts.push(before.slice(cursor, item.from), item.insert);
    changes.push(
      new Change(
        item.from,
        item.to,
        item.from + offset,
        item.from + offset + item.insert.length,
      ),
    );
    cursor = item.to;
    offset += item.insert.length - (item.to - item.from);
  }
  parts.push(before.slice(cursor));
  return { before, after: parts.join(""), changes };
}

function verifyProjection(projection: DiffTextProjection, exhaustive = true) {
  const rebuilt: string[] = [];
  let cursor = 0;
  for (let index = 0; index < projection.breaks.length; index++) {
    const point = projection.breaks[index];
    const display = point + index;
    assert.equal(projection.doc.sliceString(display, display + 1), "\n");
    assert.equal(projection.toDisplay(point, -1), display);
    assert.equal(projection.toDisplay(point, 1), display + 1);
    assert.equal(projection.toSource(display), point);
    assert.equal(projection.toSource(display + 1), point);
    const previous = projection.source.charCodeAt(point - 1);
    const current = projection.source.charCodeAt(point);
    assert.ok(
      !(
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        current >= 0xdc00 &&
        current <= 0xdfff
      ),
    );
    rebuilt.push(projection.doc.sliceString(cursor, display));
    cursor = display + 1;
  }
  rebuilt.push(projection.doc.sliceString(cursor));
  assert.equal(rebuilt.join(""), projection.source);
  assert.equal(projection.sourceDoc.toString(), projection.source);
  const step = exhaustive ? 1 : 97;
  for (
    let position = 0;
    position <= projection.source.length;
    position += step
  ) {
    assert.equal(projection.toSource(projection.toDisplay(position)), position);
    assert.equal(
      projection.toSource(projection.toDisplay(position, -1)),
      position,
    );
  }
  assert.equal(
    projection.toSource(projection.doc.length),
    projection.source.length,
  );
}

function verifyChanges(
  input: ReturnType<typeof edit>,
  projected: ReturnType<typeof projectDiffTexts>,
) {
  const before = projected.a.doc.toString();
  const after = projected.b.doc.toString();
  let cursorA = 0;
  let cursorB = 0;
  for (let index = 0; index < input.changes.length; index++) {
    const source = input.changes[index];
    const change = projected.changes[index];
    assert.equal(
      before.slice(cursorA, change.fromA),
      after.slice(cursorB, change.fromB),
    );
    assert.equal(projected.a.toSource(change.fromA), source.fromA);
    assert.equal(projected.a.toSource(change.toA), source.toA);
    assert.equal(projected.b.toSource(change.fromB), source.fromB);
    assert.equal(projected.b.toSource(change.toB), source.toB);
    assert.ok(!projected.a.breaks.includes(source.fromA));
    assert.ok(!projected.a.breaks.includes(source.toA));
    assert.ok(!projected.b.breaks.includes(source.fromB));
    assert.ok(!projected.b.breaks.includes(source.toB));
    cursorA = change.toA;
    cursorB = change.toB;
  }
  assert.equal(before.slice(cursorA), after.slice(cursorB));
}

test("short text and disabled projection retain identity documents and changes", () => {
  for (const input of [
    edit("one\r\ntwo\n", []),
    edit("x".repeat(20_000), []),
  ]) {
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
      false,
    );
    assert.equal(projected.a.active, false);
    assert.equal(projected.a.doc, projected.a.sourceDoc);
    assert.equal(projected.changes, input.changes);
    verifyProjection(projected.a);
  }
  const projected = projectDiffTexts("{\n}", "{\n}", []);
  assert.equal(projected.a.active, false);
  assert.equal(projected.a, projected.b);
});

test("identical escaped Unicode text gets bounded display rows with lossless offsets", () => {
  const source = JSON.stringify(
    { payload: '中文 "quoted" 😀 content '.repeat(1_000) },
    null,
    2,
  );
  const projected = projectDiffTexts(source, source, []);
  assert.equal(projected.a.active, true);
  assert.equal(projected.a, projected.b);
  assert.ok(
    [...projected.a.doc.iterLines()].every((line) => line.length <= 1_025),
  );
  verifyProjection(projected.a);
});

test("the long-line threshold and explicit position associations remain stable", () => {
  assert.equal(
    projectDiffTexts("x".repeat(8_191), "x".repeat(8_191), []).a.active,
    false,
  );
  assert.equal(
    projectDiffTexts("x".repeat(8_192), "x".repeat(8_192), []).a.active,
    true,
  );
  const projection = new DiffTextProjection("abcdef", [2, 4]);
  assert.equal(projection.doc.toString(), "ab\ncd\nef");
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((position) =>
      projection.toSource(position),
    ),
    [0, 1, 2, 2, 3, 4, 4, 5, 6],
  );
  assert.equal(projection.toDisplay(-10), 0);
  assert.equal(projection.toDisplay(Infinity), projection.doc.length);
  assert.equal(projection.toSource(Infinity), projection.source.length);
  verifyProjection(projection);
});

test("insertions, deletions and replacements at segment boundaries add no false differences", () => {
  const source = "a".repeat(25_000);
  for (const edits of [
    [{ from: 1_024, to: 1_024, insert: "X" }],
    [{ from: 2_048, to: 2_049, insert: "" }],
    [{ from: 8_192, to: 8_197, insert: "replacement" }],
    [
      { from: 0, to: 0, insert: "prefix" },
      { from: 25_000, to: 25_000, insert: "suffix" },
    ],
    [{ from: 1_024, to: 8_192, insert: "" }],
    [{ from: 1_024, to: 3_072, insert: "new".repeat(4_000) }],
  ]) {
    const input = edit(source, edits);
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
    );
    verifyChanges(input, projected);
    verifyProjection(projected.a);
    verifyProjection(projected.b);
  }
});

test("one-sided whole-file insertion and deletion remain mapped to the real source", () => {
  for (const input of [
    edit("", [{ from: 0, to: 0, insert: '😀\\"中文'.repeat(3_000) }]),
    edit("x".repeat(20_000), [{ from: 0, to: 20_000, insert: "" }]),
  ]) {
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
    );
    verifyChanges(input, projected);
    verifyProjection(projected.a);
    verifyProjection(projected.b);
  }
});

test("real CRLF line numbers survive artificial continuation rows", () => {
  const source = "first\r\n" + "中文😀\\n".repeat(2_000) + "\r\nthird\r\n";
  const projected = projectDiffTexts(source, source, []).a;
  const labels = Array.from({ length: projected.doc.lines }, (_, index) =>
    projected.lineNumber(index + 1),
  );
  assert.deepEqual(labels.filter(Boolean), ["1", "2", "3", "4"]);
  assert.equal(
    labels.filter((label) => label === "").length,
    projected.breaks.length,
  );
  verifyProjection(projected);
});

test("line-number gutter sizing accepts synthetic numbers outside the display document", () => {
  const source =
    Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n") +
    "\n" +
    "x".repeat(20_000) +
    "\nlast";
  const projection = projectDiffTexts(source, source, []).a;
  for (const dummy of [0, -1, 9_999, 99_999, Infinity, NaN])
    assert.equal(projection.lineNumber(dummy), "32");
  assert.equal(projection.lineNumber(1), "1");
  assert.equal(projection.lineNumber(31), "31");
  assert.equal(projection.lineNumber(32), "");
  assert.equal(projection.lineNumber(projection.doc.lines), "32");
  assert.equal(new DiffTextProjection("").lineNumber(9_999), "1");
});

test("newlines inserted and removed around long lines preserve unchanged intervals", () => {
  const source =
    "first\n" + "x".repeat(12_000) + "\n" + "y".repeat(12_000) + "\nend";
  const input = edit(source, [
    { from: 2, to: 3, insert: "\r\n" },
    { from: 6 + 6_000, to: 6 + 6_000, insert: "\n" },
    { from: 12_006, to: 12_007, insert: "" },
  ]);
  const projected = projectDiffTexts(input.before, input.after, input.changes);
  verifyChanges(input, projected);
  verifyProjection(projected.a);
  verifyProjection(projected.b);
});

test("dense edits with changed line lengths keep mirrored cuts and boundary mappings consistent", () => {
  const source = '中文😀\\\"data'.repeat(4_000);
  const edits = Array.from({ length: 80 }, (_, index) => ({
    from: 513 + index * 400,
    to: 514 + index * 400,
    insert: index % 3 ? "value" : "",
  }));
  const input = edit(source, edits);
  const projected = projectDiffTexts(input.before, input.after, input.changes);
  verifyChanges(input, projected);
  verifyProjection(projected.a);
  verifyProjection(projected.b);
});

test("edit boundaries on every preferred cut cannot remove all long-line segmentation", () => {
  const source = "x".repeat(25_000);
  const input = edit(
    source,
    Array.from({ length: 24 }, (_, index) => ({
      from: (index + 1) * 1_024,
      to: (index + 1) * 1_024 + 1,
      insert: "y",
    })),
  );
  const projected = projectDiffTexts(input.before, input.after, input.changes);
  assert.equal(projected.a.active, true);
  assert.equal(projected.b.active, true);
  assert.ok(
    [...projected.a.doc.iterLines()].every((line) => line.length <= 1_026),
  );
  assert.ok(
    [...projected.b.doc.iterLines()].every((line) => line.length <= 1_026),
  );
  verifyChanges(input, projected);
  verifyProjection(projected.a);
  verifyProjection(projected.b);
});

test("mixed Unicode and newline edit combinations retain equality outside every projected change", () => {
  let seed = 915_493;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const inserts = ["", "x", "😀", "\r\n", '中文\\\"', "\n" + "y".repeat(1_500)];
  for (let sample = 0; sample < 40; sample++) {
    const source =
      "header\r\n" + '中文😀\\\"escaped'.repeat(1_400 + sample) + "\nfooter";
    const edits = Array.from({ length: 12 }, (_, index) => {
      const from = 20 + index * 1_200 + (random() % 400);
      return {
        from,
        to: from + (random() % 4),
        insert: inserts[random() % inserts.length],
      };
    });
    const input = edit(source, edits);
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
    );
    verifyChanges(input, projected);
    verifyProjection(projected.a, false);
    verifyProjection(projected.b, false);
  }
});

function measure(text: string) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    width +=
      character === "\r" ? 0 : character === "\t" ? 4 : code > 0x7f ? 2 : 1;
  }
  return width;
}

test("visual projection fits every source line to its pane without native soft wrapping", () => {
  const source =
    "header 中文\r\n" +
    '中文😀\\\"value '.repeat(1_000) +
    "\nordinary " +
    "x".repeat(300) +
    "\nfooter\t中文";
  for (const width of [16, 39, 80, 240]) {
    const projected = projectDiffTexts(source, source, [], true, {
      width,
      measure,
    });
    assert.equal(projected.a.active, true);
    assert.ok(
      [...projected.a.doc.iterLines()].every((line) => measure(line) <= width),
    );
    verifyProjection(projected.a, false);
    assert.deepEqual(
      Array.from({ length: projected.a.doc.lines }, (_, index) =>
        projected.a.lineNumber(index + 1),
      ).filter(Boolean),
      ["1", "2", "3", "4"],
    );
  }
  const short = "x".repeat(200);
  const identity = projectDiffTexts(short, short, [], true, {
    width: 16,
    measure,
  });
  assert.equal(identity.a.active, false);
});

test("visual projection mirrors changed rows at multiple widths and avoids edit boundaries", () => {
  const source = '中文😀\\\"value'.repeat(1_400);
  const input = edit(source, [
    { from: 32, to: 33, insert: "longer value" },
    { from: 1_024, to: 1_024, insert: "\n" },
    { from: 5_120, to: 5_122, insert: "" },
    { from: 10_240, to: 10_244, insert: "中文😀" },
  ]);
  let previousLines = Infinity;
  for (const width of [15, 29, 51, 100]) {
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
      true,
      { width, measure },
    );
    verifyChanges(input, projected);
    verifyProjection(projected.a, false);
    verifyProjection(projected.b, false);
    for (const value of [projected.a, projected.b])
      assert.ok(
        [...value.doc.iterLines()].every((line) => measure(line) <= width + 2),
      );
    assert.ok(projected.a.doc.lines <= previousLines);
    previousLines = projected.a.doc.lines;
  }
});

test("visual metrics are cached by codepoint across both documents", () => {
  const before = '中文😀\\\"value'.repeat(2_000);
  const input = edit(before, [{ from: 2_000, to: 2_001, insert: "q" }]);
  let measurements = 0;
  const projected = projectDiffTexts(
    input.before,
    input.after,
    input.changes,
    true,
    {
      width: 40,
      measure: (text) => {
        measurements++;
        return measure(text);
      },
    },
  );
  assert.ok(measurements <= new Set([...before, ...input.after]).size + 2);
  verifyChanges(input, projected);
});

test("visual projection keeps segment safety limits with very large layout widths", () => {
  const source = "😀".repeat(10_000);
  const projected = projectDiffTexts(source, source, [], true, {
    width: 100_000,
    measure,
  });
  assert.ok(
    [...projected.a.doc.iterLines()].every((line) => line.length <= 1_024),
  );
  verifyProjection(projected.a);
});

test("one character inserted into a long line adds only bounded seam rows", () => {
  const source = "x".repeat(100_000);
  const input = edit(source, [{ from: 50_000, to: 50_000, insert: "y" }]);
  for (const layout of [undefined, { width: 80, measure }]) {
    const beforePlan = projectDiffTexts(source, source, [], true, layout).a;
    const afterPlan = projectDiffTexts(
      input.after,
      input.after,
      [],
      true,
      layout,
    ).a;
    const maximum = Math.max(beforePlan.doc.lines, afterPlan.doc.lines) + 4;
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
      true,
      layout,
    );
    assert.ok(projected.a.doc.lines <= maximum);
    assert.ok(projected.b.doc.lines <= maximum);
    for (const value of [projected.a, projected.b]) {
      if (layout)
        assert.ok(
          [...value.doc.iterLines()].every(
            (line) => measure(line) <= layout.width,
          ),
        );
      else
        assert.ok(
          [...value.doc.iterLines()].every((line) => line.length <= 1_024),
        );
      verifyProjection(value, false);
    }
    verifyChanges(input, projected);
  }
});

test("a short-side line also keeps bounded rows when its peer gains a long insertion", () => {
  const source = "x".repeat(8_000);
  const input = edit(source, [
    { from: 3_000, to: 3_000, insert: "y".repeat(10_000) },
  ]);
  const projected = projectDiffTexts(input.before, input.after, input.changes);
  assert.equal(projected.a.active, true);
  for (const value of [projected.a, projected.b]) {
    assert.ok([...value.doc.iterLines()].every((line) => line.length <= 1_024));
    verifyProjection(value, false);
  }
  verifyChanges(input, projected);
});

test("fallback word boundaries keep short underscore markers on one display row", () => {
  const marker = "ASCII_BUDGET_MIDDLEsynthetic";
  const source =
    "x ".repeat(503) + marker + " synthetic content ".repeat(1_000);
  const hard = projectDiffTexts(source, source, [], true, {
    width: 1_024,
    measure: () => 1,
  }).a;
  const start = source.indexOf(marker);
  assert.notEqual(
    hard.doc.lineAt(hard.toDisplay(start)).number,
    hard.doc.lineAt(hard.toDisplay(start + marker.length, -1) - 1).number,
  );
  const preferred = projectDiffTexts(source, source, [], true, {
    width: 1_024,
    measure: () => 1,
    preferWordBoundaries: true,
  }).a;
  const from = preferred.toDisplay(start);
  const to = preferred.toDisplay(start + marker.length, -1);
  assert.equal(
    preferred.doc.lineAt(from).number,
    preferred.doc.lineAt(to - 1).number,
  );
  assert.equal(preferred.doc.sliceString(from, to), marker);
  assert.ok(
    [...preferred.doc.iterLines()].every((line) => line.length <= 1_024),
  );
  verifyProjection(preferred, false);
});

test("canonical change mirroring preserves whole fallback markers without loosening row limits", () => {
  const marker = "ASCII_BUDGET_MIDDLEsynthetic";
  const source =
    "x ".repeat(503) + marker + " synthetic content ".repeat(1_000);
  for (const edits of [
    [{ from: 500, to: 500, insert: "y" }],
    [{ from: 500, to: 501, insert: "" }],
    [{ from: 500, to: 505, insert: "new $value" }],
  ]) {
    const input = edit(source, edits);
    const projected = projectDiffTexts(
      input.before,
      input.after,
      input.changes,
      true,
      {
        width: 1_024,
        measure: () => 1,
        preferWordBoundaries: true,
      },
    );
    for (const value of [projected.a, projected.b]) {
      const start = value.source.indexOf(marker);
      const from = value.toDisplay(start);
      const to = value.toDisplay(start + marker.length, -1);
      assert.equal(
        value.doc.lineAt(from).number,
        value.doc.lineAt(to - 1).number,
      );
      assert.equal(value.doc.sliceString(from, to), marker);
      assert.ok(
        [...value.doc.iterLines()].every((line) => line.length <= 1_024),
      );
      verifyProjection(value, false);
    }
    verifyChanges(input, projected);
  }
});

test("fallback word lookback stays bounded and oversized words retain hard segmentation", () => {
  for (const source of [
    " ".repeat(900) + "w".repeat(200) + " tail ".repeat(2_000),
    "w".repeat(18_000),
  ]) {
    const projected = projectDiffTexts(source, source, [], true, {
      width: 1_024,
      measure: () => 1,
      preferWordBoundaries: true,
    }).a;
    assert.equal(projected.breaks[0], 1_024);
    assert.ok(
      [...projected.doc.iterLines()].every((line) => line.length <= 1_024),
    );
    verifyProjection(projected, false);
  }
  const marker = "$ASCII_MARKER_123value";
  const source = "😀".repeat(510) + marker + " unicode data ".repeat(1_000);
  const projected = projectDiffTexts(source, source, [], true, {
    width: 1_024,
    measure: () => 1,
    preferWordBoundaries: true,
  }).a;
  const from = projected.toDisplay(source.indexOf(marker));
  const to = projected.toDisplay(source.indexOf(marker) + marker.length, -1);
  assert.equal(
    projected.doc.lineAt(from).number,
    projected.doc.lineAt(to - 1).number,
  );
  assert.ok(
    [...projected.doc.iterLines()].every((line) => line.length <= 1_024),
  );
  verifyProjection(projected, false);
});

test("native source chunks and repeated presentation cleanup do not introduce false differences", () => {
  const before = JSON.stringify(
    { payload: '中文 escaped \\\"😀 text '.repeat(600) },
    null,
    2,
  );
  for (let sample = 0; sample < 30; sample++) {
    const input = edit(before, [
      {
        from: 100 + sample * 101,
        to: 100 + sample * 101 + (sample % 3),
        insert: "changed",
      },
    ]);
    const sourceChunks = Chunk.build(
      Text.of(before.split("\n")),
      Text.of(input.after.split("\n")),
      { scanLimit: 2_000, timeout: 100 },
    );
    const changes = sourceChunks.flatMap((chunk) =>
      chunk.changes.map(
        (change) =>
          new Change(
            chunk.fromA + change.fromA,
            chunk.fromA + change.toA,
            chunk.fromB + change.fromB,
            chunk.fromB + change.toB,
          ),
      ),
    );
    const projected = projectDiffTexts(before, input.after, changes, true, {
      width: 40,
      measure,
    });
    verifyChanges({ ...input, changes }, projected);
    const displayed = Chunk.build(projected.a.doc, projected.b.doc, {
      override: () => projected.changes,
    });
    let cursorA = 0;
    let cursorB = 0;
    for (const chunk of displayed) {
      for (const change of chunk.changes) {
        const fromA = chunk.fromA + change.fromA;
        const fromB = chunk.fromB + change.fromB;
        assert.equal(
          projected.a.doc.sliceString(cursorA, fromA),
          projected.b.doc.sliceString(cursorB, fromB),
        );
        cursorA = chunk.fromA + change.toA;
        cursorB = chunk.fromB + change.toB;
      }
    }
    assert.equal(
      projected.a.doc.sliceString(cursorA),
      projected.b.doc.sliceString(cursorB),
    );
  }
});

test(
  "20 MiB visual wrapping keeps sparse indexes and cached width measurements",
  { timeout: 20_000 },
  (t) => {
    const source = "x".repeat(20 * 1_024 * 1_024);
    let calls = 0;
    const started = performance.now();
    const projected = projectDiffTexts(source, source, [], true, {
      width: 80,
      measure: (text) => {
        calls++;
        return text.length;
      },
    });
    const elapsed = performance.now() - started;
    assert.equal(projected.a, projected.b);
    assert.equal(projected.a.doc.lines, source.length / 80);
    assert.ok(projected.a.breaks.length * 8 < 3_000_000);
    assert.ok(calls <= 2);
    for (const line of [1, 20_000, projected.a.doc.lines])
      assert.equal(projected.a.doc.line(line).length, 80);
    for (const position of [0, 1_024, 10_000_000, source.length])
      assert.equal(
        projected.a.toSource(projected.a.toDisplay(position)),
        position,
      );
    assert.ok(
      elapsed < 10_000,
      `20 MiB visual projection took ${elapsed.toFixed(0)} ms`,
    );
    t.diagnostic(
      `20 MiB visual projection: ${elapsed.toFixed(1)} ms, ${projected.a.breaks.length} cuts, ${calls} measurements`,
    );
  },
);

test(
  "sparse indexes project a 20 MiB line without a per-character mapping",
  { timeout: 20_000 },
  (t) => {
    const source = "x".repeat(20 * 1_024 * 1_024);
    const started = performance.now();
    const projected = projectDiffTexts(source, source, []);
    const elapsed = performance.now() - started;
    assert.equal(projected.a, projected.b);
    assert.ok(projected.a.breaks.length <= source.length / 1_024);
    assert.ok(projected.a.breaks.length * 8 < 200_000);
    assert.equal(
      projected.a.doc.length,
      source.length + projected.a.breaks.length,
    );
    assert.equal(projected.a.toSource(projected.a.doc.length), source.length);
    for (const position of [0, 1_024, 10_000_000, source.length])
      assert.equal(
        projected.a.toSource(projected.a.toDisplay(position)),
        position,
      );
    assert.ok(
      elapsed < 10_000,
      `20 MiB projection took ${elapsed.toFixed(0)} ms`,
    );
    t.diagnostic(
      `20 MiB projection: ${elapsed.toFixed(1)} ms, ${projected.a.breaks.length} sparse cuts`,
    );
  },
);
