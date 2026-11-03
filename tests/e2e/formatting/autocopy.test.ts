import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";

import {
  formatThroughMenu,
  isolateWorkspace,
} from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const probeKey = "__jsonCraftAutoCopyProbe";
const failureMessage = "Automatic copy failure from native test handler";
interface CopyProbe {
  attempts: string[];
  writes: string[];
  mode: "normal" | "hold" | "fail";
  pending: (() => void)[];
}

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
    "The current result does not match the expected JSON",
  );
}

async function loadWorkspace(page: Page) {
  return page.evaluate(() => window.desktop!.workspace.load());
}

async function copyState(application: ElectronApplication) {
  return application.evaluate((_electron, key) => {
    const probe = Reflect.get(globalThis, key) as CopyProbe;
    return {
      attempts: [...probe.attempts],
      writes: [...probe.writes],
      pending: probe.pending.length,
    };
  }, probeKey);
}

async function resetCopies(application: ElectronApplication) {
  await application.evaluate((_electron, key) => {
    const probe = Reflect.get(globalThis, key) as CopyProbe;
    if (probe.pending.length)
      throw new Error("Cannot reset an in-flight copy.");
    probe.attempts.length = 0;
    probe.writes.length = 0;
    probe.mode = "normal";
  }, probeKey);
}

async function setCopyMode(
  application: ElectronApplication,
  mode: CopyProbe["mode"],
) {
  await application.evaluate(
    (_electron, value) => {
      const probe = Reflect.get(globalThis, value.key) as CopyProbe;
      probe.mode = value.mode;
      if (value.mode !== "hold")
        probe.pending.splice(0).forEach((finish) => finish());
    },
    { key: probeKey, mode },
  );
}

async function expectCopies(
  application: ElectronApplication,
  expected: string[],
) {
  await poll(
    () => copyState(application),
    (state) => JSON.stringify(state.writes) === JSON.stringify(expected),
    "The native copy bridge did not receive the current visible results",
  );
  assert.deepEqual((await copyState(application)).attempts, expected);
}

async function expectQuiet(
  application: ElectronApplication,
  expected: string[] = [],
) {
  await delay(500);
  const state = await copyState(application);
  assert.deepEqual(
    state.attempts,
    expected,
    "A passive or disabled action wrote to the copy bridge",
  );
  assert.deepEqual(state.writes, expected);
}

async function toggleAutoCopy(page: Page, enabled: boolean) {
  const checkbox = page.getByRole("checkbox", {
    name: "格式化后自动复制",
    exact: true,
  });
  await checkbox.setChecked(enabled);
  await poll(
    () => loadWorkspace(page),
    (state) => state.settings.autoCopy === enabled,
    "The global automatic-copy preference was not saved",
  );
}

