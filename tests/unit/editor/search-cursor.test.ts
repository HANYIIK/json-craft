import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Text,
  CharCategory,
  EditorState,
  codePointAt,
  codePointSize,
  findClusterBreak,
  fromCodePoint,
} from "@codemirror/state";

const patchModule = await import(
  new URL(
    "../../../scripts/patches/patch-codemirror-search.mjs",
    import.meta.url,
  ).href
);
const patchCodeMirrorSearch = patchModule.patchCodeMirrorSearch as (
  directory?: string,
) => Promise<void>;
const { SearchCursor, SearchQuery } = await import("@codemirror/search");
const source = await readFile(
  new URL(
    "../../../node_modules/@codemirror/search/dist/index.js",
    import.meta.url,
  ),
  "utf8",
);
const originalNormalization =
  'const basicNormalize = typeof String.prototype.normalize == "function"\n    ? x => x.normalize("NFKD") : x => x;';
const fastNormalization =
  'const basicNormalize = typeof String.prototype.normalize == "function"\n    ? x => x.length == 1 && x.charCodeAt(0) < 128 ? x : x.normalize("NFKD") : x => x;';
const originalLowerCase =
  "return new SearchCursor(state.doc, spec.unquoted, from, to, spec.caseSensitive ? undefined : x => x.toLowerCase(), test);";
const fastLowerCase =
  "return new SearchCursor(state.doc, spec.unquoted, from, to, spec.caseSensitive ? undefined : x => { if (x.length == 1) { const code = x.charCodeAt(0); if (code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : x; } return x.toLowerCase(); }, test);";
assert.equal(source.split(fastNormalization).length, 2);
assert.equal(source.split(fastLowerCase).length, 2);
const originalBody = source
  .slice(
    source.indexOf("const basicNormalize"),
    source.indexOf("if (typeof Symbol"),
  )
  .replace(fastNormalization, originalNormalization);
const OriginalCursor = new Function(
  "codePointAt",
  "fromCodePoint",
  "codePointSize",
  `${originalBody}; return SearchCursor;`,
)(codePointAt, fromCodePoint, codePointSize) as typeof SearchCursor;
const originalStringFactory = source
  .slice(
    source.indexOf("function wrapStringTest"),
    source.indexOf("class StringQuery"),
  )
  .replace(fastLowerCase, originalLowerCase);
const characterHelpers = source.slice(
  source.indexOf("function charBefore("),
  source.indexOf("function regexpWordTest("),
);
const originalStringCursor = new Function(
  "SearchCursor",
  "CharCategory",
  "findClusterBreak",
  `${originalStringFactory}\n${characterHelpers}; return stringCursor;`,
)(OriginalCursor, CharCategory, findClusterBreak) as (
  query: InstanceType<typeof SearchQuery>,
  state: EditorState,
  from: number,
  to: number,
) => InstanceType<typeof SearchCursor>;

type Normalize = (value: string) => string;
type MatchTest = (
  from: number,
  to: number,
  buffer: string,
  bufferStart: number,
) => boolean;

function matches(
  Cursor: typeof SearchCursor,
  raw: string,
  query: string,
  options: {
    from?: number;
    to?: number;
    normalize?: Normalize;
    test?: MatchTest;
    overlapping?: boolean;
  } = {},
) {
  const doc = Text.of(raw.split("\n"));
  const cursor = new Cursor(
    doc,
    query,
    options.from,
    options.to,
    options.normalize,
    options.test,
  );
  const result = [];
  while (!(options.overlapping ? cursor.nextOverlapping() : cursor.next()).done)
    result.push({ ...cursor.value });
  return result;
}

function compare(raw: string, query: string, normalize?: Normalize) {
  for (const overlapping of [false, true]) {
    const options = { normalize, overlapping };
    assert.deepEqual(
      matches(SearchCursor, raw, query, options),
      matches(OriginalCursor, raw, query, options),
      JSON.stringify({ query, overlapping }),
    );
  }
}

test("ASCII searches retain native overlapping ranges and precision", () => {
  assert.deepEqual(matches(SearchCursor, "ababa", "aba"), [
    { from: 0, to: 3, precise: true },
  ]);
  assert.deepEqual(
    matches(SearchCursor, "ababa", "aba", { overlapping: true }),
    [
      { from: 0, to: 3, precise: true },
      { from: 2, to: 5, precise: true },
    ],
  );
  const ascii = Array.from({ length: 128 }, (_, value) =>
    String.fromCharCode(value),
  ).join("");
  for (const query of ["", "aba", "aa", "\0", "\n", "\r", "\t", ascii])
    compare(`${ascii} ababa AAA aaa ${ascii}`, query);
});

