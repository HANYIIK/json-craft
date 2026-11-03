import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
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

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
type DirectoryKey = "readDirectory" | "writeDirectory" | "historyDirectory";
const directoryLabels: Record<DirectoryKey, string> = {
  readDirectory: "默认读取目录",
  writeDirectory: "文件存储目录",
  historyDirectory: "历史存储目录",
};

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function loadWorkspace(page: Page) {
  return page.evaluate(() => window.desktop!.workspace.load());
}

async function showSettings(page: Page) {
  if (!(await page.locator("main.settings-page").isVisible()))
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("heading", { name: "应用设置", level: 1 }).waitFor();
}

async function showWorkspace(page: Page) {
  if (await page.locator("main.settings-page").isVisible())
    await page
      .getByRole("button", { name: "关闭应用设置", exact: true })
      .click();
  await poll(
    () => page.locator(".application").getAttribute("data-page"),
    (value) => value === "workspace",
    "The directory test did not return to its workspace",
  );
}

async function replaceInput(page: Page, raw: string) {
  const content = page.getByTestId("input-editor").locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const handled = await content.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    return !element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, raw);
  assert.equal(handled, true);
}

async function savedRecord(page: Page, raw: string) {
  const record = await poll(
    async () => {
      const state = await loadWorkspace(page);
      return state.activeId
        ? page.evaluate(
            (id) => window.desktop!.workspace.read(id),
            state.activeId,
          )
        : null;
    },
    (value) =>
      value?.raw === raw && Boolean(value.managedPath) && !value.fileSaveError,
    "The original JSON was not saved to history and an ordinary JSON file",
  );
  assert.ok(record?.managedPath);
  await poll(
    () => readFile(record.managedPath!, "utf8").catch(() => null),
    (value) => value === raw,
    "The ordinary JSON file does not contain the exact original input",
  );
  return record;
}

async function expectCreated(directory: string) {
  await poll(
    () =>
      stat(directory)
        .then((value) => value.isDirectory())
        .catch(() => false),
    Boolean,
    `The nested directory was not created: ${directory}`,
  );
  return realpath(directory);
}

async function setMissingDirectory(
  page: Page,
  key: DirectoryKey,
  directory: string,
) {
  await assert.rejects(access(directory), { code: "ENOENT" });
  const field = page.getByRole("textbox", {
    name: directoryLabels[key],
    exact: true,
  });
  await field.fill(directory);
  await field.press("Tab");
  const canonical = await expectCreated(directory);
  await poll(
    async () => (await loadWorkspace(page)).settings[key],
    (value) => value === canonical,
    "The newly created directory was not persisted automatically",
  );
  return canonical;
}

