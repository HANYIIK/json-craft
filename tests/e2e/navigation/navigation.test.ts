import assert from "node:assert/strict";
import {
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
import type { HistoryRecord, ThemePreference } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";
import { chooseHistoryAction } from "../support/history-menu";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = path.join(projectRoot, "output", "playwright");

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

async function editorText(page: Page) {
  return (
    await page.getByTestId("input-editor").locator(".cm-line").allTextContents()
  ).join("\n");
}

async function replaceInput(page: Page, raw: string) {
  const content = page.getByTestId("input-editor").locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  await content.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, raw);
}

async function savedRecord(page: Page, raw: string) {
  const record = await poll(
    () =>
      page.evaluate(async () => {
        const state = await window.desktop!.workspace.load();
        return state.activeId
          ? window.desktop!.workspace.read(state.activeId)
          : null;
      }),
    (value) => value?.raw === raw,
    "The current navigation document did not finish saving",
  );
  assert.ok(record);
  return record;
}

async function setCollapsed(page: Page, collapsed: boolean) {
  const label = collapsed ? "收起侧栏" : "展开侧栏";
  const button = page.getByRole("button", { name: label, exact: true });
  if (await button.isVisible()) await button.click();
  await poll(
    () => page.locator("#workspace-sidebar").isVisible(),
    (value) => value === !collapsed,
    "The sidebar did not reach its requested state",
  );
  const toggle = page.getByRole("button", {
    name: collapsed ? "展开侧栏" : "收起侧栏",
    exact: true,
  });
  assert.equal(await toggle.getAttribute("aria-expanded"), String(!collapsed));
}

async function expectTitle(page: Page, name: string) {
  await poll(
    () => page.getByTestId("active-file-name").innerText(),
    (value) => value.trim() === name,
    "The left-aligned titlebar did not follow the active document",
  );
}

async function chooseTheme(page: Page, theme: ThemePreference) {
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  const trigger = page.getByRole("combobox", {
    name: "外观主题",
    exact: true,
  });
  await trigger.click();
  await page
    .getByRole("option", {
      name: theme === "dark" ? "深色" : "浅色",
      exact: true,
    })
    .click();
  await poll(
    () => page.locator("html").getAttribute("data-theme"),
    (value) => value === theme,
    "The selected theme was not applied",
  );
  await page.getByRole("button", { name: "关闭应用设置", exact: true }).click();
}

async function filledViewport(page: Page) {
  return poll(
    () =>
      page
        .getByTestId("input-editor")
        .locator(".cm-scroller")
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const content = element.querySelector(".cm-content")!;
          const walker = document.createTreeWalker(
            content,
            NodeFilter.SHOW_TEXT,
          );
          const range = document.createRange();
          const intervals: [number, number][] = [];
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.length) continue;
            range.selectNodeContents(walker.currentNode);
            for (const rect of range.getClientRects())
              if (
                rect.width > 0 &&
                rect.bottom > bounds.top &&
                rect.top < bounds.bottom
              )
                intervals.push([
                  Math.max(0, rect.top - bounds.top),
                  Math.min(bounds.height, rect.bottom - bounds.top),
                ]);
          }
          intervals.sort((left, right) => left[0] - right[0]);
          let covered = 0;
          let blank = 0;
          for (const [from, to] of intervals) {
            blank = Math.max(blank, from - covered);
            covered = Math.max(covered, to);
          }
          return {
            blank: Math.max(blank, bounds.height - covered),
            rects: intervals.length,
            lineHeight: parseFloat(getComputedStyle(content).lineHeight),
          };
        }),
    (value) => value.rects > 0 && value.blank <= value.lineHeight * 2 + 5,
    "Collapsing the sidebar left blank content in a wrapped JSON string",
  );
}

