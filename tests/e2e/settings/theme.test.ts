import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { ThemePreference } from "../../../src/shared/types";

import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshots = path.join(projectRoot, "output", "playwright");
type ResolvedTheme = "light" | "dark";
const themeLabels = { system: "跟随系统", light: "浅色", dark: "深色" };

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
    "The formatted result did not match the current JSON and indentation",
  );
}

async function expectTheme(page: Page, expected: ResolvedTheme) {
  await poll(
    () => page.locator("html").getAttribute("data-theme"),
    (value) => value === expected,
    "The rendered theme did not follow the chosen preference",
  );
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
    expected,
  );
}

async function showSettings(page: Page) {
  const theme = page.getByRole("combobox", { name: "外观主题", exact: true });
  if (!(await theme.isVisible())) {
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
  }
  await theme.waitFor();
  return theme;
}

async function closeSettings(page: Page) {
  const close = page.getByRole("button", { name: "关闭应用设置", exact: true });
  if (await close.isVisible()) await close.click();
}

async function chooseTheme(
  page: Page,
  application: ElectronApplication,
  preference: ThemePreference,
  resolved: ResolvedTheme,
) {
  const theme = await showSettings(page);
  await theme.click();
  await page
    .getByRole("option", { name: themeLabels[preference], exact: true })
    .click();
  await expectTheme(page, resolved);
  await poll(
    () => page.evaluate(() => window.desktop!.workspace.load()),
    (state) => state.settings.theme === preference,
    "The theme preference was not persisted in the workspace store",
  );
  await poll(
    () => application.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    (value) => value === preference,
    "The native window theme did not receive the saved preference",
  );
}

function luminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  assert.ok(
    channels && channels.length === 3,
    `Invalid computed color: ${color}`,
  );
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function assertReadableDark(background: string, foreground: string) {
  const back = luminance(background);
  const front = luminance(foreground);
  assert.ok(back < 0.15, `A dark surface is still light: ${background}`);
  assert.ok(
    (front + 0.05) / (back + 0.05) >= 4.5,
    `Low text contrast: ${foreground} on ${background}`,
  );
}

