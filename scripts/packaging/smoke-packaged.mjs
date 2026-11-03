import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright";

const executablePath = process.argv[2];
const expectedArchitecture = process.argv[3];
const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
if (!executablePath || !["x64", "arm64"].includes(expectedArchitecture))
  throw new Error(
    "Usage: node scripts/packaging/smoke-packaged.mjs <executable> <x64|arm64>",
  );

async function poll(read, valid, message) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await read();
    if (valid(result)) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}

const root = await mkdtemp(path.join(os.tmpdir(), "json-craft-release-smoke-"));
const profile = path.join(root, "profile");
const files = path.join(root, "files");
const history = path.join(root, "history");
await Promise.all(
  [profile, files, history].map((directory) => mkdir(directory)),
);
const [fileDirectory, historyDirectory] = await Promise.all([
  realpath(files),
  realpath(history),
]);
await writeFile(
  path.join(profile, "workspace-settings.json"),
  JSON.stringify({
    version: 1,
    initialized: true,
    activeId: null,
    settings: {
      readDirectory: fileDirectory,
      writeDirectory: fileDirectory,
      historyDirectory,
      theme: "light",
      language: "en",
      autoCopy: false,
      recursiveUnescape: true,
    },
  }),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
let application;
try {
  application = await _electron.launch({
    executablePath: path.resolve(executablePath),
    args: [`--user-data-dir=${profile}`],
    env,
    timeout: 45_000,
  });
  const details = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    architecture: process.arch,
    version: app.getVersion(),
  }));
  assert.equal(details.packaged, true);
  assert.equal(details.architecture, expectedArchitecture);
  assert.equal(details.version, version);
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  const create = page.getByRole("button", { name: "New input", exact: true });
  await create.waitFor();
  await poll(
    () => create.isEnabled(),
    Boolean,
    "Packaged workspace did not become ready",
  );
  assert.equal(new URL(page.url()).protocol, "app:");
  await create.click();
  const input = page.getByTestId("input-editor").locator(".cm-content");
  const output = async () =>
    (
      await page
        .getByTestId("output-editor")
        .locator(".cm-line")
        .allTextContents()
    ).join("\n");
  const raw = JSON.stringify({
    payload: JSON.stringify({ ready: true, count: 3 }),
    items: [1, 2],
  });
  await input.fill(raw);
  const full = JSON.stringify(
    { payload: { ready: true, count: 3 }, items: [1, 2] },
    null,
    2,
  );
  await poll(
    output,
    (value) => value === full,
    "Packaged formatting worker failed",
  );
  await page
    .getByRole("textbox", { name: "Key to extract", exact: true })
    .fill("payload");
  await page
    .getByRole("button", { name: "Find and extract", exact: true })
    .click();
  await poll(
    output,
    (value) => value === JSON.stringify({ ready: true, count: 3 }, null, 2),
    "Packaged key extraction failed",
  );
  await page
    .getByRole("button", { name: "Show full JSON", exact: true })
    .click();
  const damaged = '{"name":"Release smoke" "items":[1,2,]}';
  await input.fill(damaged);
  await poll(
    output,
    (value) =>
      value ===
      JSON.stringify({ name: "Release smoke", items: [1, 2] }, null, 2),
    "Packaged JSON repair failed",
  );
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (value) => value === "saved",
    "Packaged file autosave failed",
  );
  const record = await poll(
    async () => {
      const saved = await page.evaluate(async () => {
        const workspace = await window.desktop.workspace.load();
        return workspace.activeId
          ? window.desktop.workspace.read(workspace.activeId)
          : null;
      });
      if (saved?.raw !== damaged || !saved.managedPath) return null;
      return (await readFile(saved.managedPath, "utf8").catch(() => null)) ===
        damaged
        ? saved
        : null;
    },
    Boolean,
    "Packaged history or JSON file did not persist the latest input",
  );
  assert.equal(record.raw, damaged);
  assert.equal(await readFile(record.managedPath, "utf8"), damaged);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      packagedApp: path.basename(executablePath),
      ...details,
      checks: [
        "renderer",
        "worker",
        "recursive-unescape",
        "key-extraction",
        "repair",
        "autosave",
      ],
    }),
  );
} finally {
  try {
    await application?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