test("compatibility decomposition, accents, fullwidth text and emoji match the published cursor", () => {
  const raw =
    "é e\u0301 É ﬃ ffi ① 1 Ａ A ａｂｃ abc ㍿ 株式会社 K K 中文 👩‍💻 👨‍👩‍👧‍👦 😀 \ud800 \udc00";
  for (const query of [
    "é",
    "e",
    "\u0301",
    "É",
    "f",
    "ffi",
    "1",
    "A",
    "abc",
    "株式会社",
    "K",
    "中文",
    "👩‍💻",
    "😀",
    "\ud800",
    "\udc00",
  ]) {
    compare(raw, query);
    compare(raw, query, (value) => value.toLowerCase());
  }
  assert.deepEqual(matches(SearchCursor, "é", "e"), [
    { from: 0, to: 1, precise: false },
  ]);
});

test("ASCII shortcuts still invoke custom normalizers for every original code point", () => {
  const raw = "AbAa é ① 😀";
  const run = (Cursor: typeof SearchCursor) => {
    const calls: string[] = [];
    const result = matches(Cursor, raw, "a", {
      overlapping: true,
      normalize: (value) => {
        calls.push(value);
        return value.toLowerCase().replaceAll("a", "!");
      },
    });
    return { calls, result };
  };
  assert.deepEqual(run(SearchCursor), run(OriginalCursor));
  assert.equal(run(SearchCursor).calls.length, Array.from(raw).length + 1);
  for (const query of ["é", "a", "1", "ffi"])
    compare("A é e\u0301 ① ﬃ", query, (value) =>
      value.toLowerCase().replace(/\p{M}/gu, ""),
    );
});

test("bounded regions, multiline matches and test callbacks keep native offsets and buffers", () => {
  const raw = `${"x".repeat(32)}界\n界 ababa é ①\nabc\nABC`;
  for (const [from, to] of [
    [0, raw.length],
    [32, raw.length - 2],
    [34, 42],
  ]) {
    for (const query of ["界\n界", "aba", "e", "1", "abc", "\n"])
      for (const overlapping of [false, true]) {
        const run = (Cursor: typeof SearchCursor) => {
          const calls: unknown[] = [];
          const result = matches(Cursor, raw, query, {
            from,
            to,
            overlapping,
            normalize: (value) => value.toLowerCase(),
            test: (start, end, buffer, bufferStart) => {
              calls.push([start, end, buffer, bufferStart]);
              return start % 3 !== 0;
            },
          });
          return { calls, result };
        };
        assert.deepEqual(run(SearchCursor), run(OriginalCursor));
      }
  }
});

test("mixed Unicode documents agree with the original under deterministic randomized queries", () => {
  const tokens = [
    "a",
    "A",
    "b",
    "_",
    "\0",
    "\n",
    "中",
    "é",
    "e\u0301",
    "ﬃ",
    "①",
    "Ａ",
    "K",
    "😀",
    "👩‍💻",
  ];
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let iteration = 0; iteration < 30; iteration++) {
    const raw = Array.from(
      { length: 150 },
      () => tokens[random() % tokens.length],
    ).join("");
    for (let index = 0; index < 12; index++) {
      const query = tokens[random() % tokens.length];
      compare(raw, query);
      compare(raw, query, (value) => value.toLowerCase());
    }
  }
});

test("normalization avoids per-character NFKD calls without skipping Unicode", () => {
  const original = String.prototype.normalize;
  const calls: string[] = [];
  String.prototype.normalize = function (form?: string) {
    calls.push(String(this));
    return original.call(this, form);
  };
  try {
    matches(SearchCursor, `${"a".repeat(100_000)}é`, "MISSING");
  } finally {
    String.prototype.normalize = original;
  }
  assert.deepEqual(calls, ["MISSING", "é"]);
});

test("CommonJS and ESM cursors share the same optimized behavior", async () => {
  const { createRequire } = await import("node:module");
  const common = createRequire(import.meta.url)("@codemirror/search") as {
    SearchCursor: typeof SearchCursor;
    SearchQuery: typeof SearchQuery;
  };
  const CommonCursor = common.SearchCursor;
  const raw = "ababa Ａ é e\u0301 ﬃ 😀 中文";
  for (const query of ["aba", "a", "é", "e", "f", "😀", "中文"])
    assert.deepEqual(
      matches(CommonCursor, raw, query, { overlapping: true }),
      matches(SearchCursor, raw, query, { overlapping: true }),
    );
  const state = EditorState.create({ doc: raw });
  for (const search of ["A", "aba", "é", "e", "f", "😀", "中文"]) {
    const run = (Query: typeof SearchQuery) => {
      const cursor = new Query({ search }).getCursor(state) as InstanceType<
        typeof SearchCursor
      >;
      const result = [];
      while (!cursor.nextOverlapping().done) result.push({ ...cursor.value });
      return result;
    };
    assert.deepEqual(run(common.SearchQuery), run(SearchQuery));
  }
});