test(
  "Electron themes and custom selects preserve the JSON workspace",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-theme-"));
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
      await page.emulateMedia({ colorScheme: "light" });
      await page.getByTestId("repair-count").waitFor();
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
    await mkdir(screenshots, { recursive: true });
    await launch();

    await t.test(
      "defaults to system and reacts to changing system color schemes",
      async () => {
        const state = await page.evaluate(() =>
          window.desktop!.workspace.load(),
        );
        assert.equal(state.settings.theme, "system");
        assert.equal(
          await application!.evaluate(
            ({ nativeTheme }) => nativeTheme.themeSource,
          ),
          "system",
        );
        await expectTheme(page, "light");
        await page.emulateMedia({ colorScheme: "dark" });
        await expectTheme(page, "dark");
        await page.emulateMedia({ colorScheme: "light" });
        await expectTheme(page, "light");
        assert.equal(
          (await page.evaluate(() => window.desktop!.workspace.load())).settings
            .theme,
          "system",
        );
      },
    );

    await t.test(
      "applies explicit themes, saves them to native settings, and restores them on restart",
      async () => {
        await chooseTheme(page, application!, "dark", "dark");
        await page.emulateMedia({ colorScheme: "light" });
        await expectTheme(page, "dark");
        await restart();
        await expectTheme(page, "dark");
        assert.equal(
          (await page.evaluate(() => window.desktop!.workspace.load())).settings
            .theme,
          "dark",
        );
        assert.equal(
          await application!.evaluate(
            ({ nativeTheme }) => nativeTheme.themeSource,
          ),
          "dark",
        );
        assert.match(await (await showSettings(page)).innerText(), /深色/);
        await chooseTheme(page, application!, "light", "light");
        await page.emulateMedia({ colorScheme: "dark" });
        await expectTheme(page, "light");
        await restart();
        await page.emulateMedia({ colorScheme: "dark" });
        await expectTheme(page, "light");
        assert.equal(
          (await page.evaluate(() => window.desktop!.workspace.load())).settings
            .theme,
          "light",
        );
        assert.equal(
          await application!.evaluate(
            ({ nativeTheme }) => nativeTheme.themeSource,
          ),
          "light",
        );
      },
    );

    await t.test(
      "restores following the system after explicitly selecting it",
      async () => {
        await chooseTheme(page, application!, "system", "dark");
        await page.emulateMedia({ colorScheme: "light" });
        await expectTheme(page, "light");
        await restart();
        await expectTheme(page, "light");
        await page.emulateMedia({ colorScheme: "dark" });
        await expectTheme(page, "dark");
        assert.equal(
          (await page.evaluate(() => window.desktop!.workspace.load())).settings
            .theme,
          "system",
        );
        assert.equal(
          await application!.evaluate(
            ({ nativeTheme }) => nativeTheme.themeSource,
          ),
          "system",
        );
        await closeSettings(page);
      },
    );

    await t.test(
      "uses keyboard-accessible custom menus and commits only accepted indentation",
      async () => {
        const raw = '{"indent":{"value":1}}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        assert.equal(await page.locator("select").count(), 0);
        const indent = page.getByRole("combobox", {
          name: "JSON 缩进",
          exact: true,
        });
        const menu = page.getByRole("listbox", {
          name: "JSON 缩进选项",
          exact: true,
        });
        await indent.focus();
        await indent.press("ArrowDown");
        await menu.waitFor();
        assert.equal(await indent.getAttribute("aria-expanded"), "true");
        const controls = await indent.getAttribute("aria-controls");
        assert.equal(await menu.getAttribute("id"), controls);
        await indent.press("End");
        const active = await indent.getAttribute("aria-activedescendant");
        assert.ok(active);
        assert.equal(await page.locator(`[id="${active}"]`).innerText(), "Tab");
        await indent.press("Enter");
        await menu.waitFor({ state: "hidden" });
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, "\t"));
        await indent.press("Space");
        await menu.waitFor();
        await indent.press("Home");
        await indent.press("ArrowDown");
        await indent.press("Enter");
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 4));
        await indent.press("Enter");
        await indent.press("Home");
        await indent.press("Escape");
        await menu.waitFor({ state: "hidden" });
        assert.match(await indent.innerText(), /4 空格/);
        assert.equal(
          await indent.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
        );
        await indent.click();
        await menu.waitFor();
        await page.getByRole("heading", { level: 1 }).click();
        await menu.waitFor({ state: "hidden" });
        assert.match(await indent.innerText(), /4 空格/);
        await indent.focus();
        await indent.press("Space");
        await menu.waitFor();
        await indent.press("Tab");
        await menu.waitFor({ state: "hidden" });
        assert.equal(
          await indent.evaluate(
            (element) => element === document.activeElement,
          ),
          false,
        );
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 4));
        await indent.click();
        await page.getByRole("option", { name: "2 空格", exact: true }).click();
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        await showSettings(page);
        assert.equal(await page.locator("select").count(), 0);
        await closeSettings(page);
      },
    );

    await t.test(
      "keeps portal menus visible inside a compact native window",
      async () => {
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () =>
            page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          (value) => value.width === 780 && value.height === 600,
          "The window did not reach the requested compact size",
        );
        const indent = page.getByRole("combobox", {
          name: "JSON 缩进",
          exact: true,
        });
        await indent.click();
        const menu = page.getByRole("listbox", {
          name: "JSON 缩进选项",
          exact: true,
        });
        await menu.waitFor();
        const geometry = await menu.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            portal: element.parentElement === document.body,
            reachable: hit !== null && element.contains(hit),
          };
        });
        assert.equal(geometry.portal, true);
        assert.equal(geometry.reachable, true);
        assert.ok(geometry.width > 0 && geometry.height > 0);
        assert.ok(
          geometry.left >= 0 &&
            geometry.top >= 0 &&
            geometry.right <= geometry.viewportWidth &&
            geometry.bottom <= geometry.viewportHeight,
          "The dropdown menu is clipped by the compact workspace",
        );
        await page.screenshot({
          path: path.join(screenshots, "theme-dark-menu.png"),
        });
        await indent.press("Escape");
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1260, 830),
        );
      },
    );

    await t.test(
      "retains raw input, extracted output, editor identity, and undo history across theme changes",
      async () => {
        const raw = '{"payload":{"answer":42},"context":"before"}';
        const changed = raw.replace("before", "after");
        const input = page.getByTestId("input-editor").locator(".cm-content");
        await input.fill(raw);
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        await input.focus();
        await input.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await input.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await input.press("Shift+ArrowRight");
        await delay(600);
        await page.keyboard.insertText("after");
        await expectOutput(page, JSON.stringify(JSON.parse(changed), null, 2));
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, '{\n  "answer": 42\n}');
        const editorNode = await input.elementHandle();
        assert.ok(editorNode);
        await chooseTheme(page, application!, "dark", "dark");
        await chooseTheme(page, application!, "light", "light");
        await closeSettings(page);
        assert.equal(await editorText(page, "input"), changed);
        await expectOutput(page, '{\n  "answer": 42\n}');
        assert.equal(
          await editorNode.evaluate(
            (element) =>
              element.isConnected &&
              element ===
                document.querySelector(
                  '[data-testid="input-editor"] .cm-content',
                ),
          ),
          true,
        );
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .waitFor();
        await input.focus();
        await input.press("ControlOrMeta+z");
        await poll(
          () => editorText(page, "input"),
          (value) => value === raw,
          "Changing themes discarded the input undo history",
        );
        await expectOutput(page, '{\n  "answer": 42\n}');
        assert.equal(
          await page
            .getByRole("textbox", { name: "提取 key 名称", exact: true })
            .inputValue(),
          "payload",
        );
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectOutput(page, JSON.stringify(JSON.parse(raw), null, 2));
        await page.screenshot({
          path: path.join(screenshots, "theme-light.png"),
        });
      },
    );

    await t.test(
      "renders dark editors and readable search panels while keeping output read-only",
      async () => {
        await chooseTheme(page, application!, "dark", "dark");
        await closeSettings(page);
        for (const pane of ["input", "output"] as const) {
          const editor = page.getByTestId(`${pane}-editor`);
          const content = editor.locator(".cm-content");
          const colors = await editor
            .locator(".cm-editor")
            .evaluate((element) => ({
              background: getComputedStyle(element).backgroundColor,
              foreground: getComputedStyle(element).color,
            }));
          assertReadableDark(colors.background, colors.foreground);
          await content.focus();
          await content.press("ControlOrMeta+f");
          const panel = editor.locator(".cm-search");
          await panel.waitFor();
          const query = panel.locator('input[name="search"]');
          await query.fill("answer");
          const panelColors = await panel.evaluate((element) => {
            const container = element.closest(".cm-panels")!;
            const field = element.querySelector('input[name="search"]')!;
            return {
              background: getComputedStyle(container).backgroundColor,
              foreground: getComputedStyle(container).color,
              inputBackground: getComputedStyle(field).backgroundColor,
              inputForeground: getComputedStyle(field).color,
            };
          });
          assertReadableDark(panelColors.background, panelColors.foreground);
          assertReadableDark(
            panelColors.inputBackground,
            panelColors.inputForeground,
          );
          if (pane === "output") {
            assert.equal(await content.getAttribute("aria-readonly"), "true");
            assert.equal(
              await content.getAttribute("contenteditable"),
              "false",
            );
            assert.equal(
              await panel
                .locator('[name="replace"], [name="replaceAll"]')
                .count(),
              0,
            );
            await page.screenshot({
              path: path.join(screenshots, "theme-dark-editor-search.png"),
            });
          } else {
            assert.equal(await content.getAttribute("aria-readonly"), "false");
            assert.equal(
              await panel.locator('input[name="replace"]').count(),
              1,
            );
          }
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
        assert.equal(await page.locator("select").count(), 0);
      },
    );

    await t.test(
      "finishes theme workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
