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
  const deadline = Date.now() + 8_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

function recursive(page: Page) {
  return page.getByRole("checkbox", { name: "递归去转义", exact: true });
}

function query(page: Page) {
  return page.getByRole("textbox", { name: "提取 key 名称", exact: true });
}

async function expectOutput(page: Page, expected: unknown) {
  await poll(
    async () =>
      (
        await page
          .getByTestId("output-editor")
          .locator(".cm-line")
          .allTextContents()
      ).join("\n"),
    (value) => value === JSON.stringify(expected, null, 2),
    "The result did not follow the current recursion preference",
  );
}

async function expectPreference(page: Page, expected: boolean) {
  await poll(
    () =>
      page.evaluate(
        async () =>
          (await window.desktop!.workspace.load()).settings.recursiveUnescape,
      ),
    (value) => value === expected,
    "The global recursion preference was not persisted",
  );
}

test(
  "Electron remembers an independent global recursion preference without losing the current workspace",
  {
    timeout: 120_000,
  },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-recursive-preference-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    delete config.settings.recursiveUnescape;
    config.settings.theme = "light";
    const extracted = { nested: JSON.stringify([{ leaf: true }]) };
    const body = {
      title: "before",
      payload: JSON.stringify(extracted),
      note: "123",
    };
    const decoded = { ...body, payload: { nested: [{ leaf: true }] } };
    const raw = JSON.stringify(JSON.stringify(body));
    const other = {
      message: "another file",
      content: JSON.stringify([{ id: 2 }]),
    };
    const records: HistoryRecord[] = [
      {
        id: "recursive-first",
        name: "recursive-first.json",
        raw,
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "recursive-second",
        name: "recursive-second.json",
        raw: JSON.stringify(other),
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    config.initialized = true;
    config.activeId = records[0].id;
    await Promise.all(
      records.map((record) =>
        writeFile(
          path.join(
            config.settings.historyDirectory,
            `history-${record.id}.json`,
          ),
          JSON.stringify(record),
        ),
      ),
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
      await running?.close();
    };
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await recursive(page).waitFor();
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    await launch();

    await t.test(
      "defaults legacy workspaces to recursion and keeps outer decoding when recursion is off",
      async () => {
        await expectOutput(page, decoded);
        assert.equal(await recursive(page).isChecked(), true);
        await expectPreference(page, true);
        await recursive(page).uncheck();
        await expectOutput(page, body);
        await expectPreference(page, false);
        await recursive(page).check();
        await expectOutput(page, decoded);
      },
    );

    await t.test(
      "preserves the selected extraction, query draft, editor selection and undo while toggling",
      async () => {
        const content = page.getByTestId("input-editor").locator(".cm-content");
        await content.focus();
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await content.press("Shift+ArrowRight");
        await delay(600);
        await page.keyboard.insertText("after");
        const editedRaw = raw.replace("before", "after");
        await expectOutput(page, { ...decoded, title: "after" });
        await query(page).fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, decoded.payload);
        await query(page).fill("draft_next_key");
        await content.focus();
        await content.press("ControlOrMeta+Home");
        for (let index = 0; index < editedRaw.indexOf("after"); index++)
          await content.press("ArrowRight");
        for (let index = 0; index < "after".length; index++)
          await content.press("Shift+ArrowRight");
        const identity = await content.elementHandle();
        assert.ok(identity);
        for (const enabled of [false, true]) {
          await recursive(page).setChecked(enabled);
          await expectOutput(page, enabled ? decoded.payload : extracted);
          assert.equal(
            await page.locator(".key-current code").innerText(),
            "$.payload",
          );
          assert.equal(await query(page).inputValue(), "draft_next_key");
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
            "after",
          );
          assert.equal(
            (
              await page
                .getByTestId("input-editor")
                .locator(".cm-line")
                .allTextContents()
            ).join("\n"),
            editedRaw,
          );
        }
        await content.press("ControlOrMeta+z");
        await expectOutput(page, decoded);
        assert.equal(
          (
            await page
              .getByTestId("input-editor")
              .locator(".cm-line")
              .allTextContents()
          ).join("\n"),
          raw,
        );
        await query(page).fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, decoded.payload);
        await recursive(page).uncheck();
        await expectOutput(page, extracted);
      },
    );

    await t.test(
      "applies one saved preference to batch formatting, file switches and reopened history",
      async () => {
        await expectPreference(page, false);
        await page
          .getByRole("button", { name: "格式化全部文件", exact: true })
          .click();
        await poll(
          () => page.locator(".workspace-footer .feedback").textContent(),
          (value) => Boolean(value?.includes("已处理 2 个文件")),
          "Batch formatting did not finish both documents",
        );
        await expectOutput(page, extracted);
        await page
          .locator('[data-history-id="recursive-second"] .history-entry-select')
          .click();
        await expectOutput(page, other);
        assert.equal(await recursive(page).isChecked(), false);
        await close();
        await launch();
        await expectOutput(page, other);
        assert.equal(await recursive(page).isChecked(), false);
        await page
          .locator('[data-history-id="recursive-first"] .history-entry-select')
          .click();
        await expectOutput(page, extracted);
        assert.equal(
          await page.locator(".key-current code").innerText(),
          "$.payload",
        );
        assert.equal(await query(page).inputValue(), "payload");
        await recursive(page).check();
        await expectOutput(page, decoded.payload);
        await expectPreference(page, true);
        await close();
        await launch();
        await expectOutput(page, decoded.payload);
        assert.equal(await recursive(page).isChecked(), true);
        await page
          .locator('[data-history-id="recursive-second"] .history-entry-select')
          .click();
        await expectOutput(page, { ...other, content: [{ id: 2 }] });
      },
    );

    await t.test(
      "remembers disabled preferences and publishes only the final rapid-toggle result",
      async () => {
        await page
          .locator('[data-history-id="recursive-first"] .history-entry-select')
          .click();
        await expectOutput(page, decoded.payload);
        const automatic = page.getByRole("checkbox", {
          name: "自动去转义",
          exact: true,
        });
        await automatic.uncheck();
        await expectOutput(page, JSON.stringify(body));
        assert.equal(await recursive(page).isDisabled(), true);
        assert.equal(await recursive(page).isChecked(), true);
        await poll(
          () =>
            page.evaluate(
              async () =>
                (await window.desktop!.workspace.read("recursive-first"))
                  .options.autoUnescape,
            ),
          (value) => value === false,
          "The master option did not finish saving before its disabled-state screenshot",
        );
        await application!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setContentSize(780, 720);
          window.show();
          window.focus();
        });
        await page.locator("main.workspace").evaluate((element) => {
          element.scrollTop = 0;
        });
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: path.join(
            artifacts,
            "recursive-preference-chinese-780-disabled.png",
          ),
        });
        await automatic.check();
        await expectOutput(page, decoded);
        assert.equal(await recursive(page).isDisabled(), false);
        assert.equal(await recursive(page).isChecked(), true);
        await recursive(page).uncheck();
        await expectOutput(page, body);
        await automatic.uncheck();
        await expectOutput(page, JSON.stringify(body));
        assert.equal(await recursive(page).isDisabled(), true);
        assert.equal(await recursive(page).isChecked(), false);
        await automatic.check();
        await expectOutput(page, body);
        assert.equal(await recursive(page).isDisabled(), false);
        assert.equal(await recursive(page).isChecked(), false);
        await application!.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler("json-craft:copy");
          ipcMain.handle("json-craft:copy", (_event, text: unknown) => {
            Reflect.set(globalThis, "__recursivePreferenceCopied", text);
          });
        });
        for (const enabled of [true, false]) {
          await recursive(page).evaluate((element) => {
            for (let index = 0; index < 3; index++)
              (element as HTMLInputElement).click();
          });
          await expectOutput(page, enabled ? decoded : body);
          assert.equal(await recursive(page).isChecked(), enabled);
          await expectPreference(page, enabled);
          await page.getByRole("button", { name: "复制", exact: true }).click();
          await poll(
            () =>
              application!.evaluate(() =>
                Reflect.get(globalThis, "__recursivePreferenceCopied"),
              ),
            (value) =>
              value === JSON.stringify(enabled ? decoded : body, null, 2),
            "Copy used a superseded recursion result",
          );
        }
        const exported = path.join(
          profile,
          "recursion-preference.formatted.json",
        );
        await application!.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => ""),
          (value) => value === JSON.stringify(body, null, 2) + "\n",
          "Export did not use the final recursion result",
        );
        const persisted = await page.evaluate(async () =>
          window.desktop!.workspace.read("recursive-first"),
        );
        assert.equal(persisted.raw, raw);
        assert.equal(
          (
            await page
              .getByTestId("input-editor")
              .locator(".cm-line")
              .allTextContents()
          ).join("\n"),
          raw,
        );
        if (persisted.managedPath)
          assert.equal(await readFile(persisted.managedPath, "utf8"), raw);
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
        await page.getByRole("option", { name: "Dark", exact: true }).click();
        await page.locator(".workspace-settings-back").click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The screenshot theme did not apply",
        );
        await page.locator("main.workspace").evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: path.join(artifacts, "recursive-preference-english-780.png"),
        });
      },
    );
    assert.deepEqual(errors, []);
  },
);
