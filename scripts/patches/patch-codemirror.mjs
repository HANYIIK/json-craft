import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "./patch-codemirror-search.mjs";
import {
  normalizeLegacyMerge,
  normalizeLegacyView,
} from "./codemirror-legacy.mjs";
import { domHeightLimitPatches } from "./codemirror-height-limit.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = path.join(root, "node_modules", "@codemirror", "view");
const { version } = JSON.parse(
  await readFile(path.join(directory, "package.json"), "utf8"),
);
if (version !== "6.43.15")
  throw new Error(`Unsupported @codemirror/view version: ${version}`);

const changes = [
  ...domHeightLimitPatches(),
  [
    "this.lineGapDeco = Decoration.set(this.lineGaps.map(gap => gap.draw(this, false)));",
    "this.lineGapWrapping = this.heightOracle.lineWrapping;\n        this.lineGapDeco = Decoration.set(this.lineGaps.map(gap => gap.draw(this, this.lineGapWrapping)));",
  ],
  [
    "if (!LineGap.same(gaps, this.lineGaps)) {\n            this.lineGaps = gaps;",
    "if (this.lineGapWrapping !== this.heightOracle.lineWrapping || !LineGap.same(gaps, this.lineGaps)) {\n            this.lineGapWrapping = this.heightOracle.lineWrapping;\n            this.lineGaps = gaps;",
  ],
  ["counted += pos - from;", "counted += Math.max(0, pos - from);"],
  [
    "let addGap = (from, to, line, structure) => {",
    "let addGap = (from, to, line, structure, density) => {",
  ],
  [
    "addGap(from, pos - 10 /* LG.SelectionMargin */, line, structure);\n                    addGap(pos + 10 /* LG.SelectionMargin */, to, line, structure);",
    "addGap(from, pos - 10 /* LG.SelectionMargin */, line, structure, density);\n                    addGap(pos + 10 /* LG.SelectionMargin */, to, line, structure, density);",
  ],
  [
    "let size = this.gapSize(line, from, to, structure);",
    "let size = this.gapSize(line, from, to, structure, density);",
  ],
  [
    "            gaps.push(gap);\n        };\n        let checkLine = (line) => {",
    "            if (mayMeasure && wrapping && Math.abs(this.scaleY - 1) < .005) {\n                const size = this.gapSize(line, gap.from, gap.to, structure, density);\n                if (Math.abs(size - gap.size) > 1) gap = new LineGap(gap.from, gap.to, size, size);\n            }\n            gaps.push(gap);\n        };\n        let checkLine = (line) => {",
  ],
  [
    "            if (structure.total < doubleMargin)\n                return;\n            let target = this.scrollTarget ? this.scrollTarget.range.head : null;",
    "            if (structure.total < doubleMargin)\n                return;\n            let density = Math.abs(this.scaleY - 1) < .005 ? this.heightOracle.lineHeight / Math.max(1, this.heightOracle.lineLength) : line.height / structure.total;\n            if (wrapping && Math.abs(this.scaleY - 1) < .005) {\n                let hiddenLength = 0, hiddenHeight = 0;\n                for (const gap of current) {\n                    if (gap.from >= line.from && gap.to <= line.to) {\n                        hiddenLength += structure.total * (findFraction(structure, gap.to) - findFraction(structure, gap.from));\n                        hiddenHeight += gap.displaySize;\n                    }\n                }\n                if (hiddenLength > 0 && hiddenHeight > 0) {\n                    density = hiddenHeight / hiddenLength;\n                    const visibleLength = structure.total - hiddenLength;\n                    const visibleHeight = line.height - hiddenHeight;\n                    const drawnLine = mayMeasure && mayMeasure.docView.lineAt(line.from, 1);\n                    if (drawnLine && drawnLine.posAtStart === line.from && drawnLine.length === line.length && visibleLength > 100 && visibleHeight > 0) {\n                        const measured = visibleHeight / visibleLength;\n                        if (Number.isFinite(measured) && Math.abs(measured / density - 1) > 0.01) density = measured;\n                    }\n                }\n            }\n            let target = this.scrollTarget ? this.scrollTarget.range.head : null;",
  ],
  [
    "addGap(line.from, viewFrom, line, structure);\n            if (viewTo < line.to)\n                addGap(viewTo, line.to, line, structure);",
    "addGap(line.from, viewFrom, line, structure, density);\n            if (viewTo < line.to)\n                addGap(viewTo, line.to, line, structure, density);",
  ],
  [
    "gapSize(line, from, to, structure) {",
    "gapSize(line, from, to, structure, density) {",
  ],
  [
    "return line.height * fraction;",
    "return structure.total * fraction * density;",
  ],
  [
    "let changed = Math.abs(lineHeight - this.lineHeight) > 0.3 || this.lineWrapping != lineWrapping;",
    "let changed = Math.abs(lineHeight - this.lineHeight) > 0.3 || this.lineWrapping != lineWrapping || Math.abs(charWidth - this.charWidth) > 0.1 || Math.abs(lineLength - this.lineLength) > 0.5;",
  ],
  [
    "let contentWidth = domRect.width;",
    "let contentWidth = domRect.width;\n        const widthChanged = oracle.lineWrapping && Math.abs(contentWidth - this.contentDOMWidth) > oracle.charWidth;",
  ],
  [
    "if (measureContent) {\n            let lineHeights = view.docView.measureVisibleLineHeights(this.viewport);",
    "if (widthChanged) measureContent = true;\n        if (measureContent) {\n            let lineHeights = view.docView.measureVisibleLineHeights(this.viewport);",
  ],
  [
    "if (refresh || oracle.lineWrapping && Math.abs(contentWidth - this.contentDOMWidth) > oracle.charWidth) {",
    "if (refresh || widthChanged) {",
  ],
  [
    "refresh = lineHeight > 0 && oracle.refresh(whiteSpace, lineHeight, charWidth, textHeight, Math.max(5, contentWidth / charWidth), lineHeights);",
    "refresh = lineHeight > 0 && (oracle.refresh(whiteSpace, lineHeight, charWidth, textHeight, Math.max(5, contentWidth / charWidth), lineHeights) || widthChanged);",
  ],
  [
    "for (let vp of this.viewports) {\n                let heights = vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp);\n                this.heightMap = (refresh ? HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle, [new ChangedRange(0, 0, 0, view.state.doc.length)]) : this.heightMap).updateHeight(oracle, 0, refresh, new MeasuredHeights(vp.from, heights));",
    "if (refresh) this.heightMap = HeightMap.empty().applyChanges(this.stateDeco, Text.empty, this.heightOracle, [new ChangedRange(0, 0, 0, view.state.doc.length)]);\n            for (let vp of this.viewports) {\n                let heights = vp.from == this.viewport.from ? lineHeights : view.docView.measureVisibleLineHeights(vp);\n                this.heightMap = this.heightMap.updateHeight(oracle, 0, refresh, new MeasuredHeights(vp.from, heights));",
  ],
  [
    "let updated = null;\n        let scroll = this.viewState.scrollParent",
    "let updated = null, continueMeasuring = false;\n        const measureStarted = performance.now();\n        let scroll = this.viewState.scrollParent",
  ],
  [
    "for (let i = 0;; i++) {\n                if (scrollAnchorHeight < 0) {",
    "for (let i = 0;; i++) {\n                if (i > 5 || (i > 0 && performance.now() - measureStarted > 8)) {\n                    continueMeasuring = true;\n                    break;\n                }\n                if (scrollAnchorHeight < 0) {",
  ],
  [
    '                if (i > 5) {\n                    console.warn(this.measureRequests.length\n                        ? "Measure loop restarted more than 5 times"\n                        : "Viewport failed to stabilize");\n                    break;\n                }\n',
    "",
  ],
  [
    "if (updated && !updated.empty)\n            for (let listener of this.state.facet(updateListener))",
    "if (continueMeasuring) this.requestMeasure();\n        if (updated && !updated.empty)\n            for (let listener of this.state.facet(updateListener))",
  ],
];

