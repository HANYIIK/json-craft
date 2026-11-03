import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
type Pane = "input" | "output";
const entryNames = {
  input: "独占查看原始输入",
  output: "独占查看格式化结果",
};

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

async function editorText(page: Page, pane: Pane) {
  return (
    await page
      .getByTestId(`${pane}-editor`)
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function returnToSplit(page: Page) {
  if (await page.locator(".application").getAttribute("data-focused-pane")) {
    await page.getByRole("button", { name: "返回双栏", exact: true }).click();
  }
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === null,
    "The app did not return to both panes",
  );
}

async function prepare(page: Page, raw: string, expected?: string) {
  await returnToSplit(page);
  const input = page.getByTestId("input-editor").locator(".cm-content");
  await input.focus();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText(raw);
  await page.getByTestId("output-editor").locator(".cm-scroller").waitFor();
  if (expected !== undefined) {
    await poll(
      () => editorText(page, "output"),
      (value) => value === expected,
      "Unexpected formatted result",
    );
  }
}

async function enterFocus(page: Page, pane: Pane) {
  await page
    .getByRole("button", { name: entryNames[pane], exact: true })
    .click();
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === pane,
    "The requested editor did not enter focus mode",
  );
}

async function assertFullPane(
  page: Page,
  application: ElectronApplication,
  pane: Pane,
) {
  const geometry = await page.evaluate((target) => {
    const app = document.querySelector(".application")!;
    const titlebar = document.querySelector(".titlebar")!;
    const editor = document.querySelector(`[data-testid="${target}-editor"]`)!;
    const panel = editor.closest(".editor-panel")!;
    const appRect = app.getBoundingClientRect();
    const titlebarRect = titlebar.getBoundingClientRect();
    const filebar = document.querySelector(".workspace-filebar")!;
    const filebarRect = filebar.getBoundingClientRect();
    const paneRect = panel.getBoundingClientRect();
    return {
      app: {
        left: appRect.left,
        right: appRect.right,
        bottom: appRect.bottom,
      },
      titlebar: { bottom: titlebarRect.bottom },
      filebar: { top: filebarRect.top, bottom: filebarRect.bottom },
      pane: {
        left: paneRect.left,
        top: paneRect.top,
        right: paneRect.right,
        bottom: paneRect.bottom,
      },
      webFullscreen: document.fullscreenElement !== null,
    };
  }, pane);
  assert.ok(
    Math.abs(geometry.pane.left - geometry.app.left) <= 2,
    "Focused pane does not reach the app's left edge",
  );
  assert.ok(
    Math.abs(geometry.pane.right - geometry.app.right) <= 2,
    "Focused pane does not reach the app's right edge",
  );
  assert.ok(
    Math.abs(geometry.filebar.top - geometry.titlebar.bottom) <= 2,
    "The focused file status does not start below the titlebar",
  );
  assert.equal(await page.locator(".workspace-filebar").isVisible(), true);
  assert.ok(
    Math.abs(geometry.pane.top - geometry.filebar.bottom) <= 2,
    "Focused pane does not start below the file status",
  );
  assert.ok(
    Math.abs(geometry.pane.bottom - geometry.app.bottom) <= 2,
    "Focused pane does not reach the app's bottom edge",
  );
  assert.equal(geometry.webFullscreen, false);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreen(),
    ),
    false,
  );
  assert.equal(await page.locator(".titlebar").isVisible(), true);
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  assert.equal(
    await page
      .getByTestId(`${pane === "input" ? "output" : "input"}-editor`)
      .isVisible(),
    false,
  );
}

