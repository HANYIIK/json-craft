import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { WorkspaceSettings } from "../../../src/shared/types";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshotDirectory = path.join(projectRoot, "output", "playwright");

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

async function loadWorkspace(page: Page) {
  return page.evaluate(() => window.desktop!.workspace.load());
}

async function expectPage(page: Page, expected: "settings" | "workspace") {
  await poll(
    () => page.locator(".application").getAttribute("data-page"),
    (value) => value === expected,
    "The requested application page was not displayed",
  );
  assert.equal(await page.locator("main:visible").count(), 1);
  assert.equal(
    await page.locator("main.settings-page").isVisible(),
    expected === "settings",
  );
  assert.equal(
    await page.locator("main.workspace").isVisible(),
    expected === "workspace",
  );
}

async function showSettings(page: Page) {
  if (!(await page.locator("main.settings-page").isVisible()))
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await expectPage(page, "settings");
  await page.getByRole("heading", { name: "应用设置", level: 1 }).waitFor();
}

async function returnToWorkspace(page: Page) {
  await page.getByRole("button", { name: "关闭应用设置", exact: true }).click();
  await expectPage(page, "workspace");
}

async function replaceInput(page: Page, raw: string) {
  const input = page.getByTestId("input-editor").locator(".cm-content");
  await input.focus();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText(raw);
}

async function expectOutput(page: Page, raw: string) {
  const expected = JSON.stringify(JSON.parse(raw), null, 2);
  await poll(
    async () =>
      (
        await page
          .getByTestId("output-editor")
          .locator(".cm-line")
          .allTextContents()
      ).join("\n"),
    (value) => value === expected,
    "The current input was not formatted correctly",
  );
}

async function selectText(page: Page, raw: string, text: string) {
  const input = page.getByTestId("input-editor").locator(".cm-content");
  await input.focus();
  await input.press("ControlOrMeta+Home");
  for (let index = 0; index < raw.indexOf(text); index++)
    await input.press("ArrowRight");
  for (let index = 0; index < text.length; index++)
    await input.press("Shift+ArrowRight");
  assert.equal(await page.evaluate(() => getSelection()?.toString()), text);
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
    (value) => value?.raw === raw,
    "The active input was not saved to the workspace",
  );
  assert.ok(record);
  return record;
}

async function managedFile(page: Page, raw: string) {
  const location = page.getByTestId("managed-file-path");
  await location.waitFor();
  const filePath = await poll(
    async () => (await location.getAttribute("title")) || location.innerText(),
    (value) => path.isAbsolute(value.trim()) && /\.json$/i.test(value.trim()),
    "The document heading did not expose its real JSON file path",
  );
  const resolved = filePath.trim();
  await poll(
    () => readFile(resolved, "utf8").catch(() => null),
    (value) => value === raw,
    "The visible file path did not contain the exact original input",
  );
  return resolved;
}

async function changePath(
  page: Page,
  label: string,
  key: "readDirectory" | "writeDirectory" | "historyDirectory",
  directory: string,
) {
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.fill(directory);
  await input.press("Tab");
  const canonical = await realpath(directory);
  await poll(
    async () => (await loadWorkspace(page)).settings[key],
    (value) => value === canonical,
    "The edited directory did not automatically persist",
  );
}

