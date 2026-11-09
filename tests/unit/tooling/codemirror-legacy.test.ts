import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
type Normalize = (source: string, version: string) => string;
const { normalizeLegacyView, normalizeLegacyMerge } = (await import(
  new URL("../../../scripts/patches/codemirror-legacy.mjs", import.meta.url)
    .href
)) as { normalizeLegacyView: Normalize; normalizeLegacyMerge: Normalize };

const viewSnapshot = [
  [
    "            let viewFrom, viewTo;\n            if (mayMeasure && wrapping && Math.abs(this.scaleY - 1) < .005 && typeof mayMeasure.dom[Symbol.for('json-craft.shared-line-gaps')] === 'function') {\n                const drawnLine = mayMeasure.docView.lineAt(line.from, 1);\n                if (drawnLine && drawnLine.posAtStart === line.from && drawnLine.length === line.length) {\n                    let hiddenLength = 0, hiddenHeight = 0;\n                    const measureGaps = tile => {\n                        if (tile.widget instanceof LineGapWidget && tile.widget.vertical) {\n                            hiddenLength += tile.length;\n                            hiddenHeight += tile.dom.getBoundingClientRect().height;\n                        } else if (tile.children) {\n                            for (const child of tile.children) measureGaps(child);\n                        }\n                    };\n                    measureGaps(drawnLine);\n                    const visibleLength = line.length - hiddenLength;\n                    const visibleHeight = drawnLine.dom.getBoundingClientRect().height - hiddenHeight;\n                    if (visibleLength > 100 && visibleHeight > 0) {\n                        const measured = visibleHeight / visibleLength;\n                        if (Number.isFinite(measured) && Math.abs(measured / density - 1) > .01) density = measured;\n                    }\n                }\n            }\n            if (wrapping) {",
    "            let viewFrom, viewTo;\n            if (wrapping) {",
  ],
  [
    "            const sharedGapStart = gaps.length;\n            if (viewFrom > line.from)\n                addGap(line.from, viewFrom, line, structure, density);\n            if (viewTo < line.to)\n                addGap(viewTo, line.to, line, structure, density);\n            const sharedGapProvider = mayMeasure && mayMeasure.dom[Symbol.for('json-craft.shared-line-gaps')];\n            if (typeof sharedGapProvider === 'function') {\n                const shared = sharedGapProvider({ from: line.from, to: line.to, gaps: gaps.slice(sharedGapStart), width: this.contentDOMWidth, charWidth: this.heightOracle.charWidth, lineHeight: this.heightOracle.lineHeight, scaleX: this.scaleX, scaleY: this.scaleY, wrapping });\n                if (Array.isArray(shared)) gaps.splice(sharedGapStart, gaps.length - sharedGapStart, ...shared.map(gap => new LineGap(gap.from, gap.to, gap.size, gap.displaySize)));\n            }",
    "            if (viewFrom > line.from)\n                addGap(line.from, viewFrom, line, structure, density);\n            if (viewTo < line.to)\n                addGap(viewTo, line.to, line, structure, density);",
  ],
  [
    "        const allGapViewports = typeof this.view.dom[Symbol.for('json-craft.shared-line-gaps')] === 'function';\n        let gapLines = this.viewportLines;\n        if (allGapViewports) {\n            const renderedLines = new Map();\n            const collect = block => {\n                if (Array.isArray(block.type)) block.type.forEach(collect);\n                else if (block.type === BlockType.Text) renderedLines.set(block.from + ':' + block.to, block);\n            };\n            for (const viewport of this.viewports)\n                this.heightMap.forEachLine(viewport.from, viewport.to, this.heightOracle, 0, 0, block => collect(scaleBlock(block, this.scaler)));\n            gapLines = Array.from(renderedLines.values()).sort((a, b) => a.from - b.from || a.to - b.to);\n        }\n        for (let line of gapLines) {\n            if (Array.isArray(line.type))\n                line.type.forEach(checkLine);\n            else\n                checkLine(line);\n        }\n        return allGapViewports ? gaps.sort((a, b) => a.from - b.from || a.to - b.to) : gaps;\n    }\n    gapSize",
    "        for (let line of this.viewportLines) {\n            if (Array.isArray(line.type))\n                line.type.forEach(checkLine);\n            else\n                checkLine(line);\n        }\n        return gaps;\n    }\n    gapSize",
  ],
  [
    "if (refresh) this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle, [new ChangedRange(0, 0, 0, view.state.doc.length)]);\n            for (let vp of this.viewports) {\n                let heights = vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp);\n                this.heightMap = this.heightMap.updateHeight(oracle, 0, refresh && typeof view.dom[Symbol.for('json-craft.shared-line-gaps')] !== 'function', new MeasuredHeights(vp.from, heights));",
    "if (refresh) this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle, [new ChangedRange(0, 0, 0, view.state.doc.length)]);\n            for (let vp of this.viewports) {\n                let heights = vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp);\n                this.heightMap = this.heightMap.updateHeight(oracle, 0, refresh, new MeasuredHeights(vp.from, heights));",
  ],
];

