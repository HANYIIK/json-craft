import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";

import { isolateWorkspace } from "../support/workspace-fixture";
import { chooseHistoryAction } from "../support/history-menu";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function editorText(page: Page, pane: "input" | "output") {
  return (
    await page
      .getByTestId(`${pane}-editor`)
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, expected: string) {
  await poll(
    () => editorText(page, "output"),
    (value) => value === expected,
    "The dropped JSON was not automatically formatted",
  );
}

async function loadWorkspace(page: Page) {
  return page.evaluate(() => window.desktop!.workspace.load());
}

async function readHistory(page: Page, id: string) {
  return page.evaluate(
    (recordId) => window.desktop!.workspace.read(recordId),
    id,
  );
}

async function waitStoredRecord(page: Page, name: string, raw: string) {
  const saved = await poll(
    async () => {
      const state = await loadWorkspace(page);
      const summary = state.records.find((record) => record.name === name);
      return summary ? readHistory(page, summary.id) : null;
    },
    (record) => record?.raw === raw,
    `The imported history entry was not saved: ${name}`,
  );
  assert.ok(saved);
  return saved;
}

async function selectRecord(page: Page, name: string) {
  await page
    .getByRole("button", {
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}，`),
    })
    .click();
  await poll(
    () => page.getByRole("heading", { level: 1 }).innerText(),
    (value) => value.trim() === name,
    "The dropped document did not become active",
  );
}

async function dropFiles(page: Page, target: Locator, paths: string[]) {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.id = "e2e-drop-files";
    document.body.append(input);
  });
  const input = page.locator("#e2e-drop-files");
  try {
    await input.setInputFiles(paths);
    const nativePaths = await input.evaluate((element) =>
      Array.from((element as HTMLInputElement).files ?? []).map((file) =>
        window.desktop!.getPathForFile(file),
      ),
    );
    assert.ok(
      nativePaths.length === paths.length && nativePaths.every(Boolean),
      `Native dropped file paths were lost: ${JSON.stringify(nativePaths)}`,
    );
    assert.deepEqual(
      await Promise.all(nativePaths.map((filePath) => realpath(filePath))),
      await Promise.all(paths.map((filePath) => realpath(filePath))),
    );
    const dataTransfer = await input.evaluateHandle((element) => {
      const transfer = new DataTransfer();
      for (const file of (element as HTMLInputElement).files ?? [])
        transfer.items.add(file);
      return transfer;
    });
    try {
      const transferredPaths = await dataTransfer.evaluate((transfer) =>
        Array.from(transfer.files).map((file) =>
          window.desktop!.getPathForFile(file),
        ),
      );
      assert.deepEqual(transferredPaths, nativePaths);
      await target.dispatchEvent("dragenter", { dataTransfer });
      await page.locator(".drop-overlay").waitFor();
      await target.dispatchEvent("dragover", { dataTransfer });
      await target.dispatchEvent("drop", { dataTransfer });
      await page.locator(".drop-overlay").waitFor({ state: "hidden" });
    } finally {
      await dataTransfer.dispose();
    }
  } finally {
    await input.evaluate((element) => element.remove());
  }
}

test(
  "Electron file drops create stored JSON copies without replacing current inputs",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-drop-"));
    const sources = path.join(workspace, "external-files");
    const storage = path.join(workspace, "stored-files");
    await Promise.all([mkdir(sources), mkdir(storage)]);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    let page!: Page;
    const errors: string[] = [];
    const close = async () => {
      const running = application;
      application = undefined;
      if (running) await running.close();
    };
    const launch = async () => {
      await isolateWorkspace(path.join(workspace, "user-data"));
      application = await _electron.launch({
        args: [
          projectRoot,
          `--user-data-dir=${path.join(workspace, "user-data")}`,
        ],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByTestId("input-editor")
        .locator('.cm-content[contenteditable="true"]')
        .waitFor();
    };
    const restart = async () => {
      await close();
      await launch();
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    await launch();
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    const storageInput = page.getByRole("textbox", {
      name: "文件存储目录",
      exact: true,
    });
    await storageInput.fill(storage);
    await storageInput.press("Tab");
    const canonicalStorage = await realpath(storage);
    await poll(
      async () => realpath((await loadWorkspace(page)).settings.writeDirectory),
      (directory) => directory === canonicalStorage,
      "The custom JSON storage directory was not saved",
    );
    await page
      .getByRole("button", { name: "关闭应用设置", exact: true })
      .click();

    await t.test(
      "shows a file overlay only during file drags and removes the old sidebar drop hint",
      async () => {
        assert.equal(await page.locator(".drop-hint").count(), 0);
        assert.equal(await page.locator(".drop-overlay").count(), 0);
        const textTransfer = await page.evaluateHandle(() => {
          const transfer = new DataTransfer();
          transfer.setData("text/plain", '{"notAFile":true}');
          return transfer;
        });
        try {
          await page.locator(".application").dispatchEvent("dragenter", {
            dataTransfer: textTransfer,
          });
          assert.equal(await page.locator(".drop-overlay").count(), 0);
          await page.locator(".application").dispatchEvent("dragleave", {
            dataTransfer: textTransfer,
          });
        } finally {
          await textTransfer.dispose();
        }
      },
    );

    await t.test(
      "drops into the input editor as a new document and preserves both the old input and original file bytes",
      async () => {
        const oldRaw = '{"existing":"must stay untouched"}';
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .fill(oldRaw);
        await expectOutput(page, JSON.stringify(JSON.parse(oldRaw), null, 2));
        const previous = await loadWorkspace(page);
        const oldId = previous.activeId;
        assert.ok(oldId);
        await poll(
          () => readHistory(page, oldId),
          (record) => record.raw === oldRaw,
          "The previous input was not saved before the file drop",
        );
        const source = path.join(sources, "editor-drop.json");
        const raw =
          '{"source":"外部文件","items":[1,2],"id":9007199254740993}\r\n';
        const bytes = Buffer.from(raw, "utf8");
        await writeFile(source, bytes);
        await dropFiles(
          page,
          page.getByTestId("input-editor").locator(".cm-content"),
          [source],
        );
        const imported = await waitStoredRecord(page, "editor-drop.json", raw);
        assert.notEqual(imported.id, oldId);
        assert.equal(
          (await loadWorkspace(page)).records.length,
          previous.records.length + 1,
        );
        assert.equal((await readHistory(page, oldId)).raw, oldRaw);
        assert.equal(
          await editorText(page, "input"),
          raw.replace(/\r\n/g, "\n"),
        );
        await expectOutput(
          page,
          '{\n  "source": "外部文件",\n  "items": [\n    1,\n    2\n  ],\n  "id": 9007199254740993\n}',
        );
        assert.ok(imported.sourcePath);
        assert.equal(
          await realpath(imported.sourcePath),
          await realpath(path.join(storage, "editor-drop.json")),
        );
        assert.deepEqual(await readFile(source), bytes);
        assert.deepEqual(await readFile(imported.sourcePath), bytes);
        await selectRecord(page, (await readHistory(page, oldId)).name);
        assert.equal(await editorText(page, "input"), oldRaw);
        await selectRecord(page, "editor-drop.json");
      },
    );

    await t.test(
      "accepts file drops on the titlebar, sidebar, and read-only output editor",
      async () => {
        for (const [name, target] of [
          ["titlebar-drop.json", page.locator(".titlebar")],
          ["sidebar-drop.json", page.locator(".brand")],
          [
            "output-drop.json",
            page.getByTestId("output-editor").locator(".cm-content"),
          ],
        ] as const) {
          const source = path.join(sources, name);
          const raw = JSON.stringify({ area: name });
          await writeFile(source, raw, "utf8");
          const previous = await loadWorkspace(page);
          const oldId = previous.activeId;
          assert.ok(oldId);
          const old = await readHistory(page, oldId);
          await dropFiles(page, target, [source]);
          const imported = await waitStoredRecord(page, name, raw);
          assert.equal(
            (await loadWorkspace(page)).records.length,
            previous.records.length + 1,
          );
          assert.equal((await readHistory(page, oldId)).raw, old.raw);
          assert.notEqual(imported.id, oldId);
          assert.deepEqual(
            await readFile(path.join(storage, name)),
            await readFile(source),
          );
          await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        }
      },
    );

    await t.test(
      "protects occupied basenames and reuses files already in the same canonical storage directory",
      async () => {
        const occupied = path.join(storage, "duplicate.json");
        const source = path.join(sources, "duplicate.json");
        const protectedBytes = Buffer.from('{"occupied":"do not overwrite"}');
        const bytes = Buffer.from('{"copied":"new original"}');
        await Promise.all([
          writeFile(occupied, protectedBytes),
          writeFile(source, bytes),
        ]);
        await dropFiles(page, page.locator(".application"), [source]);
        const imported = await waitStoredRecord(
          page,
          "duplicate-2.json",
          bytes.toString(),
        );
        assert.ok(imported.sourcePath);
        assert.equal(path.basename(imported.sourcePath), "duplicate-2.json");
        assert.deepEqual(await readFile(occupied), protectedBytes);
        assert.deepEqual(await readFile(source), bytes);
        assert.deepEqual(await readFile(imported.sourcePath), bytes);
        const existing = path.join(storage, "reuse.json");
        const alias = path.join(workspace, "storage-alias");
        const reuseRaw = '{"reuse":"same real directory"}';
        await writeFile(existing, reuseRaw, "utf8");
        await symlink(storage, alias, "dir");
        const previousFiles = (await readdir(storage)).sort();
        await dropFiles(page, page.locator(".application"), [
          path.join(alias, "reuse.json"),
        ]);
        const reused = await waitStoredRecord(page, "reuse.json", reuseRaw);
        assert.ok(reused.sourcePath);
        assert.equal(
          await realpath(reused.sourcePath),
          await realpath(existing),
        );
        assert.deepEqual((await readdir(storage)).sort(), previousFiles);
        assert.equal(await readFile(existing, "utf8"), reuseRaw);
      },
    );

    await t.test(
      "imports multiple JSON files while skipping other extensions and isolating UTF-8 and JSON errors",
      async () => {
        const good = path.join(sources, "batch-valid.json");
        const badJson = path.join(sources, "batch-invalid.json");
        const badEncoding = path.join(sources, "batch-encoding.json");
        const skipped = path.join(sources, "not-json.txt");
        const raw = '{"batch":true}';
        await Promise.all([
          writeFile(good, raw, "utf8"),
          writeFile(badJson, '{"bad":"\\uZZZZ"}', "utf8"),
          writeFile(badEncoding, Buffer.from([0xc3, 0x28])),
          writeFile(skipped, '{"skip":true}', "utf8"),
        ]);
        const previous = await loadWorkspace(page);
        await dropFiles(page, page.locator(".application"), [
          good,
          badJson,
          badEncoding,
          skipped,
        ]);
        await poll(
          () => loadWorkspace(page),
          (state) => state.records.length === previous.records.length + 3,
          "The multi-file drop did not create one history entry per JSON file",
        );
        await waitStoredRecord(page, "batch-valid.json", raw);
        assert.equal(
          (await loadWorkspace(page)).records.some(
            (record) => record.name === "not-json.txt",
          ),
          false,
        );
        await assert.rejects(access(path.join(storage, "not-json.txt")), {
          code: "ENOENT",
        });
        await selectRecord(page, "batch-invalid.json");
        await poll(
          () => page.getByTestId("processing-status").innerText(),
          (value) => /无法|失败|错误/.test(value),
          "Invalid dropped JSON was not reported",
        );
        await selectRecord(page, "batch-encoding.json");
        await poll(
          () => page.getByTestId("processing-status").innerText(),
          (value) => /UTF-8|编码|读取/.test(value),
          "A bad UTF-8 file did not retain its separate error state",
        );
        await selectRecord(page, "batch-valid.json");
        await expectOutput(page, '{\n  "batch": true\n}');
        assert.equal(
          await readFile(path.join(storage, "batch-valid.json"), "utf8"),
          raw,
        );
      },
    );

    await t.test(
      "recovers the same failed-copy record and preserves both copies after another drop",
      async () => {
        const source = path.join(sources, "retry-source.json");
        const raw = '{"storage":"failed initially","value":false}';
        await writeFile(source, raw, "utf8");
        const backup = path.join(workspace, "stored-files-backup");
        await rename(storage, backup);
        await writeFile(storage, "This path is temporarily a file.", "utf8");
        let failedId: string | null = null;
        try {
          await dropFiles(
            page,
            page.getByTestId("input-editor").locator(".cm-content"),
            [source],
          );
          await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
          assert.equal(await editorText(page, "input"), raw);
          await page
            .getByRole("button", { name: "重试保存", exact: true })
            .waitFor();
          failedId = await page
            .locator(".history-entry-selected")
            .getAttribute("data-history-id");
          assert.ok(failedId);
          await poll(
            () => readHistory(page, failedId!),
            (record) => record.raw === raw,
            "The failed-copy original was not retained in history",
          );
          await page
            .getByRole("button", { name: "检查文件存储目录", exact: true })
            .click();
          await page
            .getByRole("textbox", { name: "文件存储目录", exact: true })
            .waitFor();
          assert.equal(await readFile(source, "utf8"), raw);
        } finally {
          await rm(storage, { force: true });
          await rename(backup, storage);
        }
        await application!.evaluate(({ dialog }, directory) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [directory],
          })) as typeof dialog.showOpenDialog;
        }, storage);
        await page
          .getByRole("button", { name: "选择文件存储目录", exact: true })
          .click();
        await poll(
          () => page.locator(".workspace-settings-status").innerText(),
          (state) => state === "已自动保存",
          "The restored storage directory did not finish saving",
        );
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
        assert.ok(failedId);
        const recovered = await poll(
          () => readHistory(page, failedId!),
          (record) =>
            record.raw === raw &&
            Boolean(record.managedPath) &&
            !record.fileSaveError,
          "Restoring the directory did not recover the original history record",
        );
        assert.ok(recovered.managedPath);
        assert.equal(await readFile(recovered.managedPath, "utf8"), raw);
        await poll(
          () =>
            page.getByTestId("autosave-status").getAttribute("data-save-state"),
          (state) => state === "saved",
          "The recovered copy did not clear its automatic-save error",
        );
        await dropFiles(page, page.locator(".application"), [source]);
        await page
          .getByTestId("file-storage-error")
          .waitFor({ state: "hidden" });
        const state = await poll(
          () => loadWorkspace(page),
          (current) =>
            Boolean(
              current.activeId &&
              current.activeId !== failedId &&
              current.records.some((record) => record.id === current.activeId),
            ),
          "Re-dropping the recovered file did not create a new history entry",
        );
        assert.ok(state.activeId);
        const imported = await poll(
          () => readHistory(page, state.activeId!),
          (record) => record.raw === raw && Boolean(record.sourcePath),
          "Re-dropping did not persist the stored copy path",
        );
        assert.ok(imported.sourcePath);
        assert.equal(
          path.dirname(await realpath(imported.sourcePath)),
          await realpath(storage),
        );
        assert.notEqual(imported.sourcePath, recovered.managedPath);
        assert.equal(await readFile(imported.sourcePath, "utf8"), raw);
        assert.ok(failedId);
        assert.equal((await readHistory(page, failedId)).raw, raw);
        await chooseHistoryAction(page, imported.name, "rename");
        const filename = page.getByRole("textbox", {
          name: "文件名",
          exact: true,
        });
        await filename.fill("stored-renamed.json");
        await filename.press("Enter");
        await poll(
          () => readHistory(page, imported.id),
          (record) => record.name === "stored-renamed.json",
          "Renaming the recovered copy did not update history",
        );
        const renamed = path.join(storage, "stored-renamed.json");
        assert.equal(await readFile(renamed, "utf8"), raw);
        await assert.rejects(access(imported.sourcePath), {
          code: "ENOENT",
        });
        assert.equal(await readFile(recovered.managedPath, "utf8"), raw);
        assert.equal(await readFile(source, "utf8"), raw);
        assert.equal(
          await readFile(path.join(storage, "duplicate.json"), "utf8"),
          '{"occupied":"do not overwrite"}',
        );
      },
    );

    await t.test(
      "restores dropped history, original raw text, and stored paths after restarting",
      async () => {
        const previous = await loadWorkspace(page);
        const activeId = previous.activeId;
        assert.ok(activeId);
        const active = await readHistory(page, activeId);
        await restart();
        await poll(
          () => loadWorkspace(page),
          (state) =>
            state.activeId === activeId &&
            state.records.length === previous.records.length,
          "Restart did not restore dropped history and its active document",
        );
        assert.equal(await editorText(page, "input"), active.raw);
        await expectOutput(
          page,
          JSON.stringify(JSON.parse(active.raw), null, 2),
        );
        const restored = await readHistory(page, activeId);
        assert.equal(restored.name, "stored-renamed.json");
        assert.ok(restored.sourcePath);
        assert.equal(await readFile(restored.sourcePath, "utf8"), active.raw);
        assert.equal(
          await realpath((await loadWorkspace(page)).settings.writeDirectory),
          canonicalStorage,
        );
      },
    );

    await t.test(
      "finishes all drag-and-drop workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
