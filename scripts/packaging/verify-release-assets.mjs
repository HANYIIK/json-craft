import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const responsePath = process.argv[2];
const directory = process.argv[3];
if (!responsePath || !directory)
  throw new Error(
    "Usage: node scripts/packaging/verify-release-assets.mjs <release-response.json> <asset-directory>",
  );
const release = JSON.parse(await readFile(responsePath, "utf8"));
assert.equal(
  release.draft,
  true,
  "Assets must be verified before the release is public",
);
const names = (await readdir(directory)).sort();
assert.deepEqual(
  release.assets.map((asset) => asset.name).sort(),
  names,
  "Remote release assets do not match the verified build set",
);
assert.ok(names.includes("SHA256SUMS"), "Missing checksum manifest");
for (const name of names) {
  const filePath = path.join(directory, name);
  const file = await stat(filePath);
  const remote = release.assets.find((asset) => asset.name === name);
  assert.ok(file.isFile() && file.size > 0, `Missing or empty asset: ${name}`);
  assert.equal(remote.state, "uploaded", `Upload incomplete: ${name}`);
  assert.equal(remote.size, file.size, `Remote size mismatch: ${name}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  assert.equal(
    remote.digest,
    `sha256:${hash.digest("hex")}`,
    `Remote checksum mismatch: ${name}`,
  );
}
console.log(
  `Verified ${names.length} uploaded release assets against local SHA-256 hashes.`,
);
