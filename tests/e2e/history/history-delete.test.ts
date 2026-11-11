import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";
import { chooseHistoryAction } from "../support/history-menu";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const probeKey = "__jsonCraftHistoryDelete";

interface Probe {
  mode: "normal" | "fail" | "hold";
  attempts: string[];
  moved: { source: string; destination: string }[];
  pendingTrash: (() => void)[];
  holdUpdateId: string | null;
  pendingUpdates: (() => void)[];
}

async function poll<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (matches(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function probeState(application: ElectronApplication) {
  return application.evaluate((_electron, key) => {
    const probe = Reflect.get(globalThis, key) as Probe;
    return {
      attempts: probe.attempts,
      moved: probe.moved,
      pendingTrash: probe.pendingTrash.length,
      pendingUpdates: probe.pendingUpdates.length,
    };
  }, probeKey);
}

async function changeProbe(
  application: ElectronApplication,
  patch: { mode?: Probe["mode"]; holdUpdateId?: string | null },
) {
  await application.evaluate(
    (_electron, value) => {
      const probe = Reflect.get(globalThis, value.key) as Probe;
      Object.assign(probe, value.patch);
      if (value.patch.mode && value.patch.mode !== "hold")
        probe.pendingTrash.splice(0).forEach((finish) => finish());
      if (value.patch.holdUpdateId === null)
        probe.pendingUpdates.splice(0).forEach((finish) => finish());
    },
    { key: probeKey, patch },
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

async function savedRecord(page: Page, raw: string) {
  const record = await poll(
    async () => {
      const state = await loadWorkspace(page);
      return state.activeId ? readHistory(page, state.activeId) : null;
    },
    (value) => value?.raw === raw && Boolean(value.managedPath),
    "The active input did not persist its managed JSON file",
  );
  assert.ok(record?.managedPath);
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (value) => value === "saved",
    "The active input did not finish auto-saving",
  );
  assert.equal(await readFile(record.managedPath, "utf8"), raw);
  return record as HistoryRecord & { managedPath: string };
}

async function createInput(page: Page, raw: string) {
  await page.getByRole("button", { name: "新建输入", exact: true }).click();
  await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
  return savedRecord(page, raw);
}

async function openDelete(page: Page, record: HistoryRecord) {
  await chooseHistoryAction(page, record.name, "delete");
  const dialog = page.getByTestId("delete-confirmation");
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute("role"), "alertdialog");
  assert.equal(
    await dialog.locator(".delete-confirmation-name").innerText(),
    record.name,
  );
  if (record.managedPath)
    assert.equal(await dialog.locator("code").innerText(), record.managedPath);
  return dialog;
}

async function expectRetained(page: Page, record: HistoryRecord) {
  assert.ok(
    (await loadWorkspace(page)).records.some((entry) => entry.id === record.id),
  );
  assert.equal((await readHistory(page, record.id)).raw, record.raw);
  if (record.managedPath)
    assert.equal(await readFile(record.managedPath, "utf8"), record.raw);
}

async function expectRemoved(page: Page, record: HistoryRecord) {
  await page.getByTestId("delete-confirmation").waitFor({ state: "detached" });
  assert.equal(
    (await loadWorkspace(page)).records.some((entry) => entry.id === record.id),
    false,
  );
  assert.equal(
    await page.locator(`[data-history-id="${record.id}"]`).count(),
    0,
  );
  if (record.managedPath)
    await assert.rejects(access(record.managedPath), { code: "ENOENT" });
}

async function importFile(
  application: ElectronApplication,
  page: Page,
  filePath: string,
  raw: string,
) {
  await application.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [source],
    })) as typeof dialog.showOpenDialog;
  }, filePath);
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  await poll(
    () => page.getByRole("heading", { level: 1 }).innerText(),
    (name) => name.trim() === path.basename(filePath),
    "The imported file did not become active",
  );
  return savedRecord(page, raw);
}

