export function resolveDomHeightLimit(view) {
  const requested = Number(
    view?.dom?.getAttribute?.("data-json-craft-dom-height"),
  );
  return Number.isFinite(requested) && requested > 0
    ? Math.min(30_000_000, Math.max(1, Math.floor(requested)))
    : 7_000_000;
}

export function domHeightLimitPatches() {
  const resolver = resolveDomHeightLimit.toString();
  return [
    [
      "let scaler = this.scaler;\n        this.scaler = this.heightMap.height <= 7000000 /* VP.MaxDOMHeight */ ? IdScaler :\n            BigScaler.get(this.heightOracle, this.heightMap, this.viewports);",
      `let scaler = this.scaler;\n        const maxDOMHeight = (${resolver})(this.view);\n        this.scaler = this.heightMap.height <= maxDOMHeight ? IdScaler :\n            BigScaler.get(this.heightOracle, this.heightMap, this.viewports, maxDOMHeight);`,
    ],
    [
      "static get(oracle, heightMap, viewports) {",
      "static get(oracle, heightMap, viewports, maxDOMHeight = 7000000) {",
    ],
    [
      "if (heightMap.height - vpHeight < 10)",
      "if (heightMap.height - vpHeight < 10 || vpHeight >= maxDOMHeight)",
    ],
    [
      "let scale = (7000000 /* VP.MaxDOMHeight */ - vpHeight) / (heightMap.height - vpHeight);",
      "let scale = (maxDOMHeight - vpHeight) / (heightMap.height - vpHeight);",
    ],
  ];
}