test(
  "Electron settings use a separate page and preserve the editing workspace",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-settings-page-"),
    );
    const userData = path.join(workspace, "profile");
    const initialSettings: WorkspaceSettings = {
      readDirectory: path.join(workspace, "read-original"),
      writeDirectory: path.join(workspace, "files-original"),
      historyDirectory: path.join(workspace, "history-original"),
      theme: "system",
      autoCopy: false,
      language: "zh-CN",
    };
    const newRead = path.join(workspace, "read-updated");
    const newWrite = path.join(workspace, "files-updated");
    const finalWrite = path.join(workspace, "files-final");
    const immediateWrite = path.join(workspace, "files-immediate");
    const newHistory = path.join(workspace, "history-updated");
    await Promise.all(
      [
        userData,
        initialSettings.readDirectory,
        initialSettings.writeDirectory,
        initialSettings.historyDirectory,
        newRead,
        newWrite,
        finalWrite,
        immediateWrite,
        newHistory,
        screenshotDirectory,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await writeFile(
      path.join(userData, "workspace-settings.json"),
      JSON.stringify({
        version: 1,
        initialized: true,
        activeId: null,
        settings: initialSettings,
      }),
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
    const errors: string[] = [];
    const close = async () => {
      const running = application;
      application = undefined;
      if (running) await running.close();
    };
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${userData}`],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "新建输入", exact: true })
        .waitFor();
      await poll(
        () =>
          page
            .getByRole("button", { name: "新建输入", exact: true })
            .isEnabled(),
        Boolean,
        "The workspace did not finish loading",
      );
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1200, 820),
      );
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
      "shows a separate main page without remounting editors or discarding selection and undo",
      async () => {
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = '{"value":"before","settings":true}';
        const changed = raw.replace("before", "after");
        await replaceInput(page, raw);
        await expectOutput(page, raw);
        await selectText(page, raw, "before");
        await delay(600);
        await page.keyboard.insertText("after");
        await expectOutput(page, changed);
        await selectText(page, changed, "after");
        const input = page.getByTestId("input-editor").locator(".cm-content");
        const output = page.getByTestId("output-editor").locator(".cm-content");
        const originalInput = await input.elementHandle();
        const originalOutput = await output.elementHandle();
        assert.ok(originalInput && originalOutput);
        await showSettings(page);
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(await input.isVisible(), false);
        assert.equal(await output.isVisible(), false);
        assert.equal(
          await page
            .getByRole("button", { name: "应用设置", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        await page
          .getByRole("heading", { name: "外观", exact: true })
          .waitFor();
        await page
          .getByRole("heading", { name: "文件与存储", exact: true })
          .waitFor();
        await returnToWorkspace(page);
        for (const [node, testId] of [
          [originalInput, "input-editor"],
          [originalOutput, "output-editor"],
        ] as const) {
          assert.equal(
            await node.evaluate(
              (element, editorId) =>
                element.isConnected &&
                element ===
                  document.querySelector(
                    `[data-testid="${editorId}"] .cm-content`,
                  ),
              testId,
            ),
            true,
            "Opening settings replaced an editor DOM node",
          );
        }
        await input.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "after",
        );
        await input.press("ControlOrMeta+z");
        await expectOutput(page, raw);
        assert.equal((await savedRecord(page, raw)).raw, raw);
      },
    );

    await t.test(
      "preserves each long editor's scroll position across page navigation",
      async () => {
        const raw = JSON.stringify(
          {
            items: Array.from({ length: 250 }, (_, id) => ({
              id,
              value: `entry-${id}`,
            })),
            tail: "__SETTINGS_SCROLL_END__",
          },
          null,
          2,
        );
        await replaceInput(page, raw);
        const positions: { pane: "input" | "output"; top: number }[] = [];
        for (const pane of ["input", "output"] as const) {
          const scroller = page
            .getByTestId(`${pane}-editor`)
            .locator(".cm-scroller");
          await poll(
            () =>
              scroller.evaluate(
                (element) => element.scrollHeight - element.clientHeight,
              ),
            (height) => height > 1000,
            "The long JSON did not overflow its editor",
          );
          await scroller.hover();
          await page.mouse.wheel(0, -1_000_000);
          await poll(
            () => scroller.evaluate((element) => element.scrollTop),
            (value) => value <= 2,
            "The editor did not return to its start before scrolling",
          );
          await page.mouse.wheel(0, pane === "input" ? 700 : 1100);
          let previousTop = -1;
          const top = await poll(
            () => scroller.evaluate((element) => element.scrollTop),
            (value) => {
              const settled = value > 300 && Math.abs(value - previousTop) < 1;
              previousTop = value;
              return settled;
            },
            "The editor did not scroll before opening settings",
          );
          positions.push({ pane, top });
        }
        await showSettings(page);
        await returnToWorkspace(page);
        for (const { pane, top } of positions) {
          await poll(
            () =>
              page
                .getByTestId(`${pane}-editor`)
                .locator(".cm-scroller")
                .evaluate((element) => element.scrollTop),
            (value) => Math.abs(value - top) <= 3,
            `Settings navigation changed the ${pane} editor's scroll position from ${top}`,
          );
        }
        assert.equal((await savedRecord(page, raw)).raw, raw);
      },
    );

    await t.test(
      "automatically saves themes and paths and distinguishes files from workspace data",
      async () => {
        const previousIds = (await loadWorkspace(page)).records
          .map((record) => record.id)
          .sort();
        await showSettings(page);
        await page.getByText(/已保存文件保留原位置/).waitFor();
        await page.getByText(/用于恢复工作区的内部历史数据/).waitFor();
        const theme = page.getByRole("combobox", {
          name: "外观主题",
          exact: true,
        });
        await theme.click();
        await page.getByRole("option", { name: "深色", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The settings theme did not apply immediately",
        );
        await poll(
          async () => (await loadWorkspace(page)).settings.theme,
          (value) => value === "dark",
          "The theme preference did not save automatically",
        );
        await changePath(page, "默认读取目录", "readDirectory", newRead);
        await changePath(page, "文件存储目录", "writeDirectory", newWrite);
        await changePath(page, "历史存储目录", "historyDirectory", newHistory);
        assert.deepEqual(
          (await loadWorkspace(page)).records.map((record) => record.id).sort(),
          previousIds,
        );
        assert.ok(
          (await readdir(newHistory)).some((name) =>
            /^history-.*\.json$/.test(name),
          ),
        );
        await close();
        await launch();
        await showSettings(page);
        assert.match(
          await page
            .getByRole("combobox", { name: "外观主题", exact: true })
            .innerText(),
          /深色/,
        );
        for (const [label, directory] of [
          ["默认读取目录", newRead],
          ["文件存储目录", newWrite],
          ["历史存储目录", newHistory],
        ] as const) {
          assert.equal(
            await page
              .getByRole("textbox", { name: label, exact: true })
              .inputValue(),
            await realpath(directory),
          );
        }
        await poll(
          () => page.locator(".workspace-settings-status").innerText(),
          (value) => value === "已自动保存",
          "The page did not show its automatic save status",
        );
      },
    );

    await t.test(
      "keeps failed directory drafts reviewable and restores the last saved settings",
      async () => {
        const saved = (await loadWorkspace(page)).settings;
        const invalid = path.join(workspace, "not-a-directory");
        await writeFile(invalid, "keep this ordinary file");
        const field = page.getByRole("textbox", {
          name: "默认读取目录",
          exact: true,
        });
        const restore = page.getByRole("button", {
          name: "恢复已保存设置",
          exact: true,
        });
        try {
          await field.fill(invalid);
          await field.press("Tab");
          await restore.waitFor();
          await page.locator(".workspace-settings-error").waitFor();
          assert.equal(await field.inputValue(), invalid);
          assert.deepEqual((await loadWorkspace(page)).settings, saved);
          assert.equal(
            await page.locator(".workspace-settings-status").innerText(),
            "尚未保存",
          );
          assert.equal(
            await readFile(invalid, "utf8"),
            "keep this ordinary file",
          );
        } finally {
          if (await restore.isVisible()) await restore.click();
        }
        await poll(
          () => field.inputValue(),
          (value) => value === saved.readDirectory,
          "The failed setting was not restored",
        );
        await page
          .locator(".workspace-settings-error")
          .waitFor({ state: "hidden" });
        assert.deepEqual((await loadWorkspace(page)).settings, saved);
      },
    );

    await t.test(
      "uses the shown file path and applies a changed storage directory only to new inputs",
      async () => {
        await returnToWorkspace(page);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = '{"file":"original"}';
        await replaceInput(page, raw);
        await expectOutput(page, raw);
        const oldPath = await managedFile(page, raw);
        assert.equal(path.dirname(oldPath), await realpath(newWrite));
        const oldRecord = await savedRecord(page, raw);
        const invalidRaw = '{"file":"unfinished",';
        await replaceInput(page, invalidRaw);
        assert.equal(await managedFile(page, invalidRaw), oldPath);
        await showSettings(page);
        await changePath(page, "文件存储目录", "writeDirectory", finalWrite);
        await returnToWorkspace(page);
        const kept = '{"file":"kept at original location"}';
        await replaceInput(page, kept);
        await expectOutput(page, kept);
        assert.equal(await managedFile(page, kept), oldPath);
        await showSettings(page);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await expectPage(page, "workspace");
        const next = '{"file":"new directory"}';
        await replaceInput(page, next);
        await expectOutput(page, next);
        const nextPath = await managedFile(page, next);
        assert.equal(path.dirname(nextPath), await realpath(finalWrite));
        assert.notEqual(nextPath, oldPath);
        assert.equal(await readFile(oldPath, "utf8"), kept);
        await showSettings(page);
        await page
          .locator(`[data-history-id="${oldRecord.id}"] .history-entry-select`)
          .click();
        await expectPage(page, "workspace");
        await expectOutput(page, kept);
        assert.equal(await managedFile(page, kept), oldPath);
      },
    );

    await t.test(
      "flushes a just-edited storage directory before opening and saving a new input",
      async () => {
        await showSettings(page);
        await page
          .getByRole("textbox", { name: "文件存储目录", exact: true })
          .fill(immediateWrite);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await expectPage(page, "workspace");
        const raw = '{"directory":"just edited"}';
        await replaceInput(page, raw);
        await expectOutput(page, raw);
        const actual = await managedFile(page, raw);
        assert.equal(path.dirname(actual), await realpath(immediateWrite));
        assert.equal(
          (await loadWorkspace(page)).settings.writeDirectory,
          await realpath(immediateWrite),
        );
        await savedRecord(page, raw);
      },
    );

    await t.test(
      "persists a new active document even if its ordinary file fails and retries without duplicating history",
      async () => {
        const previous = await loadWorkspace(page);
        assert.ok(previous.activeId);
        const directory = previous.settings.writeDirectory;
        const backup = path.join(workspace, "files-during-failure");
        const source = path.join(workspace, "active-file-failure.json");
        const raw = '{"active":"persists through file failure"}';
        await writeFile(source, raw, "utf8");
        let newId: string | null = null;
        await rename(directory, backup);
        try {
          await writeFile(
            directory,
            "This storage path is temporarily a file.",
          );
          await application!.evaluate(({ dialog }, filePath) => {
            dialog.showOpenDialog = (async () => ({
              canceled: false,
              filePaths: [filePath],
            })) as typeof dialog.showOpenDialog;
          }, source);
          await page
            .getByRole("button", { name: "导入文件", exact: true })
            .click();
          await expectOutput(page, raw);
          newId = await page
            .locator(".history-entry-selected")
            .getAttribute("data-history-id");
          assert.ok(newId);
          assert.notEqual(newId, previous.activeId);
          await poll(
            () =>
              page
                .getByTestId("autosave-status")
                .getAttribute("data-save-state"),
            (value) => value === "error",
            "The unavailable ordinary file did not report its save error",
          );
          await page
            .getByRole("button", { name: "重试保存", exact: true })
            .waitFor();
          const saved = await page.evaluate(
            (id) => window.desktop!.workspace.read(id),
            newId,
          );
          assert.equal(saved.raw, raw);
          assert.ok(saved.fileSaveError);
          await poll(
            async () => (await loadWorkspace(page)).activeId,
            (activeId) => activeId === newId,
            "An ordinary-file save failure prevented the new active document from persisting",
          );
          const state = await loadWorkspace(page);
          assert.equal(state.records.length, previous.records.length + 1);
          assert.equal(
            state.records.filter((record) => record.id === newId).length,
            1,
          );
        } finally {
          await rm(directory, { force: true });
          await rename(backup, directory);
        }
        await page
          .getByRole("button", { name: "重试保存", exact: true })
          .click();
        await poll(
          () =>
            page.getByTestId("autosave-status").getAttribute("data-save-state"),
          (value) => value === "saved",
          "The recovered ordinary file did not finish its explicit retry",
        );
        const filePath = await managedFile(page, raw);
        assert.equal(path.dirname(filePath), await realpath(directory));
        const recovered = await savedRecord(page, raw);
        assert.equal(recovered.id, newId);
        assert.equal(recovered.fileSaveError, undefined);
        assert.equal(recovered.managedPath, filePath);
        const after = await loadWorkspace(page);
        assert.equal(after.activeId, newId);
        assert.equal(after.records.length, previous.records.length + 1);
        assert.equal(
          after.records.filter((record) => record.id === newId).length,
          1,
        );
        assert.equal(await readFile(source, "utf8"), raw);
      },
    );

    await t.test(
      "scrolls the settings page inside a compact app without overflowing the window",
      async () => {
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () =>
            page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          (value) => value.width === 780 && value.height === 600,
          "The compact window size did not apply",
        );
        await showSettings(page);
        const content = page.locator(".workspace-settings");
        const geometry = await content.evaluate((element) => ({
          width: innerWidth,
          height: innerHeight,
          pageWidth: document.documentElement.scrollWidth,
          pageHeight: document.documentElement.scrollHeight,
          settingsWidth: element.clientWidth,
          settingsScrollWidth: element.scrollWidth,
          settingsHeight: element.clientHeight,
          settingsScrollHeight: element.scrollHeight,
        }));
        assert.ok(
          geometry.pageWidth <= geometry.width + 1,
          "The application overflows horizontally on settings",
        );
        assert.ok(
          geometry.pageHeight <= geometry.height + 1,
          "The application overflows vertically on settings",
        );
        assert.ok(
          geometry.settingsScrollWidth <= geometry.settingsWidth + 1,
          "Settings content overflows horizontally",
        );
        assert.ok(
          geometry.settingsScrollHeight > geometry.settingsHeight + 80,
          "The settings page has no independent vertical scroll area",
        );
        await content.hover();
        await page.mouse.wheel(0, 10000);
        await poll(
          () => content.evaluate((element) => element.scrollTop),
          (value) => value > 100,
          "The settings page did not react to the real wheel",
        );
        await page
          .getByRole("textbox", { name: "历史存储目录", exact: true })
          .waitFor();
        await page.screenshot({
          path: path.join(
            screenshotDirectory,
            "settings-page-dark-compact.png",
          ),
          animations: "disabled",
        });
        await content.hover();
        await page.mouse.wheel(0, -10000);
        await poll(
          () => content.evaluate((element) => element.scrollTop),
          (value) => value <= 1,
          "The settings page did not scroll back to its header",
        );
        const theme = page.getByRole("combobox", {
          name: "外观主题",
          exact: true,
        });
        await theme.click();
        await page.getByRole("option", { name: "浅色", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "light",
          "The settings page did not switch to light theme",
        );
        await poll(
          () => page.locator(".workspace-settings-status").innerText(),
          (value) => value === "已自动保存",
          "The final appearance change did not finish saving",
        );
        await page.screenshot({
          path: path.join(
            screenshotDirectory,
            "settings-page-light-compact.png",
          ),
          animations: "disabled",
        });
        await returnToWorkspace(page);
      },
    );

    await t.test(
      "finishes settings navigation without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
