import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

interface MockView {
  dom?: { getAttribute?(name: string): string | null };
}

const { resolveDomHeightLimit, domHeightLimitPatches } = (await import(
  new URL(
    "../../../scripts/patches/codemirror-height-limit.mjs",
    import.meta.url,
  ).href
)) as {
  resolveDomHeightLimit(view?: MockView): number;
  domHeightLimitPatches(): [string, string][];
};
const { normalizeLegacyView } = (await import(
  new URL("../../../scripts/patches/codemirror-legacy.mjs", import.meta.url)
    .href
)) as { normalizeLegacyView(source: string, version: string): string };

const view = (value: string | null): MockView => ({
  dom: {
    getAttribute(name) {
      assert.equal(name, "data-json-craft-dom-height");
      return value;
    },
  },
});

test("missing DOM and invalid attributes preserve the native seven-million limit", () => {
  assert.equal(resolveDomHeightLimit(), 7_000_000);
  assert.equal(resolveDomHeightLimit({}), 7_000_000);
  assert.equal(resolveDomHeightLimit({ dom: {} }), 7_000_000);
  for (const value of [
    null,
    "",
    " ",
    "0",
    "-1",
    "NaN",
    "Infinity",
    "-Infinity",
    "15000000px",
  ])
    assert.equal(resolveDomHeightLimit(view(value)), 7_000_000);
});

test("per-view limits accept finite positive integers and clamp unsafe values", () => {
  for (const [input, expected] of [
    ["15099492", 15_099_492],
    ["15099492.8", 15_099_492],
    ["1e9", 30_000_000],
    ["0.5", 1],
    [" 12000000 ", 12_000_000],
  ] as const)
    assert.equal(resolveDomHeightLimit(view(input)), expected);
});

interface Scaler {
  scale: number;
  toDOM(position: number): number;
  fromDOM(position: number): number;
}

interface HeightMap {
  height: number;
  lineAt(position: number): { top: number; bottom: number };
}

interface TestViewState {
  view?: MockView;
  scaler: Scaler;
  heightMap: HeightMap;
  heightOracle: unknown;
  viewports: { from: number; to: number }[];
  updateScaler(): number;
}

function scalers(source: string) {
  const classFrom = source.indexOf("class BigScaler {");
  const classTo = source.indexOf("\nfunction scaleBlock", classFrom);
  const updateFrom = source.indexOf("    updateScaler() {");
  const updateTo = source.indexOf("\n    updateViewportLines()", updateFrom);
  assert.ok(classFrom >= 0 && classTo > classFrom);
  assert.ok(updateFrom >= 0 && updateTo > updateFrom);
  return runInNewContext(`
    const QueryType = {ByPos: 0};
    const IdScaler = {scale:1, toDOM(n){return n}, fromDOM(n){return n}, eq(other){return other===this}};
    ${source.slice(classFrom, classTo)}
    class ViewState {${source.slice(updateFrom, updateTo)}}
    ({ViewState, BigScaler, IdScaler})
  `) as {
    ViewState: new () => TestViewState;
    BigScaler: {
      get(
        oracle: unknown,
        map: HeightMap,
        viewports: { from: number; to: number }[],
        limit?: number,
      ): Scaler;
    };
    IdScaler: Scaler;
  };
}

const patches = domHeightLimitPatches();
function apply(source: string) {
  let patched = normalizeLegacyView(source, "6.43.15");
  for (const [before, after] of patches) {
    if (patched.split(after).length === 2) continue;
    assert.equal(patched.split(before).length, 2);
    patched = patched.replace(before, after);
  }
  return patched;
}

for (const file of ["index.js", "index.cjs"]) {
  const installed = await readFile(
    new URL(
      `../../../node_modules/@codemirror/view/dist/${file}`,
      import.meta.url,
    ),
    "utf8",
  );
  let raw = installed;
  for (const [before, after] of [...patches].reverse()) {
    assert.equal(raw.split(after).length, 2);
    raw = raw.replace(after, before);
  }
  const generic = raw.replace(
    "if (heightMap.height - vpHeight < 10)",
    "if (heightMap.height - vpHeight < 10 || vpHeight >= 7000000)",
  );

  test(`${file} raw and existing generic sources upgrade to the same idempotent result`, () => {
    assert.equal(apply(raw), installed);
    assert.equal(apply(generic), installed);
    assert.equal(apply(installed), installed);
  });

  test(`${file} scaler activation follows each view attribute and rechecks after DOM creation`, () => {
    const { ViewState, IdScaler } = scalers(installed);
    const state = new ViewState();
    Object.assign(state, {
      scaler: IdScaler,
      heightMap: {
        height: 10_000_000,
        lineAt: (position: number) => ({ top: position, bottom: position + 1 }),
      },
      heightOracle: {},
      viewports: [],
    });
    state.updateScaler();
    assert.ok(Math.abs(state.scaler.scale - 0.7) < 1e-10);
    state.view = view("15000000");
    state.updateScaler();
    assert.equal(state.scaler, IdScaler);
    state.view = view(null);
    state.updateScaler();
    assert.ok(Math.abs(state.scaler.scale - 0.7) < 1e-10);
    state.view = view("100000000");
    state.heightMap.height = 25_000_000;
    state.updateScaler();
    assert.equal(state.scaler, IdScaler);
  });

  test(`${file} scaling numerator, default and viewport guard share one limit`, () => {
    const { BigScaler, IdScaler } = scalers(installed);
    const heightMap = {
      height: 20_000_000,
      lineAt: (position: number) => ({ top: position, bottom: position }),
    };
    assert.ok(Math.abs(BigScaler.get({}, heightMap, []).scale - 0.35) < 1e-10);
    assert.ok(
      Math.abs(BigScaler.get({}, heightMap, [], 15_000_000).scale - 0.75) <
        1e-10,
    );
    assert.equal(
      BigScaler.get({}, heightMap, [{ from: 0, to: 16_000_000 }], 15_000_000),
      IdScaler,
    );
  });
}