test(
  "Electron navigation keeps file actions discoverable and preserves a collapsible workspace",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-navigation-")),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    await mkdir(artifacts, { recursive: true });
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const records: HistoryRecord[] = [
      {
        id: "navigation-alpha",
        name: "alpha.json",
        raw: '{"document":"alpha","items":[1,2,3]}',
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "navigation-beta",
        name: "beta.json",
        raw: '{"document":"beta","active":true}',
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    config.initialized = true;
    config.activeId = records[0].id;
    config.settings.theme = "dark";
    for (const record of records)
      await writeFile(
        path.join(
          config.settings.historyDirectory,
          `history-${record.id}.json`,
        ),
        JSON.stringify(record),
      );
    await writeFile(configPath, JSON.stringify(config));
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
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("crash", () => errors.push("Renderer crashed"));
      await page.getByTestId("active-file-name").waitFor();
      await poll(
        () =>
          page
            .getByRole("button", { name: "新建输入", exact: true })
            .isEnabled(),
        Boolean,
        "The navigation actions were not enabled after workspace loading",
      );
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 780);
        window.show();
        window.focus();
      });
      await page.evaluate(() => document.fonts.ready);
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
      "places import and new input below the brand and above history",
      async () => {
        await expectTitle(page, "alpha.json");
        const positions = await page.evaluate(() => {
          const sidebar = document.querySelector("#workspace-sidebar")!;
          const buttons = Array.from(sidebar.querySelectorAll("button"));
          const importButton = buttons.find(
            (element) => element.textContent?.trim() === "导入文件",
          )!;
          const newButton = buttons.find(
            (element) => element.textContent?.trim() === "新建输入",
          )!;
          return {
            sidebarTop: sidebar.getBoundingClientRect().top,
            brandBottom: sidebar
              .querySelector(".brand")!
              .getBoundingClientRect().bottom,
            importTop: importButton.getBoundingClientRect().top,
            newTop: newButton.getBoundingClientRect().top,
            historyTop: sidebar
              .querySelector(".file-section-header")!
              .getBoundingClientRect().top,
            newInTitlebar: Array.from(
              document.querySelectorAll(".titlebar button"),
            ).some(
              (element) => element.getAttribute("aria-label") === "新建输入",
            ),
          };
        });
        assert.ok(positions.importTop >= positions.brandBottom);
        assert.ok(positions.newTop >= positions.brandBottom);
        assert.ok(positions.importTop < positions.historyTop);
        assert.ok(positions.newTop < positions.historyTop);
        assert.ok(positions.importTop - positions.sidebarTop < 140);
        assert.equal(positions.newInTitlebar, false);
        assert.equal(await page.locator(".brand svg").count(), 1);
        assert.equal(await page.locator(".workspace-heading h1").count(), 0);
        assert.equal(
          await page
            .getByRole("button", { name: "新建输入", exact: true })
            .count(),
          1,
        );
      },
    );

    await t.test(
      "updates the title for selection, creation and renaming",
      async () => {
        await page
          .locator('[data-history-id="navigation-beta"] .history-entry-select')
          .click();
        await expectTitle(page, "beta.json");
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const name = (
          await page.getByTestId("active-file-name").innerText()
        ).trim();
        assert.match(name, /^untitled-\d+\.json$/);
        const raw = '{"navigation":"new input"}';
        await replaceInput(page, raw);
        await savedRecord(page, raw);
        await chooseHistoryAction(page, name, "rename");
        const renamed = "navigation-" + "long-file-name-".repeat(8) + ".json";
        const input = page.getByRole("textbox", {
          name: "文件名",
          exact: true,
        });
        await input.fill(renamed);
        await input.press("Enter");
        await expectTitle(page, renamed);
        await poll(
          () =>
            page
              .getByRole("button", { name: `更多操作 ${renamed}`, exact: true })
              .isVisible(),
          Boolean,
          "The history rename did not finish",
        );
        const geometry = await page
          .getByTestId("active-file-name")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return { overflow: style.overflow, ellipsis: style.textOverflow };
          });
        assert.equal(geometry.ellipsis, "ellipsis");
        assert.match(geometry.overflow, /hidden|clip/);
      },
    );

    await t.test("imports through the relocated top-left action", async () => {
      const imported = path.join(workspace, "navigation-import.json");
      const raw = '{"navigation":"imported from top left"}';
      await writeFile(imported, raw);
      await application!.evaluate(({ dialog }, filePath) => {
        Reflect.set(
          globalThis,
          "__navigationOpenDialog",
          dialog.showOpenDialog,
        );
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [filePath],
        })) as typeof dialog.showOpenDialog;
      }, imported);
      try {
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        await expectTitle(page, "navigation-import.json");
        const record = await savedRecord(page, raw);
        assert.equal(await readFile(record.managedPath!, "utf8"), raw);
      } finally {
        await application!.evaluate(({ dialog }) => {
          dialog.showOpenDialog = Reflect.get(
            globalThis,
            "__navigationOpenDialog",
          );
          Reflect.deleteProperty(globalThis, "__navigationOpenDialog");
        });
      }
    });

    await t.test(
      "preserves editor identity, selection and undo across sidebar changes",
      async () => {
        const raw = '{"value":"before"}';
        await replaceInput(page, raw);
        await savedRecord(page, raw);
        const content = page.getByTestId("input-editor").locator(".cm-content");
        const original = await content.elementHandle();
        assert.ok(original);
        await content.focus();
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await content.press("Shift+ArrowRight");
        await delay(600);
        await page.keyboard.insertText("after");
        await poll(
          () => editorText(page),
          (value) => value === '{"value":"after"}',
          "The input edit did not complete",
        );
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "after".length; index++)
          await content.press("Shift+ArrowRight");
        await setCollapsed(page, true);
        await setCollapsed(page, false);
        assert.equal(
          await original.evaluate(
            (element) =>
              element ===
              document.querySelector(
                '[data-testid="input-editor"] .cm-content',
              ),
          ),
          true,
        );
        await content.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "after",
        );
        await content.press("ControlOrMeta+z");
        await poll(
          () => editorText(page),
          (value) => value === raw,
          "Sidebar navigation discarded the existing undo history",
        );
      },
    );

    await t.test(
      "keeps scroll progress and exposes compact actions only while collapsed",
      async () => {
        const raw = JSON.stringify(
          {
            rows: Array.from({ length: 500 }, (_, id) => ({
              id,
              name: `entry-${id}`,
            })),
          },
          null,
          2,
        );
        await replaceInput(page, raw);
        await savedRecord(page, raw);
        const scroller = page
          .getByTestId("input-editor")
          .locator(".cm-scroller");
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .press("ControlOrMeta+Home");
        await poll(
          () => scroller.evaluate((element) => element.scrollTop),
          (value) => value < 50,
          "The scroll fixture did not start at the document beginning",
        );
        await scroller.hover();
        await page.mouse.wheel(0, 1_100);
        await delay(200);
        const before = await poll(
          () => scroller.evaluate((element) => element.scrollTop),
          (value) => value > 400,
          "The input did not scroll before collapsing",
        );
        await setCollapsed(page, true);
        await delay(200);
        const after = await scroller.evaluate((element) => element.scrollTop);
        assert.ok(
          Math.abs(after - before) < 55,
          `Sidebar changes lost reading progress: ${before} -> ${after}`,
        );
        assert.equal(
          await page
            .locator('.titlebar button[aria-label="新建输入"]')
            .isVisible(),
          true,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "新建输入", exact: true })
            .count(),
          1,
        );
        const filename = await page.getByTestId("active-file-name").innerText();
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "应用设置", level: 1 })
          .waitFor();
        await expectTitle(page, "应用设置");
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
        await expectTitle(page, filename.trim());
        assert.equal(
          (await scroller.evaluate((element) => element.scrollTop)) > 400,
          true,
        );
      },
    );

    await t.test(
      "restores the sidebar preference and active document after relaunch",
      async () => {
        const name = (
          await page.getByTestId("active-file-name").innerText()
        ).trim();
        await close();
        await launch();
        await expectTitle(page, name);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "展开侧栏", exact: true })
            .getAttribute("aria-expanded"),
          "false",
        );
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await poll(
          () => page.getByTestId("active-file-name").innerText(),
          (value) => /^untitled-\d+\.json$/.test(value.trim()),
          "The compact new-input action did not create an input",
        );
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
      },
    );

    await t.test(
      "fits light and dark titlebars in wide and minimum windows",
      async () => {
        for (const theme of ["dark", "light"] as const) {
          await chooseTheme(page, theme);
          for (const width of [1440, 780]) {
            await application!.evaluate(
              ({ BrowserWindow }, width) =>
                BrowserWindow.getAllWindows()[0].setContentSize(
                  width,
                  width === 780 ? 600 : 780,
                ),
              width,
            );
            await poll(
              () => page.evaluate(() => innerWidth),
              (value) => value === width,
              "The native window did not resize",
            );
            for (const collapsed of [false, true]) {
              await setCollapsed(page, collapsed);
              const boxes = await page.evaluate(() => {
                const titlebar = document.querySelector(".titlebar")!;
                const elements = Array.from(
                  titlebar.querySelectorAll<HTMLElement>(
                    "button, [data-testid=active-file-name]",
                  ),
                );
                return elements
                  .filter(
                    (element) => element.getBoundingClientRect().width > 0,
                  )
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                      name:
                        element.getAttribute("aria-label") ||
                        element.textContent?.trim(),
                      left: rect.left,
                      right: rect.right,
                      top: rect.top,
                      bottom: rect.bottom,
                    };
                  });
              });
              for (const box of boxes) {
                assert.ok(
                  box.left >= 0 && box.right <= width + 1,
                  `Titlebar element overflowed: ${JSON.stringify(box)}`,
                );
                if (process.platform === "darwin")
                  assert.ok(
                    box.left >= 88,
                    `Titlebar element overlaps native traffic lights: ${JSON.stringify(box)}`,
                  );
              }
              const sorted = [...boxes].sort((a, b) => a.left - b.left);
              for (let index = 1; index < sorted.length; index++)
                assert.ok(
                  sorted[index].left >= sorted[index - 1].right - 1,
                  "Titlebar controls overlap",
                );
              await page.screenshot({
                path: path.join(
                  artifacts,
                  `navigation-${theme}-${width}-${collapsed ? "collapsed" : "expanded"}.png`,
                ),
              });
            }
          }
        }
        const windowsLayout = await page.evaluate(() => {
          const app = document.querySelector(".application")!;
          const previous = app.className;
          try {
            app.classList.remove("platform-darwin", "platform-linux");
            app.classList.add("platform-win32");
            return {
              reservedControls: getComputedStyle(
                document.querySelector(".native-controls-space")!,
              ).display,
              toggleLeft: document
                .querySelector(".titlebar-navigation button")!
                .getBoundingClientRect().left,
            };
          } finally {
            app.className = previous;
          }
        });
        assert.equal(windowsLayout.reservedControls, "none");
        assert.ok(windowsLayout.toggleLeft < 60);
      },
    );

    await t.test(
      "expands navigation out of focused editors without losing the active document",
      async () => {
        await setCollapsed(page, false);
        const name = (
          await page.getByTestId("active-file-name").innerText()
        ).trim();
        await page
          .getByRole("button", { name: "独占查看原始输入", exact: true })
          .click();
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        const expand = page.getByRole("button", {
          name: "展开侧栏",
          exact: true,
        });
        await expand.waitFor();
        await expand.click();
        await poll(
          () => page.locator(".application").getAttribute("data-focused-pane"),
          (value) => value === null,
          "Expanding navigation did not leave the focused editor",
        );
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          true,
        );
        await expectTitle(page, name);
      },
    );

    await t.test(
      "keeps a mixed-width escaped long JSON line visible through sidebar changes",
      async () => {
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 780),
        );
        await setCollapsed(page, false);
        const raw = JSON.stringify(
          {
            headers: Array.from({ length: 78 }, (_, id) => ({
              name: `synthetic-option-${id}`,
              enabled: true,
            })),
            variables: {
              context_json: JSON.stringify({
                fields: Array.from({ length: 220 }, (_, id) => ({
                  id,
                  marker: `__NAVIGATION_ROW_${id}__`,
                  label: "教育经历·专业名称·测试字段",
                  description:
                    '类型：字符串；示例："机械工程"；支持深层转义。'.repeat(3),
                  operations: ["exact", "in", "exists"],
                  allow_empty_string: false,
                })),
              }),
            },
          },
          null,
          2,
        );
        assert.ok(
          Math.max(...raw.split("\n").map((line) => line.length)) > 50_000,
        );
        await replaceInput(page, raw);
        await savedRecord(page, raw);
        const content = page.getByTestId("input-editor").locator(".cm-content");
        for (let round = 0; round < 4; round++) {
          await content.focus();
          await content.press("ControlOrMeta+f");
          const search = page
            .getByTestId("input-editor")
            .locator('.cm-search input[name="search"]');
          await search.fill(`__NAVIGATION_ROW_${80 + round * 25}__`);
          await search.press("Enter");
          await search.press("Escape");
          await page
            .getByTestId("input-editor")
            .locator(".cm-search")
            .waitFor({ state: "hidden" });
          await filledViewport(page);
          await setCollapsed(page, true);
          await filledViewport(page);
          await setCollapsed(page, false);
          await filledViewport(page);
        }
        await content.focus();
        await content.press("ControlOrMeta+a");
        const copied = await content.evaluate((element) => {
          const clipboardData = new DataTransfer();
          element.dispatchEvent(
            new ClipboardEvent("copy", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
          return clipboardData.getData("text/plain");
        });
        assert.ok(copied === raw, "Sidebar navigation changed the input text");
        await content.press("ArrowLeft");
      },
    );

    await t.test("finishes without renderer errors", () =>
      assert.deepEqual(errors, []),
    );
  },
);