test("native literal queries preserve Unicode casing, precision, whole-word tests and region limits", () => {
  const raw =
    "ababa A a Z z _ 1\0\nΣ σ ς ΟΣ ος İ i\u0307 ı I K K k ſ s Ａ a é e\u0301 ﬃ FFI 中文 😀";
  const state = EditorState.create({ doc: raw });
  for (const search of [
    "aba",
    "A",
    "z",
    "\0",
    "Σ",
    "ΟΣ",
    "İ",
    "ı",
    "k",
    "s",
    "Ａ",
    "é",
    "e",
    "f",
    "中文",
    "😀",
  ]) {
    for (const caseSensitive of [false, true]) {
      for (const wholeWord of [false, true]) {
        for (const [from, to] of [
          [0, state.doc.length],
          [5, state.doc.length - 2],
        ]) {
          const run = (native: boolean) => {
            const calls: unknown[] = [];
            const query = new SearchQuery({
              search,
              caseSensitive,
              wholeWord,
              literal: true,
              test: (match, _state, start, end) => {
                calls.push([match, start, end]);
                return start % 3 !== 0;
              },
            });
            const cursor = native
              ? (query.getCursor(state, from, to) as InstanceType<
                  typeof SearchCursor
                >)
              : originalStringCursor(query, state, from, to);
            const result = [];
            while (!cursor.nextOverlapping().done)
              result.push({ ...cursor.value });
            return { calls, result };
          };
          assert.deepEqual(
            run(true),
            run(false),
            JSON.stringify({ search, caseSensitive, wholeWord }),
          );
        }
      }
    }
  }
});

test("native literal case folding avoids ASCII conversions while retaining Unicode", () => {
  const original = String.prototype.toLowerCase;
  const calls: string[] = [];
  String.prototype.toLowerCase = function () {
    calls.push(String(this));
    return original.call(this);
  };
  try {
    const state = EditorState.create({
      doc: `${"abc123_".repeat(10_000)}Aé`,
    });
    const cursor = new SearchQuery({ search: "ABC" }).getCursor(state);
    while (!cursor.next().done) {}
  } finally {
    String.prototype.toLowerCase = original;
  }
  assert.deepEqual(calls, ["ABC", "e\u0301"]);
});

test("the dependency patch is idempotent and preflights both module formats", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "json-craft-search-patch-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = path.join(directory, "dist");
  await mkdir(dist);
  const packagePath = path.join(directory, "package.json");
  const modulePaths = ["index.js", "index.cjs"].map((name) =>
    path.join(dist, name),
  );
  const original = `license retained\n${originalNormalization}\n${originalLowerCase}\nmodule retained\n`;
  await writeFile(packagePath, JSON.stringify({ version: "6.7.2" }));
  await Promise.all(modulePaths.map((file) => writeFile(file, original)));
  await patchCodeMirrorSearch(directory);
  const patched = await Promise.all(
    modulePaths.map((file) => readFile(file, "utf8")),
  );
  assert.deepEqual(patched, [
    original
      .replace(originalNormalization, fastNormalization)
      .replace(originalLowerCase, fastLowerCase),
    original
      .replace(originalNormalization, fastNormalization)
      .replace(originalLowerCase, fastLowerCase),
  ]);
  await patchCodeMirrorSearch(directory);
  assert.deepEqual(
    await Promise.all(modulePaths.map((file) => readFile(file, "utf8"))),
    patched,
  );
  await writeFile(packagePath, JSON.stringify({ version: "6.7.3" }));
  await assert.rejects(patchCodeMirrorSearch(directory), /Unsupported/);
  await writeFile(packagePath, JSON.stringify({ version: "6.7.2" }));
  await writeFile(modulePaths[0], original);
  await writeFile(modulePaths[1], "unexpected dependency source");
  await assert.rejects(patchCodeMirrorSearch(directory), /Cannot safely patch/);
  assert.equal(await readFile(modulePaths[0], "utf8"), original);
  assert.equal(
    await readFile(modulePaths[1], "utf8"),
    "unexpected dependency source",
  );
  await writeFile(modulePaths[1], `${original}\n${originalNormalization}`);
  await assert.rejects(patchCodeMirrorSearch(directory), /Cannot safely patch/);
  assert.equal(await readFile(modulePaths[0], "utf8"), original);
});