test(
  "history deletion confirms isolated JSON trashing and preserves recoverable failures",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-history-delete-"),
    );
    const root = await realpath(workspace);
    const artifacts = path.join(projectRoot, "output", "playwright");
    await mkdir(artifacts, { recursive: true });
    const profile = path.join(root, "profile");
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = "delete-sample";
    config.settings.theme = "light";
    const sample: HistoryRecord = {
      id: "delete-sample",
      name: "history-only.json",
      raw: '{"sample":true}',
      source: "sample",
      options: { indent: "2", autoUnescape: true, repair: true },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      path.join(config.settings.historyDirectory, `history-${sample.id}.json`),
      JSON.stringify(sample),
    );
    await writeFile(configPath, JSON.stringify(config));
    const bootstrap = path.join(root, "safe-trash.cjs");
    await writeFile(
      bootstrap,
      `const { shell, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const probe = { mode: "normal", attempts: [], moved: [], pendingTrash: [], holdUpdateId: null, pendingUpdates: [] };
Reflect.set(globalThis, ${JSON.stringify(probeKey)}, probe);
shell.trashItem = async (filePath) => {
  const source = await fs.realpath(filePath);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await fs.lstat(filePath)).isFile()) throw new Error("Unsafe test trash path");
  probe.attempts.push(source);
  if (probe.mode === "fail") throw new Error("Mock trash permission failure");
  if (probe.mode === "hold") await new Promise(resolve => probe.pendingTrash.push(resolve));
  const trash = path.join(root, "trash");
  await fs.mkdir(trash, { recursive: true });
  const destination = path.join(trash, String(probe.moved.length) + "-" + path.basename(source));
  await fs.rename(source, destination);
  probe.moved.push({ source, destination });
};
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, channel === "json-craft:workspace:update" ? async (event, ...args) => {
  const result = await listener(event, ...args);
  if (args[0] === probe.holdUpdateId) await new Promise(resolve => probe.pendingUpdates.push(resolve));
  return result;
} : listener);
require(${JSON.stringify(path.join(projectRoot, "electron", "main.cjs"))});
`,
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    t.after(async () => {
      try {
        if (application) {
          await changeProbe(application, {
            mode: "normal",
            holdUpdateId: null,
          });
          await application.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    application = await _electron.launch({
      args: [bootstrap, `--user-data-dir=${profile}`],
      cwd: projectRoot,
      env: environment,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "新建输入", exact: true }).waitFor();
    let lightDialogColor = "";
    let retained: HistoryRecord & { managedPath: string };

    await t.test(
      "history-only records require confirmation with Cancel focused by default",
      async () => {
        const dialog = await openDelete(page, sample);
        assert.equal(
          await dialog.getByRole("heading", { level: 2 }).innerText(),
          "删除这条历史记录？",
        );
        assert.equal(await dialog.locator("code").count(), 0);
        assert.match(await dialog.innerText(), /只会删除应用历史记录/);
        assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "light",
        );
        lightDialogColor = await dialog.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        assert.equal(
          await dialog
            .getByRole("button", { name: "取消", exact: true })
            .evaluate((button) => document.activeElement === button),
          true,
        );
        await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "detached" });
        await expectRetained(page, sample);
        await openDelete(page, sample);
        await dialog
          .getByRole("button", { name: "删除记录", exact: true })
          .click();
        await expectRemoved(page, sample);
        assert.equal((await probeState(application!)).attempts.length, 0);
      },
    );

    await t.test(
      "Enter, Escape and backdrop cancellation keep files, records and rename drafts",
      async () => {
        retained = await createInput(page, '{"keep":"until confirmed"}');
        await chooseHistoryAction(page, retained.name, "rename");
        const filename = page.getByRole("textbox", {
          name: "文件名",
          exact: true,
        });
        await filename.fill("uncommitted-delete-draft.json");
        for (const action of ["Enter", "Escape", "backdrop"] as const) {
          const dialog = await openDelete(page, retained);
          assert.match(
            await dialog.innerText(),
            /关联的 JSON 文件将移到系统废纸篓，同时删除应用历史记录。/,
          );
          if (action === "Enter")
            await page.screenshot({
              path: path.join(artifacts, "history-delete-zh-CN-light.png"),
            });
          if (action === "backdrop") await page.mouse.click(4, 4);
          else await page.keyboard.press(action);
          await dialog.waitFor({ state: "detached" });
          await poll(
            () => filename.isEnabled(),
            Boolean,
            "Cancellation did not restore the rename input",
          );
          assert.equal(
            await filename.inputValue(),
            "uncommitted-delete-draft.json",
          );
          await expectRetained(page, retained);
          assert.equal((await probeState(application!)).attempts.length, 0);
        }
        await filename.press("Escape");
      },
    );

    await t.test(
      "saving blocks confirmation and an in-flight trash cannot be cancelled",
      async () => {
        const record = await createInput(page, '{"saving":"before"}');
        const updated = '{"saving":"latest bytes"}';
        await changeProbe(application!, { holdUpdateId: record.id });
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .fill(updated);
        await poll(
          () => probeState(application!),
          (state) => state.pendingUpdates === 1,
          "The delayed auto-save did not start",
        );
        const dialog = await openDelete(page, record);
        const submit = dialog.locator(".delete-confirmation-submit");
        assert.equal(await submit.isEnabled(), false);
        assert.match(
          await dialog.getByRole("status").innerText(),
          /正在完成自动保存/,
        );
        assert.equal((await probeState(application!)).attempts.length, 0);
        await changeProbe(application!, { mode: "hold", holdUpdateId: null });
        await poll(
          () => submit.isEnabled(),
          Boolean,
          "Confirmation stayed blocked after saving finished",
        );
        await submit.click();
        await poll(
          () => probeState(application!),
          (state) => state.pendingTrash === 1,
          "The isolated trash operation did not start",
        );
        assert.equal(await dialog.getAttribute("aria-busy"), "true");
        assert.equal(await submit.isEnabled(), false);
        assert.equal(
          await dialog
            .getByRole("button", { name: "取消", exact: true })
            .isEnabled(),
          false,
        );
        await page.keyboard.press("Escape");
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await readFile(record.managedPath, "utf8"), updated);
        await changeProbe(application!, { mode: "normal" });
        await expectRemoved(page, record);
        const moved = (await probeState(application!)).moved.find(
          (entry) => entry.source === record.managedPath,
        );
        assert.ok(moved);
        assert.equal(await readFile(moved.destination, "utf8"), updated);
        const lateUpdate = await page.evaluate(async (value) => {
          try {
            await window.desktop!.workspace.update(value.id, {
              raw: '{"late":true}',
              options: value.options,
              extraction: null,
            });
            return "unexpected success";
          } catch (error) {
            return String(error);
          }
        }, record);
        assert.match(lateUpdate, /已删除|不存在|deleted|exist/i);
        await delay(450);
        await expectRemoved(page, record);
      },
    );

    await t.test(
      "the dialog stays busy until another history entry's queued save settles",
      async () => {
        const sibling = await createInput(page, '{"sibling":"before"}');
        const updated = '{"sibling":"saved after deletion"}';
        await changeProbe(application!, { holdUpdateId: sibling.id });
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .fill(updated);
        await poll(
          () => probeState(application!),
          (state) => state.pendingUpdates === 1,
          "The sibling auto-save did not start",
        );
        await page
          .locator(`[data-history-id="${retained.id}"] .history-entry-select`)
          .click();
        const dialog = await openDelete(page, retained);
        await dialog
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await poll(
          () => dialog.getAttribute("aria-busy"),
          (value) => value === "true",
          "The confirmation did not wait for the sibling auto-save",
        );
        await delay(100);
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await dialog.getAttribute("aria-busy"), "true");
        assert.equal((await probeState(application!)).pendingUpdates, 1);
        await changeProbe(application!, { holdUpdateId: null });
        await expectRemoved(page, retained);
        assert.ok(
          (await probeState(application!)).moved.some(
            (entry) => entry.source === retained.managedPath,
          ),
        );
        assert.equal((await readHistory(page, sibling.id)).raw, updated);
        assert.equal(await readFile(sibling.managedPath, "utf8"), updated);
        await delay(450);
        await expectRemoved(page, retained);
      },
    );

    await t.test(
      "trash failure remains inside the dialog and retry preserves the original bytes",
      async () => {
        const record = await createInput(page, '{"retry":"original bytes"}');
        await changeProbe(application!, { mode: "fail" });
        const dialog = await openDelete(page, record);
        await dialog
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await dialog.getByRole("alert").waitFor();
        assert.match(
          await dialog.getByRole("alert").innerText(),
          /Mock trash permission failure/,
        );
        await expectRetained(page, record);
        assert.equal(
          await dialog
            .getByRole("button", { name: "删除文件", exact: true })
            .isEnabled(),
          true,
        );
        await changeProbe(application!, { mode: "normal" });
        await dialog
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await expectRemoved(page, record);
        const state = await probeState(application!);
        assert.equal(
          state.attempts.filter((source) => source === record.managedPath)
            .length,
          2,
        );
        const moved = state.moved.find(
          (entry) => entry.source === record.managedPath,
        );
        assert.ok(moved);
        assert.equal(await readFile(moved.destination, "utf8"), record.raw);
      },
    );

    await t.test(
      "an external import deletes its managed copy and preserves its source",
      async () => {
        const directory = path.join(root, "external");
        await mkdir(directory);
        const source = path.join(directory, "external-original.json");
        const raw = '{"source":"external original"}';
        await writeFile(source, raw);
        const record = await importFile(application!, page, source, raw);
        assert.equal(record.sourcePath, source);
        assert.notEqual(record.managedPath, source);
        const dialog = await openDelete(page, record);
        await dialog
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await expectRemoved(page, record);
        assert.equal(await readFile(source, "utf8"), raw);
        assert.equal(
          (await probeState(application!)).attempts.includes(source),
          false,
        );
      },
    );

    await t.test(
      "a same-directory import deletes the reused original JSON file",
      async () => {
        const source = path.join(
          config.settings.writeDirectory,
          "same-directory-original.json",
        );
        const raw = '{"source":"same directory original"}';
        await writeFile(source, raw);
        const record = await importFile(application!, page, source, raw);
        assert.equal(record.sourcePath, source);
        assert.equal(record.managedPath, source);
        const dialog = await openDelete(page, record);
        await dialog
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await expectRemoved(page, record);
        const moved = (await probeState(application!)).moved.find(
          (entry) => entry.source === source,
        );
        assert.ok(moved);
        assert.equal(await readFile(moved.destination, "utf8"), raw);
      },
    );

    await t.test(
      "the confirmation follows English and the dark theme",
      async () => {
        const record = await createInput(page, '{"appearance":"english dark"}');
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "深色", exact: true }).click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .nth(1)
          .click();
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await poll(
          () => page.locator("html").getAttribute("lang"),
          (value) => value === "en",
          "The English language did not apply",
        );
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The dark theme did not apply",
        );
        await page.locator(".workspace-settings-back").click();
        const dialog = await openDelete(page, record);
        assert.match(
          await dialog.getByRole("heading", { level: 2 }).innerText(),
          /Delete this history entry\?/,
        );
        assert.match(await dialog.innerText(), /Trash|trash|Recycle Bin/);
        assert.equal(
          await dialog
            .getByRole("button", { name: "Delete file", exact: true })
            .isEnabled(),
          true,
        );
        const cancel = dialog.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        assert.equal(
          await cancel.evaluate((button) => document.activeElement === button),
          true,
        );
        assert.notEqual(
          await dialog.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
          lightDialogColor,
        );
        await page.screenshot({
          path: path.join(artifacts, "history-delete-en-dark.png"),
        });
        await cancel.click();
        await dialog.waitFor({ state: "detached" });
        await expectRetained(page, record);
      },
    );

    assert.deepEqual(errors, []);
  },
);
