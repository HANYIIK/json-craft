import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import type {
  HistoryRecord,
  WorkspaceSettings,
} from "../../../src/shared/types";

import { isolateWorkspace } from "../support/workspace-fixture";

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

async function editorText(
  page: Page,
  editor: "input-editor" | "output-editor",
) {
  return (
    await page.getByTestId(editor).locator(".cm-line").allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, expected: string) {
  await poll(
    () => editorText(page, "output-editor"),
    (value) => value === expected,
    "The automatically restored result differs from the expected JSON",
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

async function canonicalSettings(settings: WorkspaceSettings) {
  const [readDirectory, writeDirectory, historyDirectory] = await Promise.all([
    realpath(settings.readDirectory),
    realpath(settings.writeDirectory),
    realpath(settings.historyDirectory),
  ]);
  return { ...settings, readDirectory, writeDirectory, historyDirectory };
}

async function waitSaved(page: Page, name: string, raw: string) {
  const record = await poll(
    async () => {
      const state = await loadWorkspace(page);
      const summary = state.records.find((entry) => entry.name === name);
      return summary ? readHistory(page, summary.id) : null;
    },
    (record) => record?.raw === raw,
    "The current input was not persisted in history",
  );
  assert.ok(record);
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (state) => state === "saved",
    "The UI did not confirm that history was saved",
  );
  return record;
}

async function renameCurrent(
  page: Page,
  name: string,
  commit: "Enter" | "blur" = "Enter",
) {
  const previous = (
    await page.getByRole("heading", { level: 1 }).innerText()
  ).trim();
  await page
    .getByRole("button", { name: `重命名 ${previous}`, exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "文件名", exact: true });
  await poll(
    () =>
      input.evaluate((element) => {
        const field = element as HTMLInputElement;
        return {
          focused: document.activeElement === field,
          value: field.value,
          start: field.selectionStart,
          end: field.selectionEnd,
        };
      }),
    (value) =>
      value.focused &&
      value.value === previous &&
      value.start === 0 &&
      value.end === previous.replace(/\.json$/i, "").length,
    "The rename field did not finish selecting the original base name",
  );
  await input.fill(name);
  assert.equal(
    await input.inputValue(),
    name,
    "The rename field changed the requested file name",
  );
  if (commit === "Enter") await input.press("Enter");
  else await page.getByRole("heading", { level: 1 }).click();
  await poll(
    () => page.getByRole("heading", { level: 1 }).innerText(),
    (value) => value.trim() === name,
    "Renaming did not update the active history entry",
  );
}

async function showSettings(page: Page) {
  const directory = page.getByRole("textbox", {
    name: "默认读取目录",
    exact: true,
  });
  if (!(await directory.isVisible())) {
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
  }
  await directory.waitFor();
}

test(
  "Electron history survives restarts and keeps native file operations consistent",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-history-"));
    const bootstrap = path.join(workspace, "safe-trash.cjs");
    await writeFile(
      bootstrap,
      `const { shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = ${JSON.stringify(await realpath(workspace))};
let sequence = 0;
shell.trashItem = async (filePath) => {
  const source = await fs.realpath(filePath);
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await fs.lstat(filePath)).isFile()) throw new Error("Unsafe test trash path");
  const trash = path.join(root, "trash");
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(source, path.join(trash, String(sequence++) + "-" + path.basename(source)));
};
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
    let page: Page;
    let userData = path.join(workspace, "primary-profile");
    const errors: string[] = [];
    let note: HistoryRecord;

    const close = async () => {
      const running = application;
      application = undefined;
      if (running) await running.close();
    };
    const launch = async () => {
      await isolateWorkspace(userData);
      application = await _electron.launch({
        args: [bootstrap, `--user-data-dir=${userData}`],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "新建输入", exact: true })
        .first()
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

    await t.test(
      "seeds the initial samples once and automatically saves a new renamed input",
      async () => {
        await poll(
          () => loadWorkspace(page),
          (state) => state.initialized && state.records.length === 3,
          "The first workspace did not initialize its three samples",
        );
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await renameCurrent(page, "persisted-note.json");
        const raw = '{"persisted":true,"items":[1,2]}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        note = await waitSaved(page, "persisted-note.json", raw);
        await restart();
        await poll(
          () => page.getByRole("heading", { level: 1 }).innerText(),
          (name) => name.trim() === note.name,
          "Restart did not restore the active document name",
        );
        assert.equal(await editorText(page, "input-editor"), raw);
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        assert.equal((await loadWorkspace(page)).activeId, note.id);
      },
    );

    await t.test(
      "restores the saved extraction and its formatted output after restarting",
      async () => {
        const raw = JSON.stringify({ payload: '{"answer":42}', context: true });
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(
          page,
          JSON.stringify({ payload: { answer: 42 }, context: true }, null, 2),
        );
        assert.equal(await editorText(page, "input-editor"), raw);
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, '{\n  "answer": 42\n}');
        await poll(
          () => readHistory(page, note.id),
          (record) =>
            record.raw === raw &&
            record.extraction?.key === "payload" &&
            record.extraction.path === "$.payload",
          "The chosen extraction was not persisted",
        );
        await restart();
        await expectOutput(page, '{\n  "answer": 42\n}');
        assert.equal(await editorText(page, "input-editor"), raw);
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .waitFor();
      },
    );

    await t.test(
      "flushes a just-edited source when the window closes before the debounce",
      async () => {
        const raw = '{"closedImmediately":"newest edit","value":false}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await close();
        await launch();
        await poll(
          () => editorText(page, "input-editor"),
          (value) => value === raw,
          "The edit made immediately before closing was lost",
        );
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        const saved = await readHistory(page, note.id);
        assert.equal(saved.raw, raw);
        assert.equal(saved.extraction?.key, "payload");
        assert.equal(saved.extraction?.path, "$.payload");
        assert.equal(
          await page
            .getByRole("textbox", { name: "提取 key 名称", exact: true })
            .inputValue(),
          "payload",
        );
        assert.equal(await page.locator(".key-current").count(), 0);
        assert.equal(
          await page
            .getByRole("button", { name: "返回完整 JSON", exact: true })
            .count(),
          0,
        );
      },
    );

    await t.test(
      "renames an imported managed copy on blur while preserving the external source",
      async () => {
        const directory = path.join(workspace, "native-source");
        await mkdir(directory);
        const original = path.join(directory, "source-import.json");
        const raw = '{"nativeRename":true}';
        await writeFile(original, raw, "utf8");
        assert.ok(application);
        await application.evaluate(({ dialog }, filePath) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [filePath],
          })) as typeof dialog.showOpenDialog;
        }, original);
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        await poll(
          () => page.getByRole("heading", { level: 1 }).innerText(),
          (name) => name.trim() === "source-import.json",
          "The imported source did not become active",
        );
        const imported = await waitSaved(page, "source-import.json", raw);
        assert.ok(imported.sourcePath);
        assert.equal(
          await realpath(imported.sourcePath),
          await realpath(original),
        );
        assert.ok(imported.managedPath);
        const renamed = path.join(
          path.dirname(imported.managedPath),
          "source-renamed.json",
        );
        await renameCurrent(page, "source-renamed.json", "blur");
        await poll(
          () => readFile(renamed, "utf8").catch(() => ""),
          (content) => content === raw,
          "Renaming history did not rename its managed copy",
        );
        await assert.rejects(access(imported.managedPath), { code: "ENOENT" });
        assert.equal(await readFile(original, "utf8"), raw);
        const saved = await readHistory(page, imported.id);
        assert.equal(saved.name, "source-renamed.json");
        assert.ok(saved.sourcePath);
        assert.equal(
          await realpath(saved.sourcePath),
          await realpath(original),
        );
        assert.ok(saved.managedPath);
        assert.equal(
          await realpath(saved.managedPath),
          await realpath(renamed),
        );
      },
    );

    await t.test(
      "refuses a conflicting managed copy rename without overwriting either file",
      async () => {
        const original = path.join(
          workspace,
          "native-source",
          "source-import.json",
        );
        const state = await loadWorkspace(page);
        const imported = state.records.find(
          (record) => record.name === "source-renamed.json",
        );
        assert.ok(imported);
        assert.ok(imported.managedPath);
        const source = imported.managedPath;
        const conflict = path.join(path.dirname(source), "already-there.json");
        const occupied = '{"occupied":"must remain unchanged"}';
        await writeFile(conflict, occupied, "utf8");
        await page
          .getByRole("button", {
            name: "重命名 source-renamed.json",
            exact: true,
          })
          .click();
        const filename = page.getByRole("textbox", {
          name: "文件名",
          exact: true,
        });
        await filename.fill("already-there.json");
        await filename.press("Enter");
        const renameError = page.locator(
          `[data-history-id="${imported.id}"] .history-entry-error`,
        );
        await renameError.waitFor();
        assert.match(
          await renameError.innerText(),
          /已存在|不能覆盖|冲突|EEXIST/,
        );
        assert.equal(await readFile(conflict, "utf8"), occupied);
        assert.equal(await readFile(source, "utf8"), '{"nativeRename":true}');
        assert.equal(await readFile(original, "utf8"), '{"nativeRename":true}');
        const saved = await readHistory(page, imported.id);
        assert.equal(saved.name, "source-renamed.json");
        assert.ok(saved.sourcePath);
        assert.equal(
          await realpath(saved.sourcePath),
          await realpath(original),
        );
        assert.ok(saved.managedPath);
        assert.equal(await realpath(saved.managedPath), await realpath(source));
        if (await filename.isVisible()) {
          await filename.fill("source-renamed.json");
          await filename.press("Enter");
        }
      },
    );

    await t.test(
      "keeps a deleted history record removed after restarting",
      async () => {
        await page
          .getByRole("button", {
            name: "删除 persisted-note.json",
            exact: true,
          })
          .click();
        await page
          .getByTestId("delete-confirmation")
          .getByRole("button", { name: "删除文件", exact: true })
          .click();
        await poll(
          () => loadWorkspace(page),
          (state) => !state.records.some((record) => record.id === note.id),
          "The deleted history record still exists",
        );
        await restart();
        const state = await loadWorkspace(page);
        assert.equal(
          state.records.some((record) => record.id === note.id),
          false,
        );
        assert.equal(
          await page
            .getByRole("button", {
              name: "重命名 persisted-note.json",
              exact: true,
            })
            .count(),
          0,
        );
      },
    );

    await t.test(
      "persists directory settings and supplies them to native file dialogs",
      async () => {
        const directories: WorkspaceSettings = {
          readDirectory: path.join(workspace, "default-read"),
          writeDirectory: path.join(workspace, "default-write"),
          historyDirectory: path.join(workspace, "custom-history"),
          theme: "system",
          autoCopy: false,
          recursiveUnescape: true,
          language: "zh-CN",
        };
        await Promise.all(
          [
            directories.readDirectory,
            directories.writeDirectory,
            directories.historyDirectory,
          ].map((directory) => mkdir(directory)),
        );
        const canonicalDirectories = await canonicalSettings(directories);
        await showSettings(page);
        const manualRead = path.join(workspace, "manual-read");
        await mkdir(manualRead);
        const readInput = page.getByRole("textbox", {
          name: "默认读取目录",
          exact: true,
        });
        await readInput.fill(manualRead);
        await readInput.press("Tab");
        const canonicalRead = await realpath(manualRead);
        await poll(
          async () =>
            realpath((await loadWorkspace(page)).settings.readDirectory).catch(
              () => null,
            ),
          (directory) => directory === canonicalRead,
          "The manual read directory did not persist",
        );
        for (const [label, setting] of [
          ["选择读取目录", "readDirectory"],
          ["选择文件存储目录", "writeDirectory"],
          ["选择历史存储目录", "historyDirectory"],
        ] as const) {
          assert.ok(application);
          await application.evaluate(({ dialog }, directory) => {
            dialog.showOpenDialog = (async () => ({
              canceled: false,
              filePaths: [directory],
            })) as typeof dialog.showOpenDialog;
          }, directories[setting]);
          await page.getByRole("button", { name: label, exact: true }).click();
          await poll(
            async () =>
              realpath((await loadWorkspace(page)).settings[setting]).catch(
                () => null,
              ),
            (directory) => directory === canonicalDirectories[setting],
            "A chosen workspace directory did not persist",
          );
        }
        assert.ok(
          (await readdir(directories.historyDirectory)).length > 0,
          "The selected history directory was not used for storage",
        );
        const previousIds = (await loadWorkspace(page)).records
          .map((record) => record.id)
          .sort();
        await restart();
        const restored = await loadWorkspace(page);
        assert.deepEqual(
          await canonicalSettings(restored.settings),
          canonicalDirectories,
        );
        assert.deepEqual(
          restored.records.map((record) => record.id).sort(),
          previousIds,
        );
        await showSettings(page);
        for (const [label, setting] of [
          ["默认读取目录", "readDirectory"],
          ["文件存储目录", "writeDirectory"],
          ["历史存储目录", "historyDirectory"],
        ] as const) {
          assert.equal(
            await realpath(
              await page
                .getByRole("textbox", { name: label, exact: true })
                .inputValue(),
            ),
            canonicalDirectories[setting],
          );
        }
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
        assert.ok(application);
        const openProbe = `__jsonCraftOpenDefault_${process.pid}`;
        await application.evaluate(({ dialog }, key) => {
          dialog.showOpenDialog = (async (...args: unknown[]) => {
            const options = args.at(-1) as { defaultPath?: string };
            Reflect.set(globalThis, key, options.defaultPath);
            return { canceled: true, filePaths: [] };
          }) as typeof dialog.showOpenDialog;
        }, openProbe);
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        const openDefault = await poll(
          () =>
            application!.evaluate(
              (_electron, key) =>
                Reflect.get(globalThis, key) as string | undefined,
              openProbe,
            ),
          (value) => Boolean(value),
          "The native import dialog was not opened",
        );
        assert.ok(openDefault);
        assert.equal(
          await realpath(openDefault),
          await realpath(directories.readDirectory),
        );
        await poll(
          () =>
            page.getByRole("button", { name: "导出", exact: true }).isEnabled(),
          Boolean,
          "The restored document did not produce an exportable result",
        );
        const saveProbe = `__jsonCraftSaveDefault_${process.pid}`;
        await application.evaluate(({ dialog }, key) => {
          dialog.showSaveDialog = (async (...args: unknown[]) => {
            const options = args.at(-1) as { defaultPath?: string };
            Reflect.set(globalThis, key, options.defaultPath);
            return { canceled: true, filePath: "" };
          }) as typeof dialog.showSaveDialog;
        }, saveProbe);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        const saveDefault = await poll(
          () =>
            application!.evaluate(
              (_electron, key) =>
                Reflect.get(globalThis, key) as string | undefined,
              saveProbe,
            ),
          (value) => Boolean(value),
          "The native export dialog was not opened",
        );
        assert.ok(saveDefault);
        assert.equal(
          await realpath(path.dirname(saveDefault)),
          await realpath(directories.writeDirectory),
        );
        assert.match(path.basename(saveDefault), /\.formatted\.json$/);
      },
    );

    await t.test(
      "blocks native window closing after a failed path save until the saved paths are restored",
      async () => {
        const saved = (await loadWorkspace(page)).settings;
        const invalidDirectory = path.join(workspace, "directory-is-a-file");
        const fileContent = "This file must not become a directory.";
        await writeFile(invalidDirectory, fileContent, "utf8");
        await showSettings(page);
        const readInput = page.getByRole("textbox", {
          name: "默认读取目录",
          exact: true,
        });
        const restore = page.getByRole("button", {
          name: "恢复已保存设置",
          exact: true,
        });
        try {
          await readInput.fill(invalidDirectory);
          await readInput.press("Tab");
          await restore.waitFor();
          assert.equal(await readInput.inputValue(), invalidDirectory);
          assert.deepEqual((await loadWorkspace(page)).settings, saved);
          assert.ok(application);
          const probe = `__jsonCraftBlockedClose_${process.pid}`;
          await application.evaluate(({ BrowserWindow }, key) => {
            const window = BrowserWindow.getAllWindows()[0];
            Reflect.set(globalThis, key, { requests: 0, closed: false });
            window.once("close", () => {
              Reflect.get(globalThis, key).requests++;
            });
            window.once("closed", () => {
              Reflect.get(globalThis, key).closed = true;
            });
            window.close();
          }, probe);
          await page.locator(".workspace-settings-error").waitFor();
          await poll(
            () =>
              application!.evaluate(
                (_electron, key) =>
                  Reflect.get(globalThis, key).requests as number,
                probe,
              ),
            (requests) => requests === 1,
            "The native close request did not reach the guarded window",
          );
          assert.equal(page.isClosed(), false);
          const nativeState = await application.evaluate(
            ({ BrowserWindow }, key) => ({
              probe: Reflect.get(globalThis, key) as {
                requests: number;
                closed: boolean;
              },
              windows: BrowserWindow.getAllWindows().length,
            }),
            probe,
          );
          assert.deepEqual(nativeState, {
            probe: { requests: 1, closed: false },
            windows: 1,
          });
          assert.equal(await readInput.inputValue(), invalidDirectory);
          assert.deepEqual((await loadWorkspace(page)).settings, saved);
          assert.equal(await readFile(invalidDirectory, "utf8"), fileContent);
        } finally {
          if (!page.isClosed()) {
            if (await restore.isVisible()) await restore.click();
            else {
              await readInput.fill(saved.readDirectory);
              await readInput.press("Tab");
            }
          }
        }
        await poll(
          () => readInput.inputValue(),
          (value) => value === saved.readDirectory,
          "Restoring saved paths did not discard the failed draft",
        );
        assert.deepEqual((await loadWorkspace(page)).settings, saved);
        await restart();
        assert.deepEqual((await loadWorkspace(page)).settings, saved);
      },
    );

    await t.test(
      "keeps newer typed paths when an earlier directory picker returns late",
      async () => {
        await showSettings(page);
        const saved = (await loadWorkspace(page)).settings;
        const staleRead = path.join(workspace, "stale-picker-read");
        const latestRead = path.join(workspace, "latest-typed-read");
        const latestWrite = path.join(workspace, "latest-typed-write");
        await Promise.all(
          [staleRead, latestRead, latestWrite].map((directory) =>
            mkdir(directory),
          ),
        );
        const [canonicalRead, canonicalWrite] = await Promise.all([
          realpath(latestRead),
          realpath(latestWrite),
        ]);
        const started = `__jsonCraftPickerStarted_${process.pid}`;
        const resolver = `__jsonCraftPickerResolve_${process.pid}`;
        const pickerResult = { ...saved, readDirectory: staleRead };
        assert.ok(application);
        await application.evaluate(
          ({ ipcMain }, keys) => {
            ipcMain.removeHandler("json-craft:workspace:chooseDirectory");
            ipcMain.handle(
              "json-craft:workspace:chooseDirectory",
              () =>
                new Promise((resolve) => {
                  Reflect.set(globalThis, keys.started, true);
                  Reflect.set(globalThis, keys.resolver, resolve);
                }),
            );
          },
          { started, resolver },
        );
        try {
          await page
            .getByRole("button", { name: "选择读取目录", exact: true })
            .click();
          await poll(
            () =>
              application!.evaluate(
                (_electron, key) => Boolean(Reflect.get(globalThis, key)),
                started,
              ),
            Boolean,
            "The delayed directory picker did not start",
          );
          const readInput = page.getByRole("textbox", {
            name: "默认读取目录",
            exact: true,
          });
          const writeInput = page.getByRole("textbox", {
            name: "文件存储目录",
            exact: true,
          });
          await readInput.fill(latestRead);
          await writeInput.fill(latestWrite);
          await application.evaluate(
            (_electron, result) => {
              const finish = Reflect.get(globalThis, result.resolver) as
                ((settings: WorkspaceSettings) => void) | undefined;
              if (!finish)
                throw new Error("The directory picker resolver is missing.");
              Reflect.deleteProperty(globalThis, result.resolver);
              finish(result.settings);
            },
            { resolver, settings: pickerResult },
          );
          await poll(
            () =>
              page
                .getByRole("button", { name: "选择读取目录", exact: true })
                .isEnabled(),
            Boolean,
            "The directory operation did not finish",
          );
          assert.equal(
            await realpath(await readInput.inputValue()),
            canonicalRead,
          );
          assert.equal(
            await realpath(await writeInput.inputValue()),
            canonicalWrite,
          );
          await poll(
            async () => canonicalSettings((await loadWorkspace(page)).settings),
            (settings) =>
              settings.readDirectory === canonicalRead &&
              settings.writeDirectory === canonicalWrite,
            "A late directory result replaced the newer persisted paths",
          );
        } finally {
          await application!.evaluate(
            (_electron, result) => {
              const finish = Reflect.get(globalThis, result.resolver) as
                ((settings: WorkspaceSettings) => void) | undefined;
              if (finish) {
                Reflect.deleteProperty(globalThis, result.resolver);
                finish(result.settings);
              }
            },
            { resolver, settings: pickerResult },
          );
          await restart();
        }
        const restored = (await loadWorkspace(page)).settings;
        assert.equal(await realpath(restored.readDirectory), canonicalRead);
        assert.equal(await realpath(restored.writeDirectory), canonicalWrite);
        await showSettings(page);
        assert.equal(
          await realpath(
            await page
              .getByRole("textbox", { name: "默认读取目录", exact: true })
              .inputValue(),
          ),
          canonicalRead,
        );
        assert.equal(
          await realpath(
            await page
              .getByRole("textbox", { name: "文件存储目录", exact: true })
              .inputValue(),
          ),
          canonicalWrite,
        );
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
      },
    );

    await t.test(
      "keeps an intentionally empty history empty on the next launch",
      async () => {
        await close();
        userData = path.join(workspace, "empty-profile");
        await launch();
        const initial = await poll(
          () => loadWorkspace(page),
          (state) => state.initialized && state.records.length === 3,
          "The isolated workspace did not initialize its samples",
        );
        for (const record of initial.records) {
          await page
            .getByRole("button", { name: `删除 ${record.name}`, exact: true })
            .click();
          await page
            .getByTestId("delete-confirmation")
            .getByRole("button", { name: "删除记录", exact: true })
            .click();
          await poll(
            () => loadWorkspace(page),
            (state) => !state.records.some((entry) => entry.id === record.id),
            "Deleting a sample did not remove its history entry",
          );
        }
        assert.equal((await loadWorkspace(page)).records.length, 0);
        await restart();
        const state = await loadWorkspace(page);
        assert.equal(state.initialized, true);
        assert.equal(state.records.length, 0);
        assert.equal(
          await page
            .getByRole("button", { name: "重命名 release.json", exact: true })
            .count(),
          0,
        );
      },
    );

    await t.test(
      "finishes all history workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
