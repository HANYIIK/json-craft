import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = path.join(root, "node_modules", "@codemirror", "merge");
const { version } = JSON.parse(
  await readFile(path.join(directory, "package.json"), "utf8"),
);
if (version !== "6.12.3")
  throw new Error(`Unsupported @codemirror/merge version: ${version}`);

const changes = [
  [
    "function updateSpacers(a, b, chunks) {\n    let buildA =",
    "function updateSpacers(a, b, chunks) {\n    let geometry;\n    try {\n        const provider = a.dom[Symbol.for('json-craft.merge-geometry')];\n        if (typeof provider === 'function') geometry = provider();\n    } catch (_) {}\n    let buildA =",
  ],
  [
    "            let heightA = a.lineBlockAt(posA).top + offA;\n            let heightB = b.lineBlockAt(posB).top + offB;",
    "            const measured = geometry && geometry.line(posA, posB);\n            const actual = measured && Number.isFinite(measured.a) && Number.isFinite(measured.b);\n            let heightA = (actual ? measured.a : a.lineBlockAt(posA).top) + offA;\n            let heightB = (actual ? measured.b : b.lineBlockAt(posB).top) + offB;",
  ],
  [
    "    let docDiff = (a.contentHeight + offA) - (b.contentHeight + offB);",
    "    const measuredEnd = geometry && geometry.end();\n    const actualEnd = measuredEnd && Number.isFinite(measuredEnd.a) && Number.isFinite(measuredEnd.b);\n    let docDiff = ((actualEnd ? measuredEnd.a : a.contentHeight) + offA) - ((actualEnd ? measuredEnd.b : b.contentHeight) + offB);",
  ],
];
const pending = [];
for (const name of ["index.js", "index.cjs"]) {
  const file = path.join(directory, "dist", name);
  const original = await readFile(file, "utf8");
  let patched = original;
  for (const [before, after] of changes) {
    if (patched.split(after).length === 2) continue;
    if (patched.split(before).length !== 2)
      throw new Error(`Cannot safely patch @codemirror/merge/${name}`);
    patched = patched.replace(before, after);
  }
  if (patched !== original) pending.push([file, patched]);
}
for (const [file, patched] of pending) await writeFile(file, patched);
