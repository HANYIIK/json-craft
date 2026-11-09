const viewHunks = [
  [
    "if (heightMap.height - vpHeight < 10 || vpHeight >= 7000000)",
    "if (heightMap.height - vpHeight < 10 || vpHeight >= maxDOMHeight)",
  ],
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

const mergeHunks = [
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

function normalize(source, version, expected, name, hunks, markers) {
  if (version !== expected)
    throw new Error(
      `Unsupported @codemirror/${name} legacy source version: ${version}`,
    );
  let normalized = source;
  for (const [legacy, modern] of hunks) {
    const variants = new Map([
      [legacy, modern],
      [
        legacy.replaceAll("Text.empty", "state.Text.empty"),
        modern.replaceAll("Text.empty", "state.Text.empty"),
      ],
    ]);
    for (const [before, after] of variants) {
      const count = normalized.split(before).length - 1;
      if (count > 1)
        throw new Error(
          `Ambiguous legacy @codemirror/${name} patch; refusing to modify installed files`,
        );
      if (count === 1) normalized = normalized.replace(before, after);
    }
  }
  if (markers.some((marker) => normalized.includes(marker)))
    throw new Error(
      `Unrecognized legacy @codemirror/${name} patch; refusing to modify installed files`,
    );
  return normalized;
}

export function normalizeLegacyView(source, version) {
  return normalize(source, version, "6.43.15", "view", viewHunks, [
    "json-craft.shared-line-gaps",
    "sharedGapProvider",
    "sharedGapStart",
    "allGapViewports",
  ]);
}

export function normalizeLegacyMerge(source, version) {
  return normalize(source, version, "6.12.3", "merge", mergeHunks, [
    "json-craft.merge-geometry",
    "geometry && geometry.line",
    "geometry && geometry.end",
    "let geometry;",
    "const actualEnd = measuredEnd",
    "actual ? measured.a",
    "actual ? measured.b",
  ]);
}
