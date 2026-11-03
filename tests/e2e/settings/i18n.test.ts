import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

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
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: /^(应用设置|Settings)$/ }).click();
  await page.locator(".workspace-settings h1").waitFor();
}

async function chooseLanguage(page: Page, language: "en" | "zh-CN") {
  await page
    .locator(".workspace-settings-theme [role=combobox]")
    .nth(1)
    .click();
  await page
    .getByRole("option", {
      name: language === "en" ? "English" : "简体中文",
      exact: true,
    })
    .click();
  await poll(
    () => page.locator("html").getAttribute("lang"),
    (value) => value === language,
    "The interface language did not change immediately",
  );
  await poll(
    () =>
      page.evaluate(
        async () => (await window.desktop!.workspace.load()).settings.language,
      ),
    (value) => value === language,
    "The interface language preference was not saved",
  );
}

async function menuLabels(application: ElectronApplication) {
  return application.evaluate(({ Menu }) => {
    const labels: string[] = [];
    const menus = [Menu.getApplicationMenu()!];
    while (menus.length) {
      const menu = menus.pop()!;
      for (const item of menu.items) {
        labels.push(item.label);
        if (item.submenu) menus.push(item.submenu);
      }
    }
    return labels;
  });
}

test(
  "Electron language preferences update every surface without changing user JSON",
  {
    timeout: 150_000,
  },
  async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "json-craft-i18n-"));
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const raw = JSON.stringify(
      {
        中文标题: "原始值",
        rows: Array.from({ length: 420 }, (_, index) => ({
          id: index,
          label: `测试编号-${index}`,
          value: "用户内容需要保持原样",
        })),
      },
      null,
      2,
    );
    const record: HistoryRecord = {
      id: "language-fixture",
      name: "中文文件-用户原文.json",
      raw,
      source: "sample",
      options: { indent: "2", autoUnescape: true, repair: true },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    config.settings.language = "system";
    config.settings.theme = "light";
    config.initialized = true;
    config.activeId = record.id;
    await writeFile(
      path.join(config.settings.historyDirectory, `history-${record.id}.json`),
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
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("crash", () => errors.push("Renderer crashed"));
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 780);
        window.show();
        window.focus();
      });
      await page.getByTestId("input-editor").locator(".cm-content").waitFor();
      await poll(
        () => page.getByTestId("active-file-name").innerText(),
        (value) => value.trim() === record.name,
        "The Chinese fixture did not load",
      );
    };
    t.after(async () => {
      try {
        await application?.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    await launch();

    await t.test(
      "defaults to the actual operating system language and native menus",
      async () => {
        const preferred = await application!.evaluate(
          ({ app }) => app.getPreferredSystemLanguages()[0] || app.getLocale(),
        );
        const expected = /^zh(?:[-_]|$)/i.test(preferred) ? "zh-CN" : "en";
        await poll(
          () => page.locator("html").getAttribute("lang"),
          (value) => value === expected,
          "The default language did not follow the native system preference",
        );
        assert.equal(
          await page.evaluate(() => window.desktop!.systemLocale),
          expected,
        );
        const labels = await menuLabels(application!);
        assert.ok(labels.includes(expected === "en" ? "File" : "文件"));
        assert.ok(labels.includes(expected === "en" ? "Edit" : "编辑"));
        const settings = await page.evaluate(
          async () => (await window.desktop!.workspace.load()).settings,
        );
        assert.equal(settings.language, "system");
      },
    );

    await t.test(
      "updates open editor controls while preserving selection, scroll, search and undo",
      async () => {
        const content = page.getByTestId("input-editor").locator(".cm-content");
        const originalEditor = await content.elementHandle();
        assert.ok(originalEditor);
        await content.focus();
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("原始值"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "原始值".length; index++)
          await content.press("Shift+ArrowRight");
        await delay(600);
        await page.keyboard.insertText("修改值");
        await content.press("ControlOrMeta+f");
        const panel = page.getByTestId("input-editor").locator(".cm-search");
        await panel.locator('input[name="search"]').fill("测试编号-320");
        await panel.locator('input[name="search"]').press("Enter");
        await panel.locator('button[name="toggleReplace"]').click();
        await panel.locator('input[name="replace"]').fill("替换文本不应丢失");
        await panel.locator('input[name="case"]').check();
        const originalPanel = await panel.elementHandle();
        assert.ok(originalPanel);
        const scroller = page
          .getByTestId("input-editor")
          .locator(".cm-scroller");
        const before = await poll(
          () => scroller.evaluate((element) => element.scrollTop),
          (value) => value > 1_000,
          "The editor did not scroll to the selected match",
        );
        await openSettings(page);
        await chooseLanguage(page, "en");
        assert.equal(
          await page.locator(".workspace-settings h1").innerText(),
          "Settings",
        );
        assert.ok((await menuLabels(application!)).includes("File"));
        await page.locator(".workspace-settings-back").click();
        assert.equal(
          await originalEditor.evaluate(
            (element) =>
              element ===
              document.querySelector(
                '[data-testid="input-editor"] .cm-content',
              ),
          ),
          true,
        );
        assert.equal(
          await originalPanel.evaluate(
            (element) =>
              element ===
              document.querySelector('[data-testid="input-editor"] .cm-search'),
          ),
          true,
        );
        assert.equal(
          await panel.locator('input[name="search"]').inputValue(),
          "测试编号-320",
        );
        assert.equal(
          await panel.locator('input[name="replace"]').inputValue(),
          "替换文本不应丢失",
        );
        assert.equal(
          await panel.locator('input[name="case"]').isChecked(),
          true,
        );
        assert.equal(
          await panel
            .locator('button[name="toggleReplace"]')
            .getAttribute("aria-expanded"),
          "true",
        );
        assert.equal(
          await panel
            .locator('button[name="toggleReplace"]')
            .getAttribute("aria-label"),
          "Collapse replace",
        );
        assert.equal(
          await panel.locator('button[name="next"]').innerText(),
          "Next",
        );
        assert.equal(
          await panel
            .locator('input[name="search"]')
            .getAttribute("aria-label"),
          "Find",
        );
        const after = await scroller.evaluate((element) => element.scrollTop);
        assert.ok(
          Math.abs(after - before) < 55,
          `Language change lost scroll: ${before} -> ${after}`,
        );
        await content.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "测试编号-320",
        );
        assert.equal(
          await page.getByTestId("active-file-name").innerText(),
          record.name,
        );
        const saved = await poll(
          () =>
            page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              record.id,
            ),
          (value) => value.raw === raw.replace("原始值", "修改值"),
          "Switching language modified or lost the user's JSON",
        );
        assert.equal(saved.name, record.name);
        await panel.locator('button[name="close"]').click();
        await content.focus();
        await content.press("ControlOrMeta+z");
        await poll(
          () =>
            page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              record.id,
            ),
          (value) => value.raw === raw,
          "Language change discarded the existing undo history",
        );
      },
    );

    await t.test(
      "keeps English settings and native folder pickers usable at minimum width",
      async () => {
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await openSettings(page);
        const layout = await page
          .locator(".workspace-settings")
          .evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            controls: Array.from(
              element.querySelectorAll<HTMLElement>("input, button"),
            ).map((control) => {
              const rect = control.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width };
            }),
          }));
        assert.ok(layout.scrollWidth <= layout.clientWidth + 1);
        for (const control of layout.controls) {
          assert.ok(
            control.left >= 0 && control.right <= 781,
            JSON.stringify(control),
          );
          assert.ok(control.width >= 28, JSON.stringify(control));
        }
        await application!.evaluate(({ dialog }) => {
          Reflect.set(
            globalThis,
            "__i18nDialogOriginal",
            dialog.showOpenDialog,
          );
          dialog.showOpenDialog = (async (...args: unknown[]) => {
            Reflect.set(
              globalThis,
              "__i18nDialogOptions",
              args[args.length - 1],
            );
            return { canceled: true, filePaths: [] };
          }) as typeof dialog.showOpenDialog;
        });
        try {
          await page
            .getByRole("button", { name: "Choose import folder", exact: true })
            .click();
          const options = await poll(
            () =>
              application!.evaluate(
                () =>
                  Reflect.get(globalThis, "__i18nDialogOptions") as
                    { title: string } | undefined,
              ),
            Boolean,
            "The native folder picker was not opened",
          );
          assert.ok(options);
          assert.equal(options.title, "Choose default import folder");
        } finally {
          await application!.evaluate(({ dialog }) => {
            dialog.showOpenDialog = Reflect.get(
              globalThis,
              "__i18nDialogOriginal",
            );
          });
        }
        await mkdir(artifacts, { recursive: true });
        await poll(
          () => page.locator(".workspace-settings-status").innerText(),
          (value) => value === "Saved automatically",
          "The settings picker did not finish saving",
        );
        await page.screenshot({
          path: path.join(artifacts, "i18n-settings-english-780.png"),
        });
        await application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 780),
        );
        await page.screenshot({
          path: path.join(artifacts, "i18n-settings-english-1440.png"),
        });
        await chooseLanguage(page, "zh-CN");
        assert.equal(
          await page.locator(".workspace-settings h1").innerText(),
          "应用设置",
        );
        assert.ok((await menuLabels(application!)).includes("文件"));
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "深色", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The dark theme did not apply",
        );
        await poll(
          () => page.locator(".workspace-settings-status").innerText(),
          (value) => value === "已自动保存",
          "The dark theme did not finish saving",
        );
        await page.screenshot({
          path: path.join(artifacts, "i18n-settings-chinese-dark-1440.png"),
        });
        await page.locator(".workspace-settings-back").click();
        assert.equal(
          await page.getByTestId("active-file-name").innerText(),
          record.name,
        );
        await page.screenshot({
          path: path.join(artifacts, "i18n-workspace-chinese-dark-1440.png"),
        });
        await openSettings(page);
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "浅色", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "light",
          "The light theme did not apply",
        );
        await page.locator(".workspace-settings-back").click();
        await page.screenshot({
          path: path.join(artifacts, "i18n-workspace-chinese-light-1440.png"),
        });
      },
    );

    await t.test(
      "restores the selected language and original Chinese data after relaunch",
      async () => {
        await openSettings(page);
        await chooseLanguage(page, "en");
        await application!.close();
        application = undefined;
        await launch();
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        assert.ok((await menuLabels(application!)).includes("File"));
        const stored = await page.evaluate(
          (id) => window.desktop!.workspace.read(id),
          record.id,
        );
        assert.ok(stored.raw === raw, "The original Chinese JSON changed");
        assert.equal(stored.name, record.name);
        await openSettings(page);
        assert.equal(
          await page
            .locator(".workspace-settings-theme [role=combobox]")
            .nth(1)
            .innerText(),
          "English",
        );
      },
    );

    assert.deepEqual(errors, []);
  },
);