test(
  "Electron creates missing workspace directories and preserves invalid-path protections",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-directories-")),
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    let page!: Page;
    let profile = "";
    let initialSettings!: WorkspaceSettings;
    let initialRecord!: HistoryRecord;
    const errors: string[] = [];
    const close = async () => {
      const running = application;
      application = undefined;
      if (running) await running.close();
    };
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("crash", () => errors.push("Renderer crashed"));
      await page
        .getByRole("button", { name: "新建输入", exact: true })
        .waitFor();
      await poll(
        () =>
          page
            .getByRole("button", { name: "新建输入", exact: true })
            .isEnabled(),
        Boolean,
        "The application could not load a valid config pointing to missing directories",
      );
      const state = await loadWorkspace(page);
      for (const directory of [
        state.settings.readDirectory,
        state.settings.writeDirectory,
        state.settings.historyDirectory,
      ])
        assert.ok(
          directory.startsWith(workspace + path.sep),
          "A directory test escaped its temporary workspace",
        );
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    for (const initialized of [false, true]) {
      await t.test(
        `starts an initialized=${initialized} profile whose three saved directories do not exist`,
        async () => {
          await close();
          profile = path.join(workspace, `profile-${initialized}`);
          initialSettings = {
            readDirectory: path.join(
              workspace,
              `initial-${initialized}`,
              "read",
              "deep",
              "directory",
            ),
            writeDirectory: path.join(
              workspace,
              `initial-${initialized}`,
              "write",
              "deep",
              "directory",
            ),
            historyDirectory: path.join(
              workspace,
              `initial-${initialized}`,
              "history",
              "deep",
              "directory",
            ),
            theme: "system",
            autoCopy: false,
            language: "zh-CN",
          };
          await mkdir(profile);
          await writeFile(
            path.join(profile, "workspace-settings.json"),
            JSON.stringify({
              version: 1,
              initialized,
              activeId: null,
              settings: initialSettings,
            }),
          );
          for (const directory of [
            initialSettings.readDirectory,
            initialSettings.writeDirectory,
            initialSettings.historyDirectory,
          ])
            await assert.rejects(access(directory), { code: "ENOENT" });
          await launch();
          for (const directory of [
            initialSettings.readDirectory,
            initialSettings.writeDirectory,
            initialSettings.historyDirectory,
          ])
            await expectCreated(directory);
          const before = await loadWorkspace(page);
          assert.equal(before.records.length, initialized ? 0 : 3);
          await page
            .getByRole("button", { name: "新建输入", exact: true })
            .click();
          const raw = JSON.stringify({
            startup: initialized,
            values: [0, false, null],
          });
          await replaceInput(page, raw);
          initialRecord = await savedRecord(page, raw);
          assert.equal(
            path.dirname(initialRecord.managedPath!),
            await realpath(initialSettings.writeDirectory),
          );
          const stored = JSON.parse(
            await readFile(
              path.join(
                initialSettings.historyDirectory,
                `history-${initialRecord.id}.json`,
              ),
              "utf8",
            ),
          ) as HistoryRecord;
          assert.equal(stored.raw, raw);
        },
      );
    }

    const newRead = path.join(workspace, "chosen", "read", "three", "levels");
    const newWrite = path.join(workspace, "chosen", "write", "three", "levels");
    const newHistory = path.join(
      workspace,
      "chosen",
      "history",
      "three",
      "levels",
    );
    const rapidWrite = path.join(
      workspace,
      "immediate",
      "new",
      "deep",
      "storage",
    );
    const importedRaw = '{"directory":"new read folder","value":false}';
    const rapidRaw = '{"directory":"immediate creation","value":[1,2]}';
    let importedRecord!: HistoryRecord;
    let rapidRecord!: HistoryRecord;

    await t.test(
      "recursively creates all three edited paths and migrates history without moving existing JSON files",
      async () => {
        const previous = await loadWorkspace(page);
        const oldPath = initialRecord.managedPath!;
        await showSettings(page);
        await setMissingDirectory(page, "readDirectory", newRead);
        await setMissingDirectory(page, "writeDirectory", newWrite);
        await setMissingDirectory(page, "historyDirectory", newHistory);
        const state = await loadWorkspace(page);
        assert.deepEqual(
          state.records.map((value) => value.id).sort(),
          previous.records.map((value) => value.id).sort(),
        );
        const migrated = JSON.parse(
          await readFile(
            path.join(newHistory, `history-${initialRecord.id}.json`),
            "utf8",
          ),
        ) as HistoryRecord;
        assert.equal(migrated.raw, initialRecord.raw);
        assert.equal(migrated.managedPath, oldPath);
        assert.equal(await readFile(oldPath, "utf8"), initialRecord.raw);
        assert.equal(
          await page.locator(".workspace-settings-error").isVisible(),
          false,
        );
      },
    );

    await t.test(
      "uses the newly created reading directory in the native picker and saves the imported JSON to new storage",
      async () => {
        const source = path.join(newRead, "auto-directory-import.json");
        await writeFile(source, importedRaw);
        assert.ok(application);
        await application.evaluate(({ dialog }, filePath) => {
          dialog.showOpenDialog = (async (...args: unknown[]) => {
            const options = args.at(-1) as { defaultPath?: string };
            Reflect.set(
              globalThis,
              "__directoryTestOpenDefault",
              options.defaultPath,
            );
            return { canceled: false, filePaths: [filePath] };
          }) as typeof dialog.showOpenDialog;
        }, source);
        await showWorkspace(page);
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        importedRecord = await savedRecord(page, importedRaw);
        assert.equal(
          await application.evaluate(
            () =>
              Reflect.get(globalThis, "__directoryTestOpenDefault") as string,
          ),
          await realpath(newRead),
        );
        assert.equal(
          path.dirname(importedRecord.managedPath!),
          await realpath(newWrite),
        );
        assert.equal(await readFile(source, "utf8"), importedRaw);
        assert.equal(
          await readFile(importedRecord.managedPath!, "utf8"),
          importedRaw,
        );
      },
    );

    await t.test(
      "rejects existing files, relative paths, and file ancestors while retaining saved paths and file contents",
      async () => {
        await showSettings(page);
        const saved = (await loadWorkspace(page)).settings;
        const occupied = path.join(workspace, "occupied-file");
        const occupiedContents =
          "This ordinary file must never be replaced by a directory.";
        await writeFile(occupied, occupiedContents);
        for (const key of [
          "readDirectory",
          "writeDirectory",
          "historyDirectory",
        ] as const) {
          for (const invalid of [occupied, "relative/directory/path"]) {
            const field = page.getByRole("textbox", {
              name: directoryLabels[key],
              exact: true,
            });
            await field.fill(invalid);
            await field.press("Tab");
            await page.locator(".workspace-settings-error").waitFor();
            assert.equal(await field.inputValue(), invalid);
            assert.deepEqual((await loadWorkspace(page)).settings, saved);
            assert.equal(await readFile(occupied, "utf8"), occupiedContents);
            await page
              .getByRole("button", { name: "恢复已保存设置", exact: true })
              .click();
            await page
              .locator(".workspace-settings-error")
              .waitFor({ state: "hidden" });
            assert.equal(await field.inputValue(), saved[key]);
          }
        }
        const read = page.getByRole("textbox", {
          name: "默认读取目录",
          exact: true,
        });
        await read.fill(path.join(occupied, "child", "directory"));
        await read.press("Tab");
        await page.locator(".workspace-settings-error").waitFor();
        assert.deepEqual((await loadWorkspace(page)).settings, saved);
        assert.equal(await readFile(occupied, "utf8"), occupiedContents);
        await page
          .getByRole("button", { name: "恢复已保存设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-error")
          .waitFor({ state: "hidden" });
      },
    );

    await t.test(
      "creates a just-edited missing storage path before immediately opening and saving a new input",
      async () => {
        await showSettings(page);
        await assert.rejects(access(rapidWrite), { code: "ENOENT" });
        await page
          .getByRole("textbox", { name: "文件存储目录", exact: true })
          .fill(rapidWrite);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Creating a new input did not flush and apply the missing storage path",
        );
        await replaceInput(page, rapidRaw);
        rapidRecord = await savedRecord(page, rapidRaw);
        assert.equal(
          path.dirname(rapidRecord.managedPath!),
          await realpath(rapidWrite),
        );
        assert.equal(
          (await loadWorkspace(page)).settings.writeDirectory,
          await realpath(rapidWrite),
        );
        assert.equal(
          await readFile(initialRecord.managedPath!, "utf8"),
          initialRecord.raw,
        );
        assert.equal(
          await readFile(importedRecord.managedPath!, "utf8"),
          importedRaw,
        );
      },
    );

    await t.test(
      "restores created paths, migrated records, active input, and exact stored JSON after restarting",
      async () => {
        const previous = await loadWorkspace(page);
        await close();
        await launch();
        const restored = await loadWorkspace(page);
        assert.deepEqual(restored.settings, previous.settings);
        assert.deepEqual(
          restored.records.map((value) => value.id).sort(),
          previous.records.map((value) => value.id).sort(),
        );
        assert.equal(restored.activeId, rapidRecord.id);
        for (const record of [initialRecord, importedRecord, rapidRecord]) {
          const loaded = await page.evaluate(
            (id) => window.desktop!.workspace.read(id),
            record.id,
          );
          assert.equal(loaded.raw, record.raw);
          assert.equal(loaded.managedPath, record.managedPath);
          assert.equal(await readFile(loaded.managedPath!, "utf8"), record.raw);
          const file = JSON.parse(
            await readFile(
              path.join(newHistory, `history-${record.id}.json`),
              "utf8",
            ),
          ) as HistoryRecord;
          assert.equal(file.raw, record.raw);
        }
      },
    );

    await t.test(
      "recreates a saved history directory deleted between launches without deleting ordinary JSON files",
      async () => {
        await close();
        await rm(newHistory, { recursive: true });
        await assert.rejects(access(newHistory), { code: "ENOENT" });
        await launch();
        await expectCreated(newHistory);
        const restored = await loadWorkspace(page);
        assert.equal(restored.initialized, true);
        assert.equal(restored.records.length, 0);
        assert.equal(restored.activeId, null);
        for (const record of [initialRecord, importedRecord, rapidRecord])
          assert.equal(await readFile(record.managedPath!, "utf8"), record.raw);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = '{"history":"recreated successfully"}';
        await replaceInput(page, raw);
        const saved = await savedRecord(page, raw);
        assert.equal(
          path.dirname(saved.managedPath!),
          await realpath(rapidWrite),
        );
        assert.equal(
          (
            JSON.parse(
              await readFile(
                path.join(newHistory, `history-${saved.id}.json`),
                "utf8",
              ),
            ) as HistoryRecord
          ).raw,
          raw,
        );
      },
    );

    await t.test(
      "loads existing history when saved storage is occupied by a file and lets settings repair it",
      async () => {
        await close();
        profile = path.join(workspace, "profile-blocked-write");
        const history = path.join(workspace, "blocked-write-history");
        const blocked = path.join(workspace, "blocked-startup-storage");
        const read = path.join(
          workspace,
          "blocked-startup-read",
          "deep",
          "directory",
        );
        const repaired = path.join(
          workspace,
          "repaired-startup-storage",
          "deep",
          "directory",
        );
        const contents =
          "Keep this ordinary file while recovering the saved directory setting.";
        await Promise.all([mkdir(profile), mkdir(history)]);
        await writeFile(blocked, contents);
        const record = { ...rapidRecord, id: "startup-existing-history" };
        await writeFile(
          path.join(history, `history-${record.id}.json`),
          JSON.stringify(record),
        );
        const settings: WorkspaceSettings = {
          readDirectory: read,
          writeDirectory: blocked,
          historyDirectory: history,
          theme: "system",
          autoCopy: false,
          language: "zh-CN",
        };
        await writeFile(
          path.join(profile, "workspace-settings.json"),
          JSON.stringify({
            version: 1,
            initialized: true,
            activeId: record.id,
            settings,
          }),
        );
        await launch();
        const state = await loadWorkspace(page);
        assert.equal(state.activeId, record.id);
        assert.equal(state.records.length, 1);
        assert.equal(
          (
            await page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              record.id,
            )
          ).raw,
          rapidRaw,
        );
        await expectCreated(read);
        assert.equal(await readFile(blocked, "utf8"), contents);
        await showSettings(page);
        assert.equal(
          await page
            .getByRole("textbox", { name: "文件存储目录", exact: true })
            .inputValue(),
          blocked,
        );
        await setMissingDirectory(page, "writeDirectory", repaired);
        await showWorkspace(page);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = '{"startup":"storage setting repaired"}';
        await replaceInput(page, raw);
        const saved = await savedRecord(page, raw);
        assert.equal(
          path.dirname(saved.managedPath!),
          await realpath(repaired),
        );
        assert.equal(await readFile(blocked, "utf8"), contents);
      },
    );

    await t.test(
      "finishes directory creation workflows without renderer errors",
      () => assert.deepEqual(errors, []),
    );
  },
);