const pending = [];
const mergeDirectory = path.join(root, "node_modules", "@codemirror", "merge");
const { version: mergeVersion } = JSON.parse(
  await readFile(path.join(mergeDirectory, "package.json"), "utf8"),
);
for (const name of ["index.js", "index.cjs"]) {
  const file = path.join(mergeDirectory, "dist", name);
  const original = await readFile(file, "utf8");
  const normalized = normalizeLegacyMerge(original, mergeVersion);
  if (normalized !== original) pending.push([file, normalized]);
}
for (const name of ["index.js", "index.cjs"]) {
  const file = path.join(directory, "dist", name);
  const original = await readFile(file, "utf8");
  let patched = normalizeLegacyView(original, version);
  for (const change of changes) {
    const [before, after] = change.map((part) =>
      name === "index.cjs"
        ? part.replaceAll("Text.empty", "state.Text.empty")
        : part,
    );
    if (after && patched.split(after).length === 2) continue;
    if (!after && !patched.includes(before)) continue;
    if (patched.split(before).length !== 2)
      throw new Error(`Cannot safely patch @codemirror/view/${name}`);
    patched = patched.replace(before, after);
  }
  if (patched !== original) pending.push([file, patched]);
}
for (const [file, patched] of pending) await writeFile(file, patched);
