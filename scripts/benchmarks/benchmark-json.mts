import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { processJson } from "../../src/core/json/json";
import {
  defaultOptions,
  MAX_FILE_BYTES,
  type FormatOptions,
  type ProcessingResult,
} from "../../src/shared/types";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    iterations: { type: "string", default: "5" },
    rows: { type: "string", default: "10000,100000" },
    "baseline-module": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "Requires Node >=22.13. npm run benchmark:json -- [--input /path/sample.json] [--iterations 5] [--rows 10000,100000] [--baseline-module /path/old-core.ts]",
  );
  process.exit(0);
}

const iterations = Number(values.iterations);
const rows = values.rows.split(",").map(Number);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 21)
  throw new Error("iterations must be an integer from 1 to 21");
if (
  !rows.length ||
  rows.some((count) => !Number.isInteger(count) || count < 1 || count > 200_000)
)
  throw new Error("rows must contain counts from 1 to 200000");
if (!globalThis.gc)
  throw new Error("Run through npm run benchmark:json to enable explicit GC");

const options: FormatOptions = {
  ...defaultOptions,
  autoUnescape: false,
  repair: false,
};
const MAX_OUTPUT_CHARACTERS = MAX_FILE_BYTES * 4;

function legacyFormatTokens(text: string, options: FormatOptions): string {
  const indent =
    options.indent === "tab" ? "\t" : " ".repeat(Number(options.indent));
  const parts: string[] = [];
  let depth = 0;
  let outputLength = 0;
  const append = (part: string) => {
    outputLength += part.length;
    if (outputLength > MAX_OUTPUT_CHARACTERS)
      throw new Error("Formatted output exceeds the production size limit");
    parts.push(part);
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/\s/.test(char)) continue;
    if (char === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
        index++;
      }
      append(text.slice(start, index + 1));
    } else if (char === "{" || char === "[") {
      let next = index + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      const close = char === "{" ? "}" : "]";
      if (text[next] === close) {
        append(char + close);
        index = next;
      } else {
        depth++;
        append(`${char}\n${indent.repeat(depth)}`);
      }
    } else if (char === "}" || char === "]") {
      depth--;
      append(`\n${indent.repeat(depth)}${char}`);
    } else if (char === ",") {
      append(`,\n${indent.repeat(depth)}`);
    } else if (char === ":") {
      append(": ");
    } else {
      const start = index;
      while (index + 1 < text.length && !/[\s{}\[\],:]/.test(text[index + 1]))
        index++;
      append(text.slice(start, index + 1));
    }
  }
  return parts.join("");
}

type Runner = (raw: string) => string;
let baselineKind = "previous token formatter within the production pipeline";
let baseline: Runner;

function output(result: ProcessingResult) {
  if (!result.success)
    throw new Error(
      "Use valid JSON within the production input and output limits",
    );
  return result.output;
}

if (values["baseline-module"]) {
  const previous = await import(
    pathToFileURL(path.resolve(values["baseline-module"])).href
  );
  const previousProcess = previous.processJson ?? previous.default?.processJson;
  if (typeof previousProcess !== "function")
    throw new Error("Baseline module must export processJson");
  baseline = (raw) => output(previousProcess(raw, options));
  baselineKind = "supplied processJson module";
} else {
  const coreUrl = new URL("../../src/core/json/json.ts", import.meta.url);
  const source = await readFile(coreUrl, "utf8");
  const script = await readFile(new URL(import.meta.url), "utf8");
  const start = source.indexOf("function formatTokens(");
  const end = source.indexOf("\nexport function processJson(");
  const legacyStart = script.indexOf("function legacyFormatTokens(");
  const legacyEnd = script.indexOf("\ntype Runner =");
  if (start < 0 || end < start || legacyStart < 0 || legacyEnd < legacyStart)
    throw new Error(
      "Update the benchmark after changing the core module layout",
    );
  const legacy = script
    .slice(legacyStart, legacyEnd)
    .replace("function legacyFormatTokens(", "function formatTokens(");
  let reference = source.slice(0, start) + legacy + source.slice(end);
  for (const name of ["diff", "jsonrepair"])
    reference = reference.replace(
      `from "${name}"`,
      `from ${JSON.stringify(import.meta.resolve(name))}`,
    );
  reference = reference.replace(
    'from "../../shared/types"',
    `from ${JSON.stringify(new URL("../../shared/types.ts", coreUrl).href)}`,
  );
  const javascript = stripTypeScriptTypes(reference);
  const previous = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
  baseline = (raw) => output(previous.processJson(raw, options));
}

const current: Runner = (raw) => output(processJson(raw, options));
const fixtures: { name: string; read: () => string | Promise<string> }[] = [];
if (values.input) {
  const input = path.resolve(values.input);
  fixtures.push({
    name: path.basename(input),
    read: () => readFile(input, "utf8"),
  });
}
for (const count of rows)
  fixtures.push({
    name: `dense-objects-${count}`,
    read: () =>
      "[" +
      Array.from(
        { length: count },
        (_, index) =>
          `{"id":9007199254740993,"key":"value-${index}","nested":{"target":[1,2,3],"text":"中文\\\"quoted\\\""}}`,
      ).join(",") +
      "]",
  });
fixtures.push({
  name: "long-escaped-string",
  read: () => JSON.stringify({ large: 'abc中文😀\\"'.repeat(1_000_000) }),
});

console.log(
  JSON.stringify({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    iterations,
    baseline: baselineKind,
    measurement:
      "Synchronous core timing in Node, not UI frame time. Heap delta is post-call heapUsed minus post-GC heapUsed, not peak allocation. Input is read-only; contents are never printed.",
  }),
);

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

for (const fixture of fixtures) {
  const raw = await fixture.read();
  const expected = baseline(raw);
  assert.ok(current(raw) === expected, "Baseline and production output differ");
  const timings = { baseline: [] as number[], current: [] as number[] };
  const heaps = { baseline: [] as number[], current: [] as number[] };
  const runners = { baseline, current };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const order =
      iteration % 2
        ? (["current", "baseline"] as const)
        : (["baseline", "current"] as const);
    for (const key of order) {
      globalThis.gc!();
      const heap = process.memoryUsage().heapUsed;
      const started = performance.now();
      const formatted = runners[key](raw);
      timings[key].push(performance.now() - started);
      heaps[key].push((process.memoryUsage().heapUsed - heap) / 1024 / 1024);
      assert.ok(
        formatted === expected,
        "Formatting changed JSON token spelling",
      );
    }
  }
  const before = median(timings.baseline);
  const after = median(timings.current);
  console.log(
    JSON.stringify({
      case: fixture.name,
      inputBytes: Buffer.byteLength(raw),
      inputUtf16Length: raw.length,
      maxLineLength: raw
        .split("\n")
        .reduce((max, line) => Math.max(max, line.length), 0),
      outputUtf16Length: expected.length,
      baselineMedianMs: before,
      currentMedianMs: after,
      fasterPercent: (1 - after / before) * 100,
      baselineMedianHeapDeltaMiB: median(heaps.baseline),
      currentMedianHeapDeltaMiB: median(heaps.current),
      exactOutputMatch: true,
    }),
  );
}
