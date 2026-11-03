import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installed = path.join(root, "node_modules", "@codemirror", "search");
const before =
  'const basicNormalize = typeof String.prototype.normalize == "function"\n    ? x => x.normalize("NFKD") : x => x;';
const after =
  'const basicNormalize = typeof String.prototype.normalize == "function"\n    ? x => x.length == 1 && x.charCodeAt(0) < 128 ? x : x.normalize("NFKD") : x => x;';
const lowerBefore =
  "return new SearchCursor(state.doc, spec.unquoted, from, to, spec.caseSensitive ? undefined : x => x.toLowerCase(), test);";
const lowerAfter =
  "return new SearchCursor(state.doc, spec.unquoted, from, to, spec.caseSensitive ? undefined : x => { if (x.length == 1) { const code = x.charCodeAt(0); if (code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : x; } return x.toLowerCase(); }, test);";

export async function patchCodeMirrorSearch(directory = installed) {
  const { version } = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (version !== "6.7.2")
    throw new Error(`Unsupported @codemirror/search version: ${version}`);
  const pending = [];
  for (const name of ["index.js", "index.cjs"]) {
    const file = path.join(directory, "dist", name);
    const source = await readFile(file, "utf8");
    let patched = source;
    for (const [original, replacement] of [
      [before, after],
      [lowerBefore, lowerAfter],
    ]) {
      const originalCount = patched.split(original).length - 1;
      const patchedCount = patched.split(replacement).length - 1;
      if (originalCount === 0 && patchedCount === 1) continue;
      if (originalCount !== 1 || patchedCount !== 0)
        throw new Error(`Cannot safely patch @codemirror/search/${name}`);
      patched = patched.replace(original, replacement);
    }
    if (patched !== source) pending.push([file, patched]);
  }
  for (const [file, source] of pending) await writeFile(file, source);
}

await patchCodeMirrorSearch();
