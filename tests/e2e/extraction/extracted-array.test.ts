import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
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
    "The extracted array differs from the expected JSON",
  );
}

async function extractPayload(page: Page) {
  await page
    .getByRole("textbox", { name: "提取 key 名称", exact: true })
    .fill("payload");
  await page.getByRole("button", { name: "查找并提取", exact: true }).click();
  await poll(
    () => page.locator(".key-current code").textContent(),
    (value) => value === "$.payload",
    "The array extraction did not become active",
  );
}

test(
  "Electron recursively parses JSON strings in full documents and extracted arrays",
  {
    timeout: 90_000,
  },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-extracted-array-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "light";
    await writeFile(configPath, JSON.stringify(config));
    const object = { object: true, embedded: '{"stay":"a string"}' };
    const array = [1, { x: 2 }];
    const existingObject = { untouched: '{"insideObject":true}' };
    const members = [
      JSON.stringify(object),
      JSON.stringify(array),
      "plain text",
      "123",
      '{"repaired":true,}',
      "{[}",
      existingObject,
      null,
      4,
    ];
    const source = {
      meta: { note: "Preserve the original input" },
      payload: members,
      outside: '{"mustRemain":"a string"}',
    };
    const raw = JSON.stringify(source);
    const originalFull = JSON.stringify(source, null, 2);
    const convertedMembers = [
      { ...object, embedded: { stay: "a string" } },
      array,
      "plain text",
      "123",
      { repaired: true },
      "{[}",
      { untouched: { insideObject: true } },
      null,
      4,
    ];
    const converted = JSON.stringify(convertedMembers, null, 2);
    const full = JSON.stringify(
      {
        ...source,
        payload: convertedMembers,
        outside: { mustRemain: "a string" },
      },
      null,
      2,
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
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 900);
        window.show();
        window.focus();
      });
      await page
        .getByRole("textbox", { name: "提取 key 名称", exact: true })
        .waitFor();
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
      "decodes mixed members and leaves ordinary strings, failed members and the original input intact",
      async () => {
        await poll(
          () =>
            page
              .getByRole("button", { name: "新建输入", exact: true })
              .isEnabled(),
          Boolean,
          "The isolated workspace did not load",
        );
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectOutput(page, full);
        await extractPayload(page);
        await expectOutput(page, converted);
        assert.equal(await editorText(page, "input"), raw);
        assert.equal(
          await page.getByTestId("processing-status").getAttribute("role"),
          "status",
        );
        const summary = page.getByTestId("extracted-array-summary");
        await summary.locator(".array-decoding-warnings summary").click();
        assert.ok((await summary.innerText()).includes("$[5]"));
      },
    );

    await t.test(
      "applies automatic unescaping only after explicitly extracting the array again",
      async () => {
        const automatic = page.getByRole("checkbox", {
          name: "自动去转义",
          exact: true,
        });
        await automatic.uncheck();
        await expectOutput(page, originalFull);
        assert.equal(await page.locator(".key-current").count(), 0);
        await extractPayload(page);
        await expectOutput(page, JSON.stringify(members, null, 2));
        await automatic.check();
        await expectOutput(page, full);
        assert.equal(await page.locator(".key-current").count(), 0);
        await extractPayload(page);
        await expectOutput(page, converted);
        assert.equal(await editorText(page, "input"), raw);
      },
    );

    await t.test(
      "shows the repaired member's array path and its reviewable before and after diff",
      async () => {
        const row = page
          .locator(".repair-row")
          .filter({ hasText: "$[4]" })
          .first();
        await row.waitFor();
        await row.click();
        await page.getByTestId("repair-diff-editor").waitFor();
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "diff",
        );
        const before = (
          await page
            .getByTestId("diff-before")
            .locator(".cm-line")
            .allTextContents()
        ).join("\n");
        const after = (
          await page
            .getByTestId("diff-after")
            .locator(".cm-line")
            .allTextContents()
        ).join("\n");
        assert.ok(before.includes('"repaired"') && before.includes(",}"));
        assert.deepEqual(JSON.parse(after), { repaired: true });
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Leaving the diff page did not restore the workspace",
        );
        assert.equal(await editorText(page, "input"), raw);
        await expectOutput(page, converted);
        const warnings = page.locator(".array-decoding-warnings");
        if ((await warnings.getAttribute("open")) === null)
          await warnings.locator("summary").click();
        await mkdir(artifacts, { recursive: true });
        for (const english of [false, true]) {
          if (english) {
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
            await page
              .getByRole("option", { name: "Dark", exact: true })
              .click();
            await page.locator(".workspace-settings-back").click();
            await poll(
              () => page.locator("html").getAttribute("data-theme"),
              (value) => value === "dark",
              "The screenshot theme did not apply",
            );
          }
          const variant = english ? "english-dark" : "chinese-light";
          await page.getByTestId("extracted-array-summary").screenshot({
            path: path.join(
              artifacts,
              `extracted-array-${variant}-summary.png`,
            ),
          });
          await row.click();
          await page.getByTestId("repair-diff-editor").waitFor();
          await page.screenshot({
            path: path.join(artifacts, `extracted-array-${variant}-repair.png`),
          });
          await page.keyboard.press("Escape");
          await poll(
            () => page.locator(".application").getAttribute("data-page"),
            (value) => value === "workspace",
            "Leaving the diff screenshot did not restore the workspace",
          );
        }
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .nth(1)
          .click();
        await page
          .getByRole("option", { name: "简体中文", exact: true })
          .click();
        await page.locator(".workspace-settings-back").click();
      },
    );

    await t.test(
      "restores the extracted array and key after restart and copies or exports the current result",
      async () => {
        const saved = await poll(
          () =>
            page.evaluate(async () => {
              const state = await window.desktop!.workspace.load();
              return state.activeId
                ? window.desktop!.workspace.read(state.activeId)
                : null;
            }),
          (record) =>
            record?.raw === raw &&
            record.extraction?.key === "payload" &&
            record.extraction.path === "$.payload" &&
            record.options.autoUnescape,
          "The array extraction was not persisted",
        );
        assert.ok(saved);
        await close();
        await launch();
        await expectOutput(page, converted);
        assert.equal(
          await page
            .getByRole("textbox", { name: "提取 key 名称", exact: true })
            .inputValue(),
          "payload",
        );
        assert.equal(
          await page.locator(".key-current code").innerText(),
          "$.payload",
        );
        await application!.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler("json-craft:copy");
          ipcMain.handle("json-craft:copy", (_event, text: unknown) => {
            Reflect.set(globalThis, "__extractedArrayCopied", text);
          });
        });
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await poll(
          () =>
            application!.evaluate(() =>
              Reflect.get(globalThis, "__extractedArrayCopied"),
            ),
          (value) => value === converted,
          "Copy did not receive the current array result",
        );
        const exported = path.join(profile, "array.formatted.json");
        await application!.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => ""),
          (value) => value === converted + "\n",
          "Export did not write the current array result",
        );
        assert.equal(await editorText(page, "input"), raw);
        const persisted = await page.evaluate(
          (id) => window.desktop!.workspace.read(id),
          saved.id,
        );
        assert.equal(persisted.raw, raw);
        if (persisted.managedPath)
          assert.equal(await readFile(persisted.managedPath, "utf8"), raw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