async function assertFooter(page: Page) {
  const copy = page.getByRole("button", { name: "复制", exact: true });
  const exportButton = page.getByRole("button", { name: "导出", exact: true });
  assert.equal(await copy.count(), 1);
  assert.equal(await exportButton.count(), 1);
  assert.equal(
    await page
      .locator(".toolbar")
      .getByRole("button", { name: "复制", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator('[data-pane="output"] .editor-header')
      .getByRole("button", { name: "复制", exact: true })
      .count(),
    0,
  );
  await copy.scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => {
    const footer = document.querySelector(
      '[data-pane="output"] .editor-footer',
    )!;
    const buttons = Array.from(footer.querySelectorAll("button"));
    const copyButton = buttons.find(
      (button) => button.textContent?.trim() === "复制",
    )!;
    const exportButton = buttons.find(
      (button) => button.textContent?.trim() === "导出",
    )!;
    const footerRect = footer.getBoundingClientRect();
    const copyRect = copyButton.getBoundingClientRect();
    const exportRect = exportButton.getBoundingClientRect();
    return {
      sameGroup: copyButton.parentElement === exportButton.parentElement,
      footer: {
        left: footerRect.left,
        right: footerRect.right,
        top: footerRect.top,
        bottom: footerRect.bottom,
      },
      copy: {
        left: copyRect.left,
        right: copyRect.right,
        top: copyRect.top,
        bottom: copyRect.bottom,
      },
      export: {
        left: exportRect.left,
        right: exportRect.right,
        top: exportRect.top,
        bottom: exportRect.bottom,
      },
      width: innerWidth,
      height: innerHeight,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(geometry.sameGroup, true);
  assert.ok(
    geometry.copy.left >= geometry.footer.left &&
      geometry.copy.right <= geometry.export.left,
  );
  assert.ok(
    geometry.export.right <= geometry.footer.right + 1 &&
      geometry.footer.right - geometry.export.right <= 24,
    "Output actions are not aligned with the footer's right edge",
  );
  for (const button of [geometry.copy, geometry.export]) {
    assert.ok(
      button.top >= geometry.footer.top - 1 &&
        button.bottom <= geometry.footer.bottom + 1,
      "An output action exceeds the footer",
    );
    assert.ok(
      button.left >= 0 &&
        button.right <= geometry.width + 1 &&
        button.top >= 0 &&
        button.bottom <= geometry.height + 1,
      "An output action is clipped by the viewport",
    );
  }
  assert.ok(geometry.pageWidth <= geometry.width + 1);
}

test(
  "Electron automatic copy follows current user work and keeps output actions in its footer",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-autocopy-"),
    );
    const bootstrap = path.join(workspace, "capture-copy.cjs");
    await writeFile(
      bootstrap,
      `const { ipcMain } = require("electron");
const probe = { attempts: [], writes: [], pending: [], mode: "normal" };
Reflect.set(globalThis, ${JSON.stringify(probeKey)}, probe);
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, channel === "json-craft:copy" ? async (_event, text) => {
  probe.attempts.push(text);
  if (probe.mode === "fail") throw new Error(${JSON.stringify(failureMessage)});
  if (probe.mode === "hold") await new Promise((resolve) => probe.pending.push(resolve));
  probe.writes.push(text);
} : listener);
require(${JSON.stringify(path.join(projectRoot, "electron", "main.cjs"))});
`,
      "utf8",
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
      if (running) {
        await setCopyMode(running, "normal");
        await running.close();
      }
    };
    const launch = async () => {
      await isolateWorkspace(path.join(workspace, "user-data"));
      application = await _electron.launch({
        args: [
          bootstrap,
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
      await page
        .getByRole("checkbox", { name: "格式化后自动复制", exact: true })
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
      "defaults to disabled and does not copy at startup or after formatting",
      async () => {
        assert.equal((await loadWorkspace(page)).settings.autoCopy, false);
        assert.equal(
          await page
            .getByRole("checkbox", { name: "格式化后自动复制", exact: true })
            .isChecked(),
          false,
        );
        const raw = '{"automaticCopy":"off"}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        await formatThroughMenu(application!, page);
        await expectQuiet(application!);
      },
    );

    await t.test(
      "enables copying without copying immediately and copies manual, edited, and option-driven results",
      async () => {
        await toggleAutoCopy(page, true);
        await expectQuiet(application!);
        const manual = '{\n  "automaticCopy": "off"\n}';
        await formatThroughMenu(application!, page);
        await expectCopies(application!, [manual]);
        const raw = '{"edited":true,"value":0}';
        const expected = JSON.stringify(JSON.parse(raw), null, 2);
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, expected);
        await expectCopies(application!, [manual, expected]);
        const indent = page.getByRole("combobox", {
          name: "JSON 缩进",
          exact: true,
        });
        await indent.click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        const fourSpaces = JSON.stringify(JSON.parse(raw), null, 4);
        await expectOutput(page, fourSpaces);
        await expectCopies(application!, [manual, expected, fourSpaces]);
        await indent.click();
        await page.getByRole("option", { name: "2 空格", exact: true }).click();
        await expectOutput(page, expected);
        await expectCopies(application!, [
          manual,
          expected,
          fourSpaces,
          expected,
        ]);
      },
    );

    await t.test(
      "copies extracted values and the restored full result without replacing original input",
      async () => {
        const raw = JSON.stringify({ payload: '{"answer":42}', context: true });
        const full = JSON.stringify(
          { payload: { answer: 42 }, context: true },
          null,
          2,
        );
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, full);
        assert.equal(await editorText(page, "input"), raw);
        await poll(
          () => copyState(application!),
          (state) => state.writes.at(-1) === full,
          "Editing did not copy the full visible result",
        );
        await resetCopies(application!);
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        const extracted = '{\n  "answer": 42\n}';
        await expectOutput(page, extracted);
        await expectCopies(application!, [extracted]);
        assert.equal(await editorText(page, "input"), raw);
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectOutput(page, full);
        await expectCopies(application!, [extracted, full]);
      },
    );

    await t.test(
      "does not copy failed formats and keeps successful output usable after a native-copy failure",
      async () => {
        await resetCopies(application!);
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .fill('{"bad":"\\uZZZZ"}');
        await poll(
          () => page.getByTestId("processing-status").innerText(),
          (value) => /无法|失败|错误/.test(value),
          "The invalid JSON did not fail formatting",
        );
        await expectQuiet(application!);
        await setCopyMode(application!, "fail");
        const raw = '{"copyFailure":"result remains usable"}';
        const expected = JSON.stringify(JSON.parse(raw), null, 2);
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, expected);
        await poll(
          () => copyState(application!),
          (state) => state.attempts.length === 1,
          "The successful format did not attempt native copying",
        );
        await poll(
          () => page.locator(".application").innerText(),
          (value) => value.includes(failureMessage),
          "The failed native copy did not produce user feedback",
        );
        assert.deepEqual((await copyState(application!)).writes, []);
        await expectOutput(page, expected);
        assert.equal(
          await page
            .getByRole("button", { name: "复制", exact: true })
            .isEnabled(),
          true,
        );
        await setCopyMode(application!, "normal");
      },
    );

    await t.test(
      "skips intermediate automatic copies while an earlier native copy is pending",
      async () => {
        await resetCopies(application!);
        await setCopyMode(application!, "hold");
        const values = ["A", "B", "C"].map((value) =>
          JSON.stringify({ queued: value }, null, 2),
        );
        try {
          await page
            .getByTestId("input-editor")
            .locator(".cm-content")
            .fill('{"queued":"A"}');
          await expectOutput(page, values[0]);
          await poll(
            () => copyState(application!),
            (state) => state.pending === 1,
            "The first native copy did not enter the simulated pending state",
          );
          for (const index of [1, 2]) {
            await page
              .getByTestId("input-editor")
              .locator(".cm-content")
              .fill(`{"queued":"${["A", "B", "C"][index]}"}`);
            await expectOutput(page, values[index]);
          }
          assert.deepEqual((await copyState(application!)).attempts, [
            values[0],
          ]);
          await setCopyMode(application!, "normal");
          await expectCopies(application!, [values[0], values[2]]);
          await expectQuiet(application!, [values[0], values[2]]);
        } finally {
          await setCopyMode(application!, "normal");
        }
      },
    );

    await t.test(
      "copies only the active imported document and leaves passive history selection and restart quiet",
      async () => {
        await resetCopies(application!);
        const first = path.join(workspace, "active-import.json");
        const background = path.join(workspace, "background-import.json");
        await Promise.all([
          writeFile(first, '{"imported":"active"}', "utf8"),
          writeFile(background, '{"imported":"background"}', "utf8"),
        ]);
        await application!.evaluate(
          ({ dialog }, paths) => {
            dialog.showOpenDialog = (async () => ({
              canceled: false,
              filePaths: paths,
            })) as typeof dialog.showOpenDialog;
          },
          [first, background],
        );
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        const activeOutput = '{\n  "imported": "active"\n}';
        const backgroundOutput = '{\n  "imported": "background"\n}';
        await expectOutput(page, activeOutput);
        await expectCopies(application!, [activeOutput]);
        await expectQuiet(application!, [activeOutput]);
        await resetCopies(application!);
        await page
          .getByRole("button", { name: /^background-import\.json，/ })
          .click();
        await expectOutput(page, backgroundOutput);
        await expectQuiet(application!);
        await page
          .getByRole("button", { name: /^active-import\.json，/ })
          .click();
        await expectOutput(page, activeOutput);
        await expectQuiet(application!);
        await restart();
        await expectOutput(page, activeOutput);
        assert.equal(
          await page
            .getByRole("checkbox", { name: "格式化后自动复制", exact: true })
            .isChecked(),
          true,
        );
        assert.equal((await loadWorkspace(page)).settings.autoCopy, true);
        await expectQuiet(application!);
      },
    );

    await t.test(
      "cancels a pending edit copy when history is switched away and back before formatting",
      async () => {
        await resetCopies(application!);
        const raw = '{"passiveReturn":"edited before switching"}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              ".history-entry-select",
            ),
          );
          buttons
            .find((button) =>
              button
                .getAttribute("aria-label")
                ?.startsWith("background-import.json，"),
            )!
            .click();
          buttons
            .find((button) =>
              button
                .getAttribute("aria-label")
                ?.startsWith("active-import.json，"),
            )!
            .click();
        });
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        assert.equal(await editorText(page, "input"), raw);
        await expectQuiet(application!);
      },
    );

    await t.test(
      "persists disabling automatic copy while keeping manual copy and native export available",
      async () => {
        await toggleAutoCopy(page, false);
        await expectQuiet(application!);
        await restart();
        assert.equal(
          await page
            .getByRole("checkbox", { name: "格式化后自动复制", exact: true })
            .isChecked(),
          false,
        );
        assert.equal((await loadWorkspace(page)).settings.autoCopy, false);
        const raw = '{"manual":"still works"}';
        const expected = JSON.stringify(JSON.parse(raw), null, 2);
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, expected);
        await formatThroughMenu(application!, page);
        await expectQuiet(application!);
        await assertFooter(page);
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await expectCopies(application!, [expected]);
        const exported = path.join(workspace, "footer-export.json");
        await application!.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: target,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => null),
          (value) => value === expected + "\n",
          "The footer export did not write the displayed result",
        );
      },
    );

    await t.test(
      "uses the same footer actions in output focus and at the minimum window size",
      async () => {
        const copy = page.getByRole("button", { name: "复制", exact: true });
        const original = await copy.elementHandle();
        assert.ok(original);
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () =>
            page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          (value) => value.width === 780 && value.height === 600,
          "The window did not reach its compact content size",
        );
        await assertFooter(page);
        await page
          .getByRole("button", { name: "独占查看格式化结果", exact: true })
          .click();
        assert.equal(
          await page.locator(".application").getAttribute("data-focused-pane"),
          "output",
        );
        await assertFooter(page);
        assert.equal(
          await original.evaluate(
            (element) =>
              element.isConnected &&
              element.closest('[data-pane="output"] .editor-footer') !== null,
          ),
          true,
        );
        await resetCopies(application!);
        const expected = await editorText(page, "output");
        await copy.click();
        await expectCopies(application!, [expected]);
        const exported = path.join(workspace, "focused-footer-export.json");
        await application!.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: target,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => null),
          (value) => value === expected + "\n",
          "The focused footer export did not write the displayed result",
        );
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-focused-pane"),
          (value) => value === null,
          "Escape did not restore both editor panes",
        );
        await assertFooter(page);
      },
    );

    await t.test(
      "finishes automatic-copy workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
