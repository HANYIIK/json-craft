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
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 400)}`);
}

async function replaceInput(page: Page, raw: string) {
  const content = page.getByTestId("input-editor").locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const handled = await content.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    return !element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, raw);
  assert.equal(handled, true);
}

async function expectOutput(page: Page, expected: string) {
  await poll(
    async () =>
      (
        await page
          .getByTestId("output-editor")
          .locator(".cm-line")
          .allTextContents()
      ).join("\n"),
    (value) => value === expected,
    "The result did not update automatically",
  );
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
    (value) => value?.raw === raw && Boolean(value.managedPath),
    "The original input was not saved as an ordinary JSON file",
  );
  assert.ok(record?.managedPath);
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (value) => value === "saved",
    "The top file status did not finish saving",
  );
  assert.ok(
    (await readFile(record.managedPath, "utf8")) === raw,
    "Auto-save changed the original JSON bytes",
  );
  return record as HistoryRecord & { managedPath: string };
}

async function chooseLanguage(page: Page, language: "zh-CN" | "en") {
  await page.getByRole("button", { name: /^(应用设置|Settings)$/ }).click();
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
    "The workspace language did not change",
  );
  await page.locator(".workspace-settings-back").click();
}

test(
  "Electron formats automatically and keeps file status above the workspace",
  {
    timeout: 120_000,
  },
  async (t) => {
    const profile = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-automatic-")),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const storage = path.join(
      profile,
      "用户文件存储-" + "nested-folder-".repeat(8),
      "project-json-".repeat(9),
      "自动保存文件",
    );
    const imports = path.join(profile, "imports");
    await Promise.all(
      [storage, imports].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    config.settings.writeDirectory = storage;
    config.settings.readDirectory = imports;
    config.settings.theme = "light";
    config.initialized = true;
    config.activeId = null;
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
    t.after(async () => {
      try {
        await application.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 780);
      window.show();
      window.focus();
    });
    await poll(
      () =>
        page.getByRole("button", { name: "新建输入", exact: true }).isEnabled(),
      Boolean,
      "The isolated workspace did not load",
    );
    await page.getByRole("button", { name: "新建输入", exact: true }).click();
    await page.getByTestId("input-editor").locator(".cm-content").waitFor();
    const raw =
      '{"id":9007199254740993,"x":1,"x":2,"text":"a\\nb","float":1e+09}';
    const formatted =
      '{\n  "id": 9007199254740993,\n  "x": 1,\n  "x": 2,\n  "text": "a\\nb",\n  "float": 1e+09\n}';

    await t.test(
      "formats input and option changes without a persistent format action",
      async () => {
        assert.equal(await page.getByTestId("format-button").count(), 0);
        assert.equal(await page.getByTestId("retry-format-button").count(), 0);
        await replaceInput(page, raw);
        await expectOutput(page, formatted);
        await savedRecord(page, raw);
        await page
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        await expectOutput(page, formatted.replace(/^  /gm, "    "));
        await poll(
          () =>
            page.evaluate(async () => {
              const state = await window.desktop!.workspace.load();
              return state.activeId
                ? window.desktop!.workspace.read(state.activeId)
                : null;
            }),
          (value) => value?.options.indent === "4",
          "The automatic formatting options were not saved",
        );
        await savedRecord(page, raw);
        assert.equal(await page.getByTestId("format-button").count(), 0);
      },
    );

    await t.test(
      "imports automatically and presents one readable top path in Chinese and English",
      async () => {
        const name = "original-json-".repeat(5) + "中文记录.json";
        const source = path.join(imports, name);
        const original = raw + "\r\n";
        await writeFile(source, original);
        await application.evaluate(({ dialog }, file) => {
          Reflect.set(
            globalThis,
            "__automaticOpenDialog",
            dialog.showOpenDialog,
          );
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [file],
          })) as typeof dialog.showOpenDialog;
        }, source);
        try {
          await page
            .getByRole("button", { name: "导入文件", exact: true })
            .click();
          await poll(
            () => page.getByTestId("active-file-name").innerText(),
            (value) => value === name,
            "The imported file did not become active",
          );
          await expectOutput(page, formatted.replace(/^  /gm, "    "));
        } finally {
          await application.evaluate(({ dialog }) => {
            dialog.showOpenDialog = Reflect.get(
              globalThis,
              "__automaticOpenDialog",
            );
          });
        }
        const imported = await savedRecord(page, original);
        assert.ok(
          (await readFile(source, "utf8")) === original,
          "Import modified the source file",
        );
        assert.equal(path.dirname(imported.managedPath), storage);
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        for (const language of ["zh-CN", "en"] as const) {
          await chooseLanguage(page, language);
          await page.locator("main.workspace").evaluate((element) => {
            element.scrollTop = 0;
          });
          assert.equal(await page.getByTestId("managed-file-path").count(), 1);
          assert.equal(await page.getByTestId("autosave-status").count(), 1);
          assert.equal(
            await page
              .locator(".workspace-footer [data-testid=managed-file-path]")
              .count(),
            0,
          );
          assert.equal(
            await page.getByTestId("managed-file-path").getAttribute("title"),
            imported.managedPath,
          );
          const layout = await page.evaluate(() => {
            const workspace =
              document.querySelector<HTMLElement>("main.workspace")!;
            const bar =
              workspace.querySelector<HTMLElement>(".workspace-filebar")!;
            const path = bar.querySelector<HTMLElement>(
              "[data-testid=managed-file-path]",
            )!;
            const toolbar = workspace
              .querySelector(".toolbar")!
              .getBoundingClientRect();
            const titlebar = document
              .querySelector(".titlebar")!
              .getBoundingClientRect();
            const bounds = bar.getBoundingClientRect();
            return {
              first: workspace.firstElementChild === bar,
              statusInside: bar.contains(
                document.querySelector("[data-testid=autosave-status]"),
              ),
              top: bounds.top,
              bottom: bounds.bottom,
              right: bounds.right,
              titlebarBottom: titlebar.bottom,
              toolbarTop: toolbar.top,
              client: bar.clientWidth,
              scroll: bar.scrollWidth,
              overflow: getComputedStyle(path).textOverflow,
              pathWidth: path.clientWidth,
              pathContentWidth: path.scrollWidth,
              pageWidth: document.documentElement.scrollWidth,
              windowWidth: innerWidth,
            };
          });
          assert.equal(layout.first, true);
          assert.equal(layout.statusInside, true);
          assert.ok(
            layout.top >= layout.titlebarBottom - 1 &&
              layout.bottom <= layout.toolbarTop + 1,
          );
          assert.ok(
            layout.right <= layout.windowWidth + 1 &&
              layout.scroll <= layout.client + 1,
          );
          assert.ok(layout.pageWidth <= layout.windowWidth + 1);
          assert.equal(layout.overflow, "ellipsis");
          assert.ok(
            layout.pathWidth > 40 && layout.pathContentWidth > layout.pathWidth,
          );
          await savedRecord(page, original);
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({
            path: path.join(
              artifacts,
              `automatic-workspace-${language}-780-light.png`,
            ),
          });
        }
      },
    );

    await t.test(
      "offers an error-only retry and keeps the native format command registered",
      async () => {
        const retryRaw = '{"retry":"automatic workspace"}';
        await page.evaluate((target) => {
          const original = Worker.prototype.postMessage;
          Reflect.set(window, "__automaticWorkerOriginal", original);
          Reflect.set(window, "__automaticWorkerProbe", {
            raw: target,
            failed: false,
            attempts: 0,
          });
          const replacement = {
            postMessage(this: Worker, ...args: unknown[]) {
              const message = args[0] as { kind?: string; raw?: string };
              const probe = Reflect.get(window, "__automaticWorkerProbe");
              if (message.kind === "format" && message.raw === probe.raw) {
                probe.attempts++;
                if (!probe.failed) {
                  probe.failed = true;
                  throw new Error("Synthetic automatic formatting failure");
                }
              }
              return Reflect.apply(original, this, args);
            },
          };
          Worker.prototype.postMessage =
            replacement.postMessage as typeof Worker.prototype.postMessage;
        }, retryRaw);
        try {
          await replaceInput(page, retryRaw);
          const retry = page.getByTestId("retry-format-button");
          await retry.waitFor();
          assert.equal(await page.getByTestId("format-button").count(), 0);
          assert.equal(
            await retry.evaluate((element) =>
              Boolean(element.closest(".workspace-filebar")),
            ),
            true,
          );
          await retry.click();
          await expectOutput(
            page,
            JSON.stringify(JSON.parse(retryRaw), null, 4),
          );
          assert.equal(await retry.count(), 0);
          await application.evaluate(({ Menu, BrowserWindow }) => {
            const menu = Menu.getApplicationMenu()!.items.find(
              (item) => item.label === "JSON",
            )!.submenu!;
            const format = menu.items.find(
              (item) => item.accelerator === "CmdOrCtrl+Enter",
            );
            if (!format)
              throw new Error("The native format shortcut is missing");
            Reflect.apply(format.click, format, [
              format,
              BrowserWindow.getAllWindows()[0],
              {},
            ]);
          });
          await poll(
            () =>
              page.evaluate(
                () => Reflect.get(window, "__automaticWorkerProbe").attempts,
              ),
            (value) => value === 3,
            "The native format menu no longer reaches the formatter",
          );
          await expectOutput(
            page,
            JSON.stringify(JSON.parse(retryRaw), null, 4),
          );
          await poll(
            () => page.getByTestId("processing-status").getAttribute("class"),
            (value) => Boolean(value?.includes("kind-ok")),
            "The native menu format operation did not finish",
          );
          await savedRecord(page, retryRaw);
        } finally {
          await page.evaluate(() => {
            Worker.prototype.postMessage = Reflect.get(
              window,
              "__automaticWorkerOriginal",
            );
          });
        }
      },
    );

    await t.test(
      "keeps the top file bar in focused editors without losing editing state",
      async () => {
        await chooseLanguage(page, "zh-CN");
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 780),
        );
        const original = JSON.stringify(
          {
            title: "before",
            rows: Array.from({ length: 360 }, (_, index) => ({
              index,
              marker: `__AUTOMATIC_TARGET_${index}__`,
            })),
          },
          null,
          2,
        );
        await replaceInput(page, original);
        await savedRecord(page, original);
        const content = page.getByTestId("input-editor").locator(".cm-content");
        const identity = await content.elementHandle();
        assert.ok(identity);
        await content.focus();
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < original.indexOf("before"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await content.press("Shift+ArrowRight");
        await delay(600);
        await page.keyboard.insertText("after");
        await savedRecord(page, original.replace("before", "after"));
        await content.press("ControlOrMeta+f");
        const search = page
          .getByTestId("input-editor")
          .locator('.cm-search input[name="search"]');
        await search.fill("__AUTOMATIC_TARGET_280__");
        await search.press("Enter");
        await search.press("Escape");
        const scroller = page
          .getByTestId("input-editor")
          .locator(".cm-scroller");
        await poll(
          () => scroller.evaluate((element) => element.scrollTop),
          (value) => value > 1_000,
          "The long input did not scroll before focus mode",
        );
        await page.locator('[data-focus-toggle="input"]').click();
        assert.equal(
          await page.locator(".workspace-filebar").isVisible(),
          true,
        );
        assert.equal(
          await page.getByTestId("managed-file-path").isVisible(),
          true,
        );
        assert.equal(await page.getByTestId("format-button").count(), 0);
        const geometry = await page.evaluate(() => ({
          barBottom: document
            .querySelector(".workspace-filebar")!
            .getBoundingClientRect().bottom,
          editorTop: document
            .querySelector('[data-pane="input"]')!
            .getBoundingClientRect().top,
        }));
        assert.ok(Math.abs(geometry.barBottom - geometry.editorTop) <= 2);
        await content.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "__AUTOMATIC_TARGET_280__",
        );
        assert.ok(
          await scroller.evaluate((element) => element.scrollTop > 1_000),
        );
        await page.locator('[data-focus-toggle="input"]').click();
        assert.equal(
          await identity.evaluate(
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
          "__AUTOMATIC_TARGET_280__",
        );
        await content.press("ControlOrMeta+z");
        await savedRecord(page, original);
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "深色", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The screenshot theme did not apply",
        );
        await page.locator(".workspace-settings-back").click();
        await page.locator("main.workspace").evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: path.join(artifacts, "automatic-workspace-zh-CN-1440-dark.png"),
        });
      },
    );

    assert.deepEqual(errors, []);
  },
);
