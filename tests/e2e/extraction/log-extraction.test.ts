import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = path.join(projectRoot, "output", "playwright");

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 15_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 600)}`);
}

async function copyEditor(page: Page, testId: string) {
  const content = page.getByTestId(testId).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const result = await content.evaluate((element) => {
    const transfer = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
    return transfer.getData("text/plain");
  });
  await content.press("ArrowLeft");
  return result;
}

async function paste(page: Page, testId: string, text: string) {
  const content = page.getByTestId(testId).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  await content.evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, text);
}

function tabs(page: Page) {
  return page.getByTestId("log-result-tabs").locator(".log-result-tab");
}

async function expectCount(page: Page, count: number) {
  await poll(
    async () => ({
      count: await tabs(page).count(),
      status: await page.getByTestId("log-extraction-status").innerText(),
      busy: await page.locator(".log-results-panel").getAttribute("aria-busy"),
    }),
    (value) =>
      value.count === count &&
      value.busy === "false" &&
      /(?:提取到 \d+ 项 JSON|Found \d+ JSON items)/.test(value.status),
    "Log extraction did not settle on the expected result set",
  );
}

async function extract(page: Page, text: string, count: number) {
  await paste(page, "log-input-editor", text);
  await page.getByTestId("extract-log-json").click();
  await expectCount(page, count);
}

async function expectPreview(page: Page, value: unknown) {
  await poll(
    () => copyEditor(page, "log-preview-editor"),
    (actual) => {
      try {
        return JSON.stringify(JSON.parse(actual)) === JSON.stringify(value);
      } catch {
        return false;
      }
    },
    "The selected JSON preview does not match its formatted source",
  );
}

async function records(page: Page): Promise<HistoryRecord[]> {
  return page.evaluate(async () => {
    const workspace = await window.desktop!.workspace.load();
    return Promise.all(
      workspace.records.map((record) =>
        window.desktop!.workspace.read(record.id),
      ),
    );
  });
}

test(
  "Electron extracts log JSON, previews results, and migrates durable editable files",
  { timeout: 180_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-log-extraction-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "dark";
    config.settings.language = "zh-CN";
    config.settings.autoCopy = false;
    config.settings.recursiveUnescape = true;
    await writeFile(configPath, JSON.stringify(config));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    const application = await _electron.launch({
      args: [projectRoot, `--user-data-dir=${profile}`],
      cwd: projectRoot,
      env: environment,
    });
    let blockedDirectory = false;
    const writeDirectory = config.settings.writeDirectory as string;
    const backupDirectory = `${writeDirectory}-backup`;
    t.after(async () => {
      try {
        if (blockedDirectory) {
          await rm(writeDirectory, { force: true });
          await rename(backupDirectory, writeDirectory);
        }
        await application.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Renderer crashed"));
    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 900);
      window.show();
      window.focus();
      Reflect.set(globalThis, "__logExtractionCopies", []);
      ipcMain.removeHandler("json-craft:copy");
      ipcMain.handle("json-craft:copy", (_event, text) => {
        Reflect.get(globalThis, "__logExtractionCopies").push(text);
      });
    });
    await mkdir(artifacts, { recursive: true });
    await page.getByTestId("open-log-extraction").click();
    const feature = page.getByTestId("log-extraction-page");
    await feature.waitFor();

    const firstRaw = {
      id: 1,
      payload: '{"nested":[1,2]}',
      note: "[REDACTED]",
      link: "[View profile](https://example.com/profile/1)",
    };
    const first = { ...firstRaw, payload: { nested: [1, 2] } };
    const second = [{ id: 2 }, { id: 3 }];
    const third = { ready: true, message: "safe" };
    const mixedLog = [
      "[INFO] Starting request; [REDACTED] [View profile](https://example.com/profile/1)",
      `2026-11-10T10:00:00Z request=${JSON.stringify(firstRaw)} elapsed=12ms`,
      `DEBUG items=${JSON.stringify(second)} finished`,
      `INFO escaped=${JSON.stringify(JSON.stringify(third))} done`,
    ].join("\n");

    await t.test(
      "shows extracted JSON in accessible tabs without result selection controls",
      async () => {
        await extract(page, mixedLog, 3);
        assert.equal(await feature.getByRole("tablist").count(), 1);
        assert.equal(await feature.getByRole("tabpanel").count(), 1);
        assert.equal(
          await page.locator(".log-results-panel input[type=checkbox]").count(),
          0,
        );
        assert.equal(await page.getByTestId("log-migrate-selected").count(), 0);
        assert.equal((await records(page)).length, 0);
        await expectPreview(page, first);
        const firstTab = tabs(page).nth(0).getByRole("tab");
        assert.equal(await firstTab.getAttribute("aria-selected"), "true");
        await tabs(page).nth(1).getByRole("tab").click();
        await expectPreview(page, second);
        await tabs(page).nth(2).getByRole("tab").click();
        await expectPreview(page, third);
        assert.equal(await copyEditor(page, "log-input-editor"), mixedLog);
        await page.screenshot({
          path: path.join(artifacts, "log-extraction-dark-results.png"),
        });
      },
    );

    await t.test(
      "expands the tab preview, locates original text, and gives timed copy feedback",
      async () => {
        const before = await copyEditor(page, "log-preview-editor");
        await page.getByTestId("log-preview-expand").click();
        await poll(
          () =>
            page.locator(".application").getAttribute("data-sidebar-collapsed"),
          (value) => value === "true",
          "Expanded JSON preview did not use the full app content area",
        );
        assert.equal(
          await feature.getAttribute("data-preview-expanded"),
          "true",
        );
        assert.equal(
          await page.getByTestId("log-input-editor").isVisible(),
          false,
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(await copyEditor(page, "log-preview-editor"), before);
        const copy = feature.locator(".log-preview-footer .copy-button");
        await copy.click();
        await poll(
          () => copy.getAttribute("data-copied"),
          (value) => value === "true",
          "The copy icon did not acknowledge success",
        );
        assert.equal(await copy.locator("svg.lucide-check").count(), 1);
        assert.equal(
          await application.evaluate(() =>
            Reflect.get(globalThis, "__logExtractionCopies").at(-1),
          ),
          before,
        );
        await delay(2150);
        assert.equal(await copy.getAttribute("data-copied"), null);
        assert.equal(await copy.locator("svg.lucide-copy").count(), 1);
        await page.screenshot({
          path: path.join(artifacts, "log-extraction-dark-expanded.png"),
        });
        await page.keyboard.press("Escape");
        assert.equal(await feature.getAttribute("data-preview-expanded"), null);
        await feature.locator(".log-locate-source").click();
        const selected = await page
          .getByTestId("log-input-editor")
          .locator(".cm-content")
          .evaluate(() => window.getSelection()?.toString());
        assert.equal(selected, JSON.stringify(JSON.stringify(third)));
      },
    );

    await t.test(
      "scrolls overflowing tabs and supports hover close controls and keyboard navigation",
      async () => {
        const data = Array.from({ length: 24 }, (_, index) => ({
          id: index + 1,
          name: `result-${index + 1}`,
        }));
        await extract(
          page,
          data
            .map((value) => `INFO result=${JSON.stringify(value)}`)
            .join("\n"),
          24,
        );
        const strip = page.getByTestId("log-result-tabs");
        assert.equal(
          await strip.evaluate((el) => el.scrollWidth > el.clientWidth),
          true,
        );
        await page
          .getByTestId("log-input-editor")
          .locator(".cm-content")
          .focus();
        await page.mouse.move(10, 10);
        const closeFirst = tabs(page).nth(0).locator(".log-tab-close");
        const scrollbar = page.getByTestId("overlay-scrollbars");
        const initialGeometry = await strip.evaluate((el) => ({
          width: el.clientWidth,
          height: el.clientHeight,
          outerHeight: el.getBoundingClientRect().height,
        }));
        assert.equal(initialGeometry.outerHeight, 34);
        assert.equal(initialGeometry.height, 33);
        const tabEdges = await strip.evaluate((el) => {
          const strip = el.getBoundingClientRect();
          const tab = el
            .querySelector(".log-result-tab")!
            .getBoundingClientRect();
          return {
            top: tab.top - strip.top,
            bottom: strip.bottom - tab.bottom,
          };
        });
        assert.deepEqual(tabEdges, { top: 0, bottom: 1 });
        await poll(
          () => scrollbar.isVisible(),
          (value) => !value,
          "The tab scrollbar stayed visible without hover",
        );
        await poll(
          () => closeFirst.evaluate((el) => getComputedStyle(el).opacity),
          (value) => value === "0",
          "Tab close controls stayed visible without hover or keyboard focus",
        );
        await tabs(page).nth(0).hover();
        await poll(
          () => scrollbar.locator('[data-axis="x"]').isVisible(),
          Boolean,
          "Hovering overflowing tabs did not reveal an overlay scrollbar",
        );
        const railEdge = await scrollbar
          .locator('[data-axis="x"]')
          .boundingBox();
        const stripEdge = await strip.boundingBox();
        assert.ok(railEdge && stripEdge, "The tab scrollbar is missing");
        assert.ok(
          Math.abs(
            railEdge.y + railEdge.height - (stripEdge.y + stripEdge.height - 1),
          ) <= 1,
          "The tab scrollbar leaves unused space above the bottom border",
        );
        const hoveredGeometry = await strip.evaluate((el) => ({
          width: el.clientWidth,
          height: el.clientHeight,
          outerHeight: el.getBoundingClientRect().height,
        }));
        assert.deepEqual(hoveredGeometry, initialGeometry);
        await poll(
          () => closeFirst.evaluate((el) => getComputedStyle(el).opacity),
          (value) => Number(value) > 0.9,
          "Hovering the tab did not reveal its close control",
        );
        await tabs(page).nth(0).getByRole("tab").click();
        await page.mouse.move(10, 10);
        await poll(
          () => closeFirst.evaluate((el) => getComputedStyle(el).opacity),
          (value) => value === "0",
          "Mouse-focused tabs should hide close controls when the pointer leaves",
        );
        await strip.hover();
        await page.mouse.wheel(520, 0);
        const forward = await poll(
          () => strip.evaluate((el) => el.scrollLeft),
          (value) => value > 100,
          "Horizontal scrolling did not reveal overflowing tabs",
        );
        await page.mouse.wheel(-420, 0);
        await poll(
          () => strip.evaluate((el) => el.scrollLeft),
          (value) => value < forward - 50,
          "Tabs could not be scrolled back to earlier results",
        );
        const beforeWheel = await strip.evaluate((el) => el.scrollLeft);
        await page.mouse.wheel(0, 240);
        await poll(
          () => strip.evaluate((el) => el.scrollLeft),
          (value) => value > beforeWheel + 50,
          "Vertical mouse wheels did not scroll the overflowing tab strip",
        );
        await tabs(page).nth(20).hover();
        const scrolledBeforeClose = await strip.evaluate((el) => el.scrollLeft);
        const closedTabWidth = await tabs(page)
          .nth(20)
          .evaluate((el) => el.getBoundingClientRect().width);
        await tabs(page).nth(20).locator(".log-tab-close").click();
        await delay(100);
        const scrolledAfterClose = await strip.evaluate((el) => el.scrollLeft);
        assert.ok(
          scrolledAfterClose >= scrolledBeforeClose - closedTabWidth - 10,
          "Closing a background tab jumped away from the current scroll position",
        );
        await expectPreview(page, data[0]);
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 24);
        await tabs(page).nth(23).getByRole("tab").click();
        await expectPreview(page, data[23]);
        await tabs(page).nth(23).getByRole("tab").focus();
        await page.keyboard.press("Home");
        await expectPreview(page, data[0]);
        await tabs(page).nth(0).getByRole("tab").focus();
        await page.keyboard.press("ArrowRight");
        await expectPreview(page, data[1]);
        await tabs(page).nth(1).getByRole("tab").focus();
        await page.keyboard.press("End");
        await expectPreview(page, data[23]);
        await tabs(page).nth(23).getByRole("tab").focus();
        await page.keyboard.press("ArrowLeft");
        await expectPreview(page, data[22]);
        await tabs(page).nth(22).getByRole("tab").focus();
        await page.keyboard.press("Delete");
        assert.equal(await tabs(page).count(), 23);
        await expectPreview(page, data[23]);
        await tabs(page).last().getByRole("tab").focus();
        await page.keyboard.press("Delete");
        assert.equal(await tabs(page).count(), 22);
        await expectPreview(page, data[21]);
        await tabs(page).nth(0).hover();
        await tabs(page).nth(0).locator(".log-tab-close").click();
        assert.equal(await tabs(page).count(), 21);
        await expectPreview(page, data[21]);
        await page.getByTestId("log-preview-expand").click();
        while (await tabs(page).count()) {
          await tabs(page).first().hover();
          await tabs(page).first().locator(".log-tab-close").click();
        }
        assert.equal(
          await page
            .getByTestId("log-preview-editor")
            .locator(".cm-content")
            .count(),
          0,
        );
        assert.equal(
          await page.getByTestId("log-migrate-all").isDisabled(),
          true,
        );
        assert.equal((await records(page)).length, 0);
        assert.equal(await feature.getAttribute("data-preview-expanded"), null);
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 24);
        await page.screenshot({
          path: path.join(artifacts, "log-extraction-dark-tabs-overflow.png"),
        });
      },
    );

    await t.test(
      "reformats remaining tabs while preserving closed results and the active tab",
      async () => {
        await extract(page, mixedLog, 3);
        await tabs(page).nth(1).hover();
        await tabs(page).nth(1).locator(".log-tab-close").click();
        assert.equal(await tabs(page).count(), 2);
        await tabs(page).nth(0).getByRole("tab").click();
        const recursive = feature.getByRole("checkbox", {
          name: "递归去转义",
          exact: true,
        });
        await recursive.uncheck();
        await expectCount(page, 2);
        await expectPreview(page, firstRaw);
        await poll(
          () =>
            page.evaluate(
              async () =>
                (await window.desktop!.workspace.load()).settings
                  .recursiveUnescape,
            ),
          (value) => value === false,
          "The recursive preference did not finish saving",
        );
        const auto = feature.getByRole("checkbox", {
          name: "自动去转义",
          exact: true,
        });
        await auto.uncheck();
        await expectCount(page, 2);
        assert.equal(await recursive.isDisabled(), true);
        await tabs(page).nth(1).getByRole("tab").click();
        await expectPreview(page, JSON.stringify(third));
        await auto.check();
        await expectCount(page, 2);
        await expectPreview(page, third);
        assert.equal(
          await tabs(page)
            .nth(1)
            .getByRole("tab")
            .getAttribute("aria-selected"),
          "true",
        );
        await recursive.check();
        await expectCount(page, 2);
        await expectPreview(page, third);
        await tabs(page).nth(0).getByRole("tab").click();
        await expectPreview(page, first);
        await feature
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        await expectCount(page, 2);
        await poll(
          () => copyEditor(page, "log-preview-editor"),
          (value) => value.includes('\n    "id"'),
          "Indent changes did not reformat the remaining tabs",
        );
        await feature
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "2 空格", exact: true }).click();
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 3);
        await extract(
          page,
          "INFO body={project:'JSON Craft',enabled:True,} done",
          1,
        );
        await expectPreview(page, { project: "JSON Craft", enabled: true });
        const repair = feature.getByRole("checkbox", {
          name: "尝试修复",
          exact: true,
        });
        await repair.uncheck();
        await expectCount(page, 0);
        await repair.check();
        await expectCount(page, 1);
      },
    );

    await t.test(
      "invalidates old tabs on edits and does not let a delayed clear overwrite replacement logs",
      async () => {
        await paste(page, "log-input-editor", 'INFO changed={"new":true}');
        await poll(
          () => tabs(page).count(),
          (count) => count === 0,
          "Old tabs remained actionable after the source changed",
        );
        assert.equal(
          await page.getByTestId("log-migrate-all").isDisabled(),
          true,
        );
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 1);
        await expectPreview(page, { new: true });
        await paste(
          page,
          "log-input-editor",
          Array.from(
            { length: 1500 },
            (_, index) => `INFO body={"index":${index}}`,
          ).join("\n"),
        );
        await page.getByTestId("extract-log-json").click();
        await feature
          .getByRole("button", { name: "清空日志", exact: true })
          .click();
        await delay(650);
        assert.equal(await tabs(page).count(), 0);
        assert.equal(
          await page.getByTestId("extract-log-json").isDisabled(),
          true,
        );
        assert.equal(await copyEditor(page, "log-input-editor"), "");
        const replacement = 'INFO fresh={"afterClear":true,"sequence":2}';
        await paste(page, "log-input-editor", replacement);
        await delay(1700);
        assert.equal(await copyEditor(page, "log-input-editor"), replacement);
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 1);
        await expectPreview(page, { afterClear: true, sequence: 2 });
        await extract(
          page,
          'INFO first={"same":true}\nINFO second={"same":true}',
          2,
        );
        await tabs(page).nth(1).getByRole("tab").click();
        await expectPreview(page, { same: true });
      },
    );

    await t.test(
      "moves only open results once and closing saved tabs does not delete their files",
      async () => {
        await extract(page, mixedLog, 3);
        await page.mouse.move(10, 10);
        await tabs(page).nth(1).locator(".log-tab-close").click();
        assert.equal(await tabs(page).count(), 2);
        await page.getByTestId("log-migrate-all").click();
        await poll(
          () =>
            tabs(page).evaluateAll(
              (elements) =>
                elements.filter(
                  (el) => el.getAttribute("data-migrated") === "true",
                ).length,
            ),
          (value) => value === 2,
          "Open results were not marked as saved",
        );
        const saved = await records(page);
        assert.equal(saved.length, 2);
        assert.deepEqual(
          saved
            .map((record) => JSON.parse(record.raw))
            .sort(
              (a, b) => Number(Boolean(a.ready)) - Number(Boolean(b.ready)),
            ),
          [first, third],
        );
        for (const record of saved) {
          assert.ok(record.managedPath);
          assert.equal(path.dirname(record.managedPath), writeDirectory);
          assert.equal(await readFile(record.managedPath, "utf8"), record.raw);
          assert.match(record.name, /^extracted-\d+\.json$/);
        }
        assert.equal(
          await page.getByTestId("log-migrate-all").isDisabled(),
          true,
        );
        await tabs(page).nth(0).hover();
        await tabs(page).nth(0).locator(".log-tab-close").click();
        assert.equal(await tabs(page).count(), 1);
        await expectPreview(page, third);
        assert.equal((await records(page)).length, 2);
        for (const record of saved)
          assert.equal(await readFile(record.managedPath!, "utf8"), record.raw);
      },
    );

    await t.test(
      "opens migrated history and keeps tabs while continuously saving file edits",
      async () => {
        const record = (await records(page))[0];
        assert.ok(record.managedPath);
        await page
          .locator(`[data-history-id="${record.id}"] .history-entry-select`)
          .click();
        await page.getByTestId("input-editor").waitFor();
        await poll(
          () => copyEditor(page, "input-editor"),
          (value) => value === record.raw,
          "Opening saved history did not restore migrated JSON",
        );
        const updated = JSON.stringify(
          { edited: true, source: "log-extraction" },
          null,
          2,
        );
        await paste(page, "input-editor", updated);
        await poll(
          () => readFile(record.managedPath!, "utf8"),
          (value) => value === updated,
          "Editing migrated JSON did not automatically update its file",
        );
        const restored = await page.evaluate(
          async (id) => window.desktop!.workspace.read(id),
          record.id,
        );
        assert.equal(restored.raw, updated);
        await page.getByTestId("open-log-extraction").click();
        assert.equal(await copyEditor(page, "log-input-editor"), mixedLog);
        assert.equal(await tabs(page).count(), 1);
        assert.equal(
          await page.getByTestId("log-migrate-all").isDisabled(),
          true,
        );
      },
    );

    await t.test(
      "retries a real file-system failure without duplicating cached history",
      async () => {
        const before = (await records(page)).length;
        await extract(
          page,
          'INFO retry={"retry":1}\nINFO retry={"retry":2}',
          2,
        );
        let failedIds: string[] = [];
        await rename(writeDirectory, backupDirectory);
        await writeFile(
          writeDirectory,
          "This file deliberately blocks the demo storage directory",
        );
        blockedDirectory = true;
        try {
          await page.getByTestId("log-migrate-all").click();
          await feature.getByRole("alert").waitFor();
          assert.equal(
            await tabs(page).evaluateAll(
              (elements) =>
                elements.filter(
                  (el) => el.getAttribute("data-migrated") === "true",
                ).length,
            ),
            0,
          );
          assert.equal(
            await page.getByTestId("log-migrate-all").isEnabled(),
            true,
          );
          const failed = await records(page);
          assert.equal(failed.length, before + 1);
          failedIds = failed.map((record) => record.id);
        } finally {
          await rm(writeDirectory);
          await rename(backupDirectory, writeDirectory);
          blockedDirectory = false;
        }
        const recursive = feature.getByRole("checkbox", {
          name: "递归去转义",
          exact: true,
        });
        await recursive.setChecked(!(await recursive.isChecked()));
        await expectCount(page, 2);
        await page.getByTestId("log-migrate-all").click();
        const saved = await poll(
          () => records(page),
          (value) =>
            value.length === before + 2 &&
            value.every(
              (record) => Boolean(record.managedPath) && !record.fileSaveError,
            ),
          "Retrying migration duplicated history or left files unsaved",
        );
        for (const record of saved)
          assert.equal(await readFile(record.managedPath!, "utf8"), record.raw);
        assert.equal(
          new Set(saved.map((record) => record.id)).size,
          before + 2,
        );
        for (const id of failedIds)
          assert.ok(saved.some((record) => record.id === id));
        assert.equal(
          await page.getByTestId("log-migrate-all").isDisabled(),
          true,
        );
      },
    );

    await t.test(
      "preserves drafts across comparison and settings with bilingual themes and compact layout",
      async () => {
        const draft = await copyEditor(page, "log-input-editor");
        await page.getByTestId("open-comparison").click();
        await page.getByTestId("comparison-page").waitFor();
        await page.getByTestId("open-log-extraction").click();
        assert.equal(await copyEditor(page, "log-input-editor"), draft);
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .nth(1)
          .click();
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "Light", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "light",
          "The light theme did not apply",
        );
        await page.locator(".workspace-settings-back").click();
        await feature.waitFor();
        assert.equal(
          await page.getByTestId("open-log-extraction").innerText(),
          "JSON Extract",
        );
        assert.equal(await copyEditor(page, "log-input-editor"), draft);
        await extract(page, mixedLog, 3);
        await page.screenshot({
          path: path.join(artifacts, "log-extraction-light-english.png"),
        });
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 720),
        );
        await page.getByTestId("extract-log-json").scrollIntoViewIfNeeded();
        await page.getByTestId("extract-log-json").click();
        await expectCount(page, 3);
        await tabs(page).nth(1).getByRole("tab").click();
        await expectPreview(page, second);
        await page.getByTestId("log-preview-expand").click();
        const bounds = await page
          .getByTestId("log-preview-editor")
          .boundingBox();
        assert.ok(bounds && bounds.width > 400 && bounds.height > 280);
        assert.equal(
          await page
            .locator("body")
            .evaluate((body) => body.scrollWidth <= innerWidth + 2),
          true,
        );
        await page.getByTestId("log-preview-back").click();
        await page.getByTestId("log-migrate-all").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(artifacts, "log-extraction-light-english-780.png"),
        });
      },
    );

    await t.test(
      "does not auto-copy a hidden workspace document while changing extraction options",
      async () => {
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
        );
        await page.getByTestId("log-extraction-back").click();
        await page.getByTestId("input-editor").waitFor();
        await page
          .getByRole("checkbox", { name: "Copy after formatting", exact: true })
          .check();
        await poll(
          () =>
            page.evaluate(
              async () =>
                (await window.desktop!.workspace.load()).settings.autoCopy,
            ),
          (value) => value === true,
          "The auto-copy setting did not finish saving",
        );
        await poll(
          () => page.getByTestId("processing-status").getAttribute("class"),
          (value) => /kind-(ok|repair)/.test(value ?? ""),
          "The workspace formatter did not settle",
        );
        await delay(500);
        const baseline = await application.evaluate(
          () =>
            Reflect.get(globalThis, "__logExtractionCopies").length as number,
        );
        await page.getByTestId("open-log-extraction").click();
        const recursive = feature.getByRole("checkbox", {
          name: "Recursive unescape",
          exact: true,
        });
        const previous = await recursive.isChecked();
        await recursive.setChecked(!previous);
        await expectCount(page, 3);
        await tabs(page).nth(0).getByRole("tab").click();
        await expectPreview(page, previous ? firstRaw : first);
        await poll(
          () =>
            page.evaluate(
              async () =>
                (await window.desktop!.workspace.load()).settings
                  .recursiveUnescape,
            ),
          (value) => value === !previous,
          "The extraction preference did not finish saving",
        );
        await delay(500);
        assert.equal(
          await application.evaluate(
            () => Reflect.get(globalThis, "__logExtractionCopies").length,
          ),
          baseline,
          "A hidden workspace document replaced the clipboard during extraction",
        );
        const expected = await copyEditor(page, "log-preview-editor");
        await feature.locator(".log-preview-footer .copy-button").click();
        await poll(
          () =>
            application.evaluate(
              () =>
                Reflect.get(globalThis, "__logExtractionCopies")
                  .length as number,
            ),
          (value) => value === baseline + 1,
          "Explicit preview copying did not reach the native handler",
        );
        assert.equal(
          await application.evaluate(() =>
            Reflect.get(globalThis, "__logExtractionCopies").at(-1),
          ),
          expected,
        );
      },
    );
    assert.deepEqual(errors, []);
  },
);