const mergeSnapshot = [
  [
    "function updateSpacers(a, b, chunks) {\n    let geometry;\n    try {\n        const provider = a.dom[Symbol.for('json-craft.merge-geometry')];\n        if (typeof provider === 'function') geometry = provider();\n    } catch (_) {}\n    let buildA =",
    "function updateSpacers(a, b, chunks) {\n    let buildA =",
  ],
  [
    "            const measured = geometry && geometry.line(posA, posB);\n            const actual = measured && Number.isFinite(measured.a) && Number.isFinite(measured.b);\n            let heightA = (actual ? measured.a : a.lineBlockAt(posA).top) + offA;\n            let heightB = (actual ? measured.b : b.lineBlockAt(posB).top) + offB;",
    "            let heightA = a.lineBlockAt(posA).top + offA;\n            let heightB = b.lineBlockAt(posB).top + offB;",
  ],
  [
    "    const measuredEnd = geometry && geometry.end();\n    const actualEnd = measuredEnd && Number.isFinite(measuredEnd.a) && Number.isFinite(measuredEnd.b);\n    let docDiff = ((actualEnd ? measuredEnd.a : a.contentHeight) + offA) - ((actualEnd ? measuredEnd.b : b.contentHeight) + offB);",
    "    let docDiff = (a.contentHeight + offA) - (b.contentHeight + offB);",
  ],
];

const formats = [
  { name: "ESM", convert: (source: string) => source },
  {
    name: "CJS",
    convert: (source: string) =>
      source.replaceAll("Text.empty", "state.Text.empty"),
  },
];

for (const { name, convert } of formats) {
  for (const { packageName, version, snapshot, normalize } of [
    {
      packageName: "view",
      version: "6.43.15",
      snapshot: viewSnapshot,
      normalize: normalizeLegacyView,
    },
    {
      packageName: "merge",
      version: "6.12.3",
      snapshot: mergeSnapshot,
      normalize: normalizeLegacyMerge,
    },
  ]) {
    test(`restores archived ${name} ${packageName} hooks without changing unrelated source`, () => {
      const old =
        "unrelated prefix\n" +
        snapshot.map(([legacy]) => convert(legacy)).join("\n") +
        "\nunrelated suffix";
      const current =
        "unrelated prefix\n" +
        snapshot.map(([, modern]) => convert(modern)).join("\n") +
        "\nunrelated suffix";
      assert.equal(normalize(old, version), current);
      assert.equal(normalize(current, version), current);
      assert.equal(normalize(normalize(old, version), version), current);
      let reinjected = current;
      for (const [legacy, modern] of snapshot)
        reinjected = reinjected.replace(convert(modern), convert(legacy));
      assert.equal(reinjected, old);
      assert.equal(normalize(reinjected, version), current);
    });

    test(`rejects partial and duplicated ${name} ${packageName} hook snapshots atomically`, () => {
      const old = snapshot.map(([legacy]) => convert(legacy)).join("\n");
      const broken = old.replace(";", " ;");
      assert.throws(() => normalize(broken, version), /Unrecognized legacy/);
      assert.equal(broken, old.replace(";", " ;"));
      const duplicated = old + "\n" + convert(snapshot[0][0]);
      assert.throws(() => normalize(duplicated, version), /Ambiguous legacy/);
    });
  }
}