test(
  "Electron editor focus preserves editing and viewing state",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-focus-"));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    await isolateWorkspace(path.join(workspace, "user-data"));
    const application = await _electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${path.join(workspace, "user-data")}`,
      ],
      cwd: projectRoot,
      env: environment,
      timeout: 30_000,
    });
    t.after(async () => {
      try {
        await application.close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: entryNames.input, exact: true })
      .waitFor();
    await page.getByTestId("repair-count").waitFor();

    await t.test(
      "each entry fills the app below the titlebar without a modal or native fullscreen",
      async () => {
        const raw = '{"focus":true,"items":[1,2]}';
        const formatted = JSON.stringify(JSON.parse(raw), null, 2);
        await prepare(page, raw, formatted);
        for (const pane of ["input", "output"] as const) {
          await enterFocus(page, pane);
          await assertFullPane(page, application, pane);
          await page
            .getByRole("button", { name: "自动换行", exact: true })
            .waitFor();
          if (pane === "input") {
            assert.equal(
              await page
                .getByRole("button", { name: "格式化", exact: true })
                .count(),
              0,
            );
          } else {
            await page
              .getByRole("button", { name: "复制", exact: true })
              .waitFor();
            await page
              .getByRole("button", { name: "导出", exact: true })
              .waitFor();
          }
          await returnToSplit(page);
          assert.equal(await editorText(page, "input"), raw);
          assert.equal(await editorText(page, "output"), formatted);
        }
      },
    );

    await t.test(
      "preserves the input selection and undo history across focus transitions",
      async () => {
        const raw = '{"value":"before"}';
        await prepare(page, raw, '{\n  "value": "before"\n}');
        const input = page.getByTestId("input-editor").locator(".cm-content");
        await input.focus();
        await input.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await input.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await input.press("Shift+ArrowRight");
        assert.equal(
          await page.evaluate(() => window.getSelection()?.toString()),
          "before",
        );
        await enterFocus(page, "input");
        await input.focus();
        assert.equal(
          await page.evaluate(() => window.getSelection()?.toString()),
          "before",
        );
        await returnToSplit(page);
        await input.focus();
        assert.equal(
          await page.evaluate(() => window.getSelection()?.toString()),
          "before",
        );
        await enterFocus(page, "input");
        await input.focus();
        await delay(600);
        await page.keyboard.insertText("after");
        await poll(
          () => editorText(page, "input"),
          (value) => value === '{"value":"after"}',
          "The focused input is not editable",
        );
        await formatThroughMenu(application, page);
        await returnToSplit(page);
        await poll(
          () => editorText(page, "output"),
          (value) => value === '{\n  "value": "after"\n}',
          "Formatting in focused input did not update the result",
        );
        await input.focus();
        await input.press("ControlOrMeta+z");
        await poll(
          () => editorText(page, "input"),
          (value) => value === raw,
          "Focus transitions discarded the edit's undo history",
        );
        await poll(
          () => editorText(page, "output"),
          (value) => value === '{\n  "value": "before"\n}',
          "Undo did not restore the original JSON value",
        );
      },
    );

    await t.test(
      "lets the editor close its search panel before Escape returns to both panes",
      async () => {
        await prepare(
          page,
          '{"search":"preserve"}',
          '{\n  "search": "preserve"\n}',
        );
        await enterFocus(page, "input");
        const input = page.getByTestId("input-editor").locator(".cm-content");
        await input.focus();
        await input.press("ControlOrMeta+f");
        const searchPanel = page
          .getByTestId("input-editor")
          .locator(".cm-search");
        await searchPanel.waitFor();
        await page.keyboard.press("Escape");
        await searchPanel.waitFor({ state: "hidden" });
        assert.equal(
          await page.locator(".application").getAttribute("data-focused-pane"),
          "input",
        );
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-focused-pane"),
          (value) => value === null,
          "Escape did not return from input focus",
        );
        await enterFocus(page, "output");
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-focused-pane"),
          (value) => value === null,
          "Escape did not return from output focus",
        );
      },
    );

    await t.test(
      "scrolls each focused long document to its final line with the real wheel",
      async () => {
        const marker = "__FOCUSED_JSON_END__";
        const raw = JSON.stringify(
          {
            items: Array.from({ length: 250 }, (_, id) => ({
              id,
              value: `entry-${id}`,
            })),
            tail: marker,
          },
          null,
          2,
        );
        await prepare(page, raw);
        for (const pane of ["input", "output"] as const) {
          await enterFocus(page, pane);
          await assertFullPane(page, application, pane);
          const scroller = page
            .getByTestId(`${pane}-editor`)
            .locator(".cm-scroller");
          const metrics = () =>
            scroller.evaluate((element) => ({
              top: element.scrollTop,
              height: element.clientHeight,
              scrollHeight: element.scrollHeight,
            }));
          const initial = await metrics();
          assert.ok(
            initial.scrollHeight > initial.height + 1_000,
            "Long document did not overflow the focused editor",
          );
          await scroller.hover();
          await page.mouse.wheel(0, -1_000_000);
          await poll(
            metrics,
            (value) => value.top <= 2,
            "Focused editor did not scroll to its start",
          );
          await page.mouse.wheel(0, 700);
          await poll(
            metrics,
            (value) => value.top > 200,
            "Focused editor did not react to real wheel input",
          );
          await page.mouse.wheel(0, 1_000_000);
          await poll(
            metrics,
            (value) => value.top + value.height >= value.scrollHeight - 3,
            "Focused editor did not reach its bottom",
          );
          await poll(
            () =>
              scroller.evaluate((element, text) => {
                const viewport = element.getBoundingClientRect();
                return Array.from(element.querySelectorAll(".cm-line")).some(
                  (line) => {
                    const bounds = line.getBoundingClientRect();
                    return (
                      line.textContent?.includes(text) &&
                      bounds.top >= viewport.top - 2 &&
                      bounds.bottom <= viewport.bottom + 2
                    );
                  },
                );
              }, marker),
            Boolean,
            "The focused document's final marker is not visible",
          );
          await returnToSplit(page);
        }
      },
    );

    await t.test(
      "preserves expanded key candidates and the selected path while viewing an editor alone",
      async () => {
        const raw =
          '{"a":{"payload":{"from":"a"}},"items":[{"payload":[1,2]}]}';
        await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await poll(
          () => page.getByRole("radio").count(),
          (count) => count === 2,
          "Key candidates did not expand",
        );
        const selected = page.getByRole("radio", {
          name: /\$\.items\[0\]\.payload/,
        });
        await selected.check();
        await enterFocus(page, "output");
        await returnToSplit(page);
        assert.equal(await page.getByRole("radio").count(), 2);
        assert.equal(await selected.isChecked(), true);
        await page
          .getByRole("button", { name: "提取选中值", exact: true })
          .click();
        await poll(
          () => editorText(page, "output"),
          (value) => value === "[\n  1,\n  2\n]",
          "The preserved path did not extract its original value",
        );
      },
    );

    await t.test(
      "fits the focused controls and editors in a 780 by 600 content area",
      async () => {
        await prepare(page, '{"compact":true}', '{\n  "compact": true\n}');
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () =>
            page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          (value) => value.width === 780 && value.height === 600,
          "The native window did not reach the requested content size",
        );
        for (const pane of ["input", "output"] as const) {
          await enterFocus(page, pane);
          await assertFullPane(page, application, pane);
          const overflow = await page.evaluate((target) => {
            const app = document.querySelector(".application")!;
            const panel = document
              .querySelector(`[data-testid="${target}-editor"]`)!
              .closest(".editor-panel")!;
            const actions = Array.from(
              panel.querySelectorAll(".editor-header button"),
            )
              .map((button) => ({
                label: button.getAttribute("aria-label") || button.textContent,
                rect: button.getBoundingClientRect(),
              }))
              .filter(({ rect }) => rect.width > 0 && rect.height > 0)
              .map(({ label, rect }) => ({
                label,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              }));
            return {
              width: innerWidth,
              height: innerHeight,
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
              appWidth: app.clientWidth,
              appScrollWidth: app.scrollWidth,
              actions,
            };
          }, pane);
          assert.ok(
            overflow.scrollWidth <= overflow.width + 1,
            "The focused page overflows horizontally",
          );
          assert.ok(
            overflow.scrollHeight <= overflow.height + 1,
            "The focused page overflows vertically",
          );
          assert.ok(
            overflow.appScrollWidth <= overflow.appWidth + 1,
            "Focused app content exceeds its width",
          );
          for (const action of overflow.actions) {
            assert.ok(
              action.left >= 0 &&
                action.right <= overflow.width + 1 &&
                action.top >= 0 &&
                action.bottom <= overflow.height + 1,
              `Focused action is clipped: ${action.label}`,
            );
          }
          await returnToSplit(page);
        }
      },
    );

    await t.test(
      "finishes the focus workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
