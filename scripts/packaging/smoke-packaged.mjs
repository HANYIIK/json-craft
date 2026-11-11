import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
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

async function copyEditor(page, testId) {
  const content = page.getByTestId(testId).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const copied = await content.evaluate((element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return data.getData("text/plain");
  });
  await content.press("ArrowLeft");
  return copied;
}

async function compare(page) {
  const button = page.getByTestId("compare-json");
  await poll(
    () => button.isEnabled(),
    Boolean,
    "Packaged comparison inputs did not finish formatting",
  );
  await button.click();
  await page.getByTestId("comparison-result").waitFor();
  const editor = page.getByTestId("repair-diff-editor");
  await poll(
    () => editor.getAttribute("data-difference-count"),
    (value) => value !== null,
    "Packaged comparison diff did not initialize",
  );
  return editor;
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
  const historyCount = await page.evaluate(
    async () => (await window.desktop.workspace.load()).records.length,
  );
  await page.getByTestId("open-comparison").click();
  assert.equal(
    await page.getByTestId("open-comparison").innerText(),
    "JSON Compare",
  );
  const rows = Array.from({ length: 28 }, (_, id) => ({
    id,
    value: `item-${id}`,
  }));
  const left = JSON.stringify({
    title: "Reference",
    payload: '{"id":900719925474099312345,"name":"Release smoke"}',
    items: ['{"enabled":true,"label":"nested"}'],
    rows,
    tail: true,
  });
  const right = {
    tail: true,
    rows: rows.map(({ id, value }) => ({ value, id })),
    items: ['{"label":"nested","enabled":true}'],
    payload: '{"name":"Release smoke","id":900719925474099312345}',
    title: "Reference",
  };
  await page.getByTestId("comparison-left").locator(".cm-content").fill(left);
  await page
    .getByTestId("comparison-right")
    .locator(".cm-content")
    .fill(JSON.stringify(right));
  const equalDiff = await compare(page);
  assert.equal(await equalDiff.getAttribute("data-difference-count"), "0");
  const reference = await copyEditor(page, "diff-before");
  assert.equal(await copyEditor(page, "diff-after"), reference);
  assert.ok(reference.includes("900719925474099312345"));
  assert.ok(reference.includes('"payload": {'));
  assert.ok(reference.includes('"enabled": true'));
  await page.getByTestId("comparison-back").click();
  right.title = "Updated";
  right.rows[24].value = "changed";
  right.tail = false;
  await page
    .getByTestId("comparison-right")
    .locator(".cm-content")
    .fill(JSON.stringify({ ...right, added: true }));
  const changedDiff = await compare(page);
  const differences = Number(
    await changedDiff.getAttribute("data-difference-count"),
  );
  assert.ok(differences >= 3);
  assert.equal(
    await page.getByTestId("comparison-full-file").getAttribute("aria-pressed"),
    "false",
  );
  assert.ok(
    await page.getByTestId("diff-after").locator(".cm-collapsedLines").count(),
  );
  assert.equal(await copyEditor(page, "diff-before"), reference);
  const alignedText = await copyEditor(page, "diff-after");
  assert.ok(alignedText.includes("900719925474099312345"));
  const aligned = JSON.parse(alignedText);
  assert.deepEqual(Object.keys(aligned), [
    "title",
    "payload",
    "items",
    "rows",
    "tail",
    "added",
  ]);
  assert.deepEqual(
    aligned.rows.map((row) => row.id),
    rows.map((row) => row.id),
  );
  assert.equal(aligned.rows[24].value, "changed");
  assert.equal(aligned.title, "Updated");
  assert.equal(aligned.added, true);
  await page.getByTestId("comparison-next").click();
  await poll(
    () => changedDiff.getAttribute("data-active-difference"),
    (value) => value === "1",
    "Packaged comparison did not navigate to the next difference",
  );
  await page.getByTestId("comparison-back").click();
  const largeRows = Array.from({ length: 1_000 }, (_, index) =>
    Object.fromEntries(
      Array.from({ length: 10 }, (_, field) => [
        `field${field}`,
        `before-${String(index).padStart(4, "0")}-${field}`,
      ]),
    ),
  );
  const largeLeft = JSON.stringify(largeRows, null, 2);
  const largeRight = JSON.stringify(
    largeRows.map((row, index) => ({
      ...row,
      field5:
        index % 20 === 0 ? row.field5.replace("before", "after") : row.field5,
    })),
    null,
    2,
  );
  assert.equal(largeLeft.split("\n").length, 12_002);
  await page.evaluate(
    ({ left, right }) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([left], "large-left.json", { type: "application/json" }),
      );
      transfer.items.add(
        new File([right], "large-right.json", { type: "application/json" }),
      );
      document
        .querySelector(".application")
        .dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
    },
    { left: largeLeft, right: largeRight },
  );
  const largeDiff = await compare(page);
  await poll(
    () => largeDiff.getAttribute("data-difference-count"),
    (value) => value === "50",
    "Packaged large JSON comparison combined separate changes into coarse blocks",
  );
  assert.equal(await largeDiff.getAttribute("data-chunk-count"), "50");
  assert.equal(await largeDiff.getAttribute("data-added-lines"), "50");
  assert.equal(await largeDiff.getAttribute("data-removed-lines"), "50");
  assert.equal(await largeDiff.getAttribute("data-precise"), "true");
  await page.getByTestId("comparison-next").click();
  await poll(
    () => largeDiff.getAttribute("data-active-difference"),
    (value) => value === "1",
    "Packaged large JSON comparison did not navigate to the next difference",
  );
  await poll(
    () =>
      page
        .getByTestId("diff-after")
        .locator(".cm-line")
        .filter({ hasText: "after-0020-5" })
        .locator(".cm-changedText")
        .filter({ hasText: "after" })
        .count(),
    (value) => value > 0,
    "Packaged large JSON comparison did not highlight the next changed value",
  );
  assert.equal(
    await page.evaluate(
      async () => (await window.desktop.workspace.load()).records.length,
    ),
    historyCount,
  );
  assert.equal(await readFile(record.managedPath, "utf8"), damaged);
  const previousFiles = await readdir(fileDirectory);
  const previousIds = await page.evaluate(async () => {
    const workspace = await window.desktop.workspace.load();
    return workspace.records.map((item) => item.id);
  });
  await page.getByTestId("open-log-extraction").click();
  assert.equal(
    await page.getByTestId("open-log-extraction").innerText(),
    "JSON Extract",
  );
  const firstExtracted = {
    marker: "kept-first",
    payload: JSON.stringify({ enabled: true }),
    note: "[REDACTED]",
    link: "[View profile](https://example.com/profile?id=1)",
  };
  const firstPreview = JSON.stringify(
    { ...firstExtracted, payload: { enabled: true } },
    null,
    2,
  );
  const lastExtracted =
    '{"marker":"kept-third","id":900719925474099312345,"items":["{\\"nested\\":true}"]}';
  const lastPreview = [
    "{",
    '  "marker": "kept-third",',
    '  "id": 900719925474099312345,',
    '  "items": [',
    "    {",
    '      "nested": true',
    "    }",
    "  ]",
    "}",
  ].join("\n");
  const mixedLog = [
    "[INFO] Request started; [REDACTED] [View profile](https://example.com/profile?id=1)",
    `INFO response=${JSON.stringify(firstExtracted)}`,
    'DEBUG body={"marker":"closed-result","drop":true}',
    `INFO escaped=${JSON.stringify(lastExtracted)} done`,
  ].join("\n");
  await page
    .getByTestId("log-input-editor")
    .locator(".cm-content")
    .fill(mixedLog);
  await page.getByTestId("extract-log-json").click();
  const extraction = page.getByTestId("log-extraction-page");
  const tabs = page.getByTestId("log-result-tabs").locator(".log-result-tab");
  await poll(
    async () => ({
      count: await tabs.count(),
      busy: await extraction
        .locator(".log-results-panel")
        .getAttribute("aria-busy"),
    }),
    ({ count, busy }) => count === 3 && busy === "false",
    "Packaged log extraction did not find exactly three JSON results",
  );
  await poll(
    () => copyEditor(page, "log-preview-editor"),
    (value) => value === firstPreview,
    "Packaged extracted preview did not decode nested JSON or preserve ordinary text",
  );
  await tabs.nth(2).getByRole("tab").click();
  await poll(
    () => copyEditor(page, "log-preview-editor"),
    (value) => value === lastPreview,
    "Packaged result tabs lost encoded JSON or large integer precision",
  );
  await page.getByTestId("log-preview-expand").click();
  await poll(
    () => extraction.getAttribute("data-preview-expanded"),
    (value) => value === "true",
    "Packaged extracted preview did not expand",
  );
  assert.equal(await page.getByTestId("log-input-editor").isVisible(), false);
  await poll(
    () => copyEditor(page, "log-preview-editor"),
    (value) => value === lastPreview,
    "Packaged expanded preview did not finish rendering",
  );
  const previewCopy = extraction.locator(".log-preview-footer .copy-button");
  await previewCopy.click();
  await poll(
    () => previewCopy.getAttribute("data-copied"),
    (value) => value === "true",
    "Packaged extracted preview did not acknowledge copying",
  );
  assert.equal(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    lastPreview,
  );
  await page.getByTestId("log-preview-back").click();
  await tabs.nth(1).hover();
  await tabs.nth(1).locator(".log-tab-close").click();
  assert.equal(await tabs.count(), 2);
  const migrate = page.getByTestId("log-migrate-all");
  await migrate.click();
  await poll(
    () =>
      tabs.evaluateAll(
        (elements) =>
          elements.filter((item) => item.dataset.migrated === "true").length,
      ),
    (value) => value === 2,
    "Packaged extraction migration did not mark both open results as saved",
  );
  assert.equal(await migrate.isDisabled(), true);
  const migratedRecords = await page.evaluate(async (ids) => {
    const workspace = await window.desktop.workspace.load();
    return Promise.all(
      workspace.records
        .filter((item) => !ids.includes(item.id))
        .map((item) => window.desktop.workspace.read(item.id)),
    );
  }, previousIds);
  assert.equal(migratedRecords.length, 2);
  assert.deepEqual(
    migratedRecords.map((item) => item.raw).sort(),
    [firstPreview, lastPreview].sort(),
  );
  for (const item of migratedRecords) {
    assert.ok(item.managedPath);
    assert.ok(!item.fileSaveError);
    assert.match(item.name, /^extracted-\d+\.json$/);
    assert.equal(path.dirname(item.managedPath), fileDirectory);
    assert.equal(await readFile(item.managedPath, "utf8"), item.raw);
  }
  assert.deepEqual(
    (await readdir(fileDirectory)).sort(),
    [
      ...previousFiles,
      ...migratedRecords.map((item) => path.basename(item.managedPath)),
    ].sort(),
  );
  await migrate.evaluate((button) => button.click());
  assert.equal(
    await page.evaluate(
      async () => (await window.desktop.workspace.load()).records.length,
    ),
    historyCount + 2,
  );
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
        "json-compare",
        "key-order-alignment",
        "comparison-context-navigation",
        "large-json-diff",
        "log-json-extraction",
        "result-tabs",
        "log-result-migration",
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
