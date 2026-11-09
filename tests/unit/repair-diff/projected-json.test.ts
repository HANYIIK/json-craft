import assert from "node:assert/strict";
import test from "node:test";
import * as jsonc from "jsonc-parser";
import { DiffTextProjection } from "../../../src/renderer/features/repair-diff/diff-text-projection";
import { ProjectedJsonIndex } from "../../../src/renderer/features/repair-diff/projected-json";

type Kind = "key" | "string" | "number" | "punctuation";

const { createScanner } = jsonc;
const SyntaxKind = Reflect.get(jsonc as object, "SyntaxKind") as Record<
  string,
  number
>;

function colors(source: string) {
  const scanner = createScanner(source, true);
  const tokens = [];
  for (
    let kind = scanner.scan();
    kind !== SyntaxKind.EOF;
    kind = scanner.scan()
  )
    tokens.push({
      kind,
      from: scanner.getTokenOffset(),
      length: scanner.getTokenLength(),
    });
  const result: (Kind | undefined)[] = new Array(source.length);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const kind: Kind | undefined =
      token.kind === SyntaxKind.StringLiteral
        ? tokens[index + 1]?.kind === SyntaxKind.ColonToken
          ? "key"
          : "string"
        : token.kind === SyntaxKind.NumericLiteral ||
            token.kind === SyntaxKind.NullKeyword ||
            token.kind === SyntaxKind.TrueKeyword ||
            token.kind === SyntaxKind.FalseKeyword
          ? "number"
          : token.kind >= SyntaxKind.OpenBraceToken &&
              token.kind <= SyntaxKind.ColonToken
            ? "punctuation"
            : undefined;
    if (kind) result.fill(kind, token.from, token.from + token.length);
  }
  return result;
}

function verify(source: string, breaks: number[]) {
  const projection = new DiffTextProjection(source, breaks);
  const index = new ProjectedJsonIndex(projection);
  const expected = colors(source);
  for (let row = 1; row <= projection.doc.lines; row++) {
    const line = projection.doc.line(row);
    const actual: (Kind | undefined)[] = new Array(line.length);
    index.highlight(line.from, line.to, (from, to, kind) =>
      actual.fill(kind, from - line.from, to - line.from),
    );
    const start = projection.toSource(line.from);
    assert.equal(index.rowStarts[row - 1], start);
    assert.deepEqual(
      actual,
      expected.slice(start, start + line.length),
      `display row ${row}: ${JSON.stringify(line.text)}`,
    );
  }
  assert.equal(index.states.byteLength, projection.doc.lines);
  assert.equal(index.rowStarts.byteLength, projection.doc.lines * 4);
  return { projection, index };
}

test("sparse lexical checkpoints preserve JSON colors across every character boundary", () => {
  const source = JSON.stringify(
    {
      ['escaped\\key"']: 'value \\"quote" 中文\n',
      numbers: [-1.23456789e29, 0, true, false, null],
      empty: "",
    },
    null,
    2,
  );
  assert.doesNotThrow(() => JSON.parse(source));
  verify(
    source,
    Array.from({ length: source.length - 1 }, (_, index) => index + 1),
  );
  verify(source, [7, 22, 37, 61, 84]);
  verify(source, []);
});

test("giant keys, whitespace before colons and escape parity survive isolated viewport reads", () => {
  const key = "key" + "\\".repeat(5_000) + '"end';
  const source =
    `{${JSON.stringify(key)}` +
    " \n\t".repeat(3_000) +
    ':"' +
    "\\\\".repeat(5_000) +
    '\\"tail", "number": -' +
    "1234567890".repeat(2_000) +
    'e+12, "literal": true}';
  assert.doesNotThrow(() => JSON.parse(source));
  const breaks = Array.from(
    { length: Math.floor((source.length - 1) / 79) },
    (_, index) => (index + 1) * 79,
  );
  const { projection, index } = verify(source, breaks);
  const first = projection.doc.line(1);
  const original = String.prototype.charCodeAt;
  let reads = 0;
  String.prototype.charCodeAt = function (position: number) {
    reads++;
    return original.call(this, position);
  };
  try {
    index.highlight(first.from, first.to, () => {});
  } finally {
    String.prototype.charCodeAt = original;
  }
  assert.ok(
    reads < first.length * 3 + 20,
    `Highlighting a visible row scanned ${reads} source characters`,
  );
});

test("visible range clipping retains original token colors without styling display newlines", () => {
  const source = '{"key":"long \\\"value\\\"", "n":12345}';
  const projection = new DiffTextProjection(source, [9, 17, 29]);
  const index = new ProjectedJsonIndex(projection);
  const expected = colors(source);
  for (let from = 0; from < projection.doc.length; from += 3) {
    const to = Math.min(projection.doc.length, from + 7);
    const actual: (Kind | undefined)[] = new Array(to - from);
    index.highlight(from, to, (start, end, kind) => {
      assert.ok(start >= from && end <= to && start < end);
      actual.fill(kind, start - from, end - from);
    });
    for (let position = from; position < to; position++) {
      const sourcePosition = projection.toSource(position);
      const inserted = projection.toSource(position + 1) === sourcePosition;
      assert.equal(
        actual[position - from],
        inserted ? undefined : expected[sourcePosition],
        `display position ${position}`,
      );
    }
  }
});

test(
  "20 MiB mixed short JSON items and a giant string retain only five bytes per display row",
  { timeout: 20_000 },
  (t) => {
    const prefix =
      '{"items":[\n' + '{"a":1},\n'.repeat(1_000_000) + 'null],"payload":"';
    const source =
      prefix + "x".repeat(20 * 1024 * 1024 - prefix.length - 2) + '"}';
    const giantStart = prefix.length;
    const breaks = Array.from(
      { length: Math.floor((source.length - giantStart - 2) / 1024) },
      (_, index) => giantStart + (index + 1) * 1024,
    );
    const projection = new DiffTextProjection(source, breaks);
    const started = performance.now();
    const index = new ProjectedJsonIndex(projection);
    const elapsed = performance.now() - started;
    assert.equal(source.length, 20 * 1024 * 1024);
    assert.equal(
      index.states.byteLength + index.rowStarts.byteLength,
      projection.doc.lines * 5,
    );
    assert.ok(
      elapsed < 10_000,
      `Sparse lexical indexing took ${elapsed.toFixed(0)} ms`,
    );
    const target = projection.doc.line(120_000);
    const stop = projection.doc.line(120_010);
    let spans = 0;
    index.highlight(target.from, stop.to, () => spans++);
    assert.ok(spans > 0 && spans < 100);
    t.diagnostic(
      `20 MiB sparse lexical index: ${elapsed.toFixed(1)} ms, ${projection.doc.lines} rows, ${index.states.byteLength + index.rowStarts.byteLength} bytes`,
    );
  },
);