test("clean upstream and generic patched sources remain unchanged", () => {
  for (const source of [
    "",
    "function updateSpacers(a, b, chunks) {\n    let buildA = value;\n}",
    "plain source without legacy hooks",
  ]) {
    assert.equal(normalizeLegacyView(source, "6.43.15"), source);
    assert.equal(normalizeLegacyMerge(source, "6.12.3"), source);
  }
});

test("refuses unknown package versions even when their source is clean", () => {
  assert.throws(() => normalizeLegacyView("clean", "6.43.16"), /Unsupported/);
  assert.throws(() => normalizeLegacyMerge("clean", "6.12.4"), /Unsupported/);
});

test("unrecognized standalone private hook fragments cannot slip through", () => {
  for (const source of [
    "const sharedGapStart = gaps.length;",
    "const allGapViewports = false;",
    "json-craft.shared-line-gaps",
  ])
    assert.throws(
      () => normalizeLegacyView(source, "6.43.15"),
      /Unrecognized legacy/,
    );
  for (const source of [
    "let geometry;",
    "geometry && geometry.line",
    "json-craft.merge-geometry",
  ])
    assert.throws(
      () => normalizeLegacyMerge(source, "6.12.3"),
      /Unrecognized legacy/,
    );
});

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);

async function installedFixture(corrupt = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "json-craft-legacy-"));
  const originals = new Map<string, string>();
  const installed = new Map<string, string>();
  const save = async (relative: string, contents: string) => {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    return file;
  };
  try {
    for (const script of [
      "patch-codemirror.mjs",
      "codemirror-legacy.mjs",
      "codemirror-height-limit.mjs",
      "patch-codemirror-search.mjs",
    ])
      await save(
        `scripts/patches/${script}`,
        await readFile(
          path.join(projectRoot, "scripts/patches", script),
          "utf8",
        ),
      );
    for (const [name, version, snapshot] of [
      ["view", "6.43.15", viewSnapshot],
      ["merge", "6.12.3", mergeSnapshot],
      ["search", "6.7.2", []],
    ] as const) {
      await save(
        `node_modules/@codemirror/${name}/package.json`,
        JSON.stringify({ version }),
      );
      for (const format of formats) {
        const fileName = format.name === "ESM" ? "index.js" : "index.cjs";
        const original = await readFile(
          path.join(
            projectRoot,
            "node_modules/@codemirror",
            name,
            "dist",
            fileName,
          ),
          "utf8",
        );
        let legacy =
          name === "view"
            ? normalizeLegacyView(original, version)
            : name === "merge"
              ? normalizeLegacyMerge(original, version)
              : original;
        const normalized = legacy;
        for (const [old, current] of snapshot) {
          assert.equal(legacy.split(format.convert(current)).length, 2);
          legacy = legacy.replace(format.convert(current), format.convert(old));
        }
        if (corrupt && name === "view" && format.name === "CJS")
          legacy = legacy.replace(
            "const sharedGapProvider =",
            "const sharedGapProvider  =",
          );
        const saved = await save(
          `node_modules/@codemirror/${name}/dist/${fileName}`,
          legacy,
        );
        if (name !== "search") {
          originals.set(saved, legacy);
          installed.set(saved, normalized);
        }
      }
    }
    return { directory, originals, installed };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("existing offline installations normalize all four dist files and remain idempotent", async () => {
  const fixture = await installedFixture();
  try {
    const script = path.join(
      fixture.directory,
      "scripts/patches/patch-codemirror.mjs",
    );
    for (let run = 0; run < 2; run++) {
      await execute(process.execPath, [script]);
      for (const [file, expected] of fixture.installed)
        assert.equal(await readFile(file, "utf8"), expected);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an unknown CJS legacy fragment prevents partial writes to either package", async () => {
  const fixture = await installedFixture(true);
  try {
    const script = path.join(
      fixture.directory,
      "scripts/patches/patch-codemirror.mjs",
    );
    await assert.rejects(
      execute(process.execPath, [script]),
      /Unrecognized legacy @codemirror\/view/,
    );
    for (const [file, original] of fixture.originals)
      assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
