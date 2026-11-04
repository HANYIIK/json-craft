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

async function expectOutput(page: Page, expected: unknown) {
  await poll(
    () => editorText(page, "output"),
    (value) => value === JSON.stringify(expected, null, 2),
    "Recursive formatting produced an unexpected value",
  );
}

test(
  "Electron recursively decodes structured JSON values in full documents and object extractions",
  {
    timeout: 90_000,
  },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-recursive-values-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "light";
    await writeFile(configPath, JSON.stringify(config));
    const source = {
      payload: {
        envelope: JSON.stringify({
          rows: [
            JSON.stringify({
              child: JSON.stringify([
                JSON.stringify({ leaf: true }),
                "123",
                "ordinary text",
              ]),
            }),
            "99",
          ],
          scalar: "false",
        }),
        repaired: '{"value":true,}',
        failed: "{[}",
        text: "plain text",
        numeric: "123",
      },
      outside: JSON.stringify({ hidden_only: true }),
      '{"property":"name"}': "property names stay unchanged",
    };
    const payload = {
      envelope: {
        rows: [{ child: [{ leaf: true }, "123", "ordinary text"] }, "99"],
        scalar: "false",
      },
      repaired: { value: true },
      failed: "{[}",
      text: "plain text",
      numeric: "123",
    };
    const expected = { ...source, payload, outside: { hidden_only: true } };
    const raw = JSON.stringify(source);
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
      "recursively decodes object and list values without changing property names or scalar strings",
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
        await expectOutput(page, expected);
        assert.equal(await editorText(page, "input"), raw);
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("hidden_only");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await page
          .locator(".key-message")
          .filter({ hasText: /未找到名称为 hidden_only/ })
          .waitFor();
        assert.equal(await page.locator(".key-current").count(), 0);
        await expectOutput(page, expected);
      },
    );

    await t.test(
      "returns to string values when automatic unescaping is disabled and recurses again when enabled",
      async () => {
        const automatic = page.getByRole("checkbox", {
          name: "自动去转义",
          exact: true,
        });
        await automatic.uncheck();
        await expectOutput(page, source);
        await automatic.check();
        await expectOutput(page, expected);
        assert.equal(await editorText(page, "input"), raw);
      },
    );

    await t.test(
      "uses the same rules for an extracted object with relative repair paths, restart, copy and export",
      async () => {
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, payload);
        assert.equal(
          await page.locator(".key-current code").innerText(),
          "$.payload",
        );
        const warnings = page.locator(".array-decoding-warnings");
        await warnings.locator("summary").click();
        assert.ok((await warnings.innerText()).includes("$.failed"));
        const repair = page
          .locator(".repair-row")
          .filter({ hasText: "$.repaired" })
          .first();
        await repair.click();
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "workspace",
        );
        await poll(
          () => page.evaluate(() => getSelection()?.toString()),
          (value) => value === JSON.stringify(source.payload.repaired),
          "The recursive repair did not select its original source field",
        );
        await page.getByTestId("open-repair-diff").click();
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
        assert.ok(before.includes(",}"));
        assert.deepEqual(JSON.parse(after), { value: true });
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Leaving the diff page did not restore the workspace",
        );
        await mkdir(artifacts, { recursive: true });
        await poll(
          () =>
            page.getByTestId("autosave-status").getAttribute("data-save-state"),
          (value) => value === "saved",
          "The object history did not finish saving before the screenshot",
        );
        await page.locator("main.workspace").evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: path.join(
            artifacts,
            "recursive-values-chinese-light-result.png",
          ),
        });
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
        await repair.click();
        await page.getByTestId("open-repair-diff").click();
        await page.getByTestId("repair-diff-editor").waitFor();
        await page.screenshot({
          path: path.join(
            artifacts,
            "recursive-values-english-dark-repair.png",
          ),
        });
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Leaving the diff screenshot did not restore the workspace",
        );
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
        const saved = await poll(
          () =>
            page.evaluate(async () => {
              const state = await window.desktop!.workspace.load();
              return state.activeId
                ? window.desktop!.workspace.read(state.activeId)
                : null;
            }),
          (record) =>
            record?.raw === raw && record.extraction?.key === "payload",
          "The object extraction was not persisted",
        );
        assert.ok(saved);
        await close();
        await launch();
        await expectOutput(page, payload);
        assert.equal(
          await page
            .getByRole("textbox", { name: "提取 key 名称", exact: true })
            .inputValue(),
          "payload",
        );
        await application!.evaluate(({ ipcMain }) => {
          ipcMain.removeHandler("json-craft:copy");
          ipcMain.handle("json-craft:copy", (_event, text: unknown) => {
            Reflect.set(globalThis, "__recursiveCopied", text);
          });
        });
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await poll(
          () =>
            application!.evaluate(() =>
              Reflect.get(globalThis, "__recursiveCopied"),
            ),
          (value) => value === JSON.stringify(payload, null, 2),
          "Copy did not receive the current recursive object",
        );
        const exported = path.join(profile, "recursive.formatted.json");
        await application!.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => ""),
          (value) => value === JSON.stringify(payload, null, 2) + "\n",
          "Export did not write the recursive object",
        );
        const persisted = await page.evaluate(
          (id) => window.desktop!.workspace.read(id),
          saved.id,
        );
        assert.equal(persisted.raw, raw);
        assert.equal(await editorText(page, "input"), raw);
        if (persisted.managedPath)
          assert.equal(await readFile(persisted.managedPath, "utf8"), raw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
