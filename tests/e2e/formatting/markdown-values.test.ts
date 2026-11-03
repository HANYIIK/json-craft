import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const probeKey = "__jsonCraftMarkdownCopies";

async function poll<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (matches(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

async function expectFullCopy(
  application: ElectronApplication,
  page: Page,
  expected: unknown,
) {
  const serialized = JSON.stringify(expected, null, 2);
  const copy = page.getByRole("button", { name: "复制", exact: true });
  const output = await poll(
    async () => {
      if (!(await copy.isEnabled())) return null;
      await copy.click();
      return application.evaluate(
        (_electron, key) => (Reflect.get(globalThis, key) as string[]).at(-1),
        probeKey,
      );
    },
    (value) => value === serialized,
    "The complete copied JSON changed Markdown links or nested JSON values",
  );
  assert.equal(output, serialized);
  assert.deepEqual(JSON.parse(output!), expected);
}

async function expectHealthy(page: Page) {
  const status = page.getByTestId("processing-status");
  await poll(
    () => status.getAttribute("class"),
    (value) => /\bkind-ok\b/.test(value ?? ""),
    "Markdown link values produced a warning or repair state",
  );
  assert.equal(await status.getAttribute("role"), "status");
  assert.doesNotMatch(await status.innerText(), /未展开|失败|无法处理/);
  assert.equal(await page.locator(".array-decoding-warnings").count(), 0);
  assert.doesNotMatch(
    await page.locator(".history-entry-selected").innerText(),
    /未展开/,
  );
}

async function expectRawSaved(page: Page, raw: string) {
  await poll(
    () =>
      page.evaluate(async () => {
        const state = await window.desktop!.workspace.load();
        return state.activeId
          ? (await window.desktop!.workspace.read(state.activeId)).raw
          : null;
      }),
    (value) => value === raw,
    "The original Markdown-bearing JSON input was not preserved in history",
  );
}

test(
  "recursive formatting preserves Markdown links while expanding real JSON strings",
  { timeout: 90_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-markdown-values-"),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.autoCopy = false;
    delete config.settings.recursiveUnescape;
    await writeFile(configPath, JSON.stringify(config));
    const bootstrap = path.join(workspace, "capture-copy.cjs");
    await writeFile(
      bootstrap,
      `const { ipcMain } = require("electron");
const copies = [];
Reflect.set(globalThis, ${JSON.stringify(probeKey)}, copies);
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, channel === "json-craft:copy" ? async (_event, text) => { copies.push(text); } : listener);
require(${JSON.stringify(path.join(projectRoot, "electron", "main.cjs"))});
`,
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    t.after(async () => {
      try {
        await application?.close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    application = await _electron.launch({
      args: [bootstrap, `--user-data-dir=${profile}`],
      cwd: projectRoot,
      env: environment,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const recursive = page.getByRole("checkbox", {
      name: "递归去转义",
      exact: true,
    });
    await poll(
      () =>
        page.getByRole("button", { name: "新建输入", exact: true }).isEnabled(),
      Boolean,
      "The isolated workspace did not load",
    );
    const rows = Array.from({ length: 60 }, (_, index) => ({
      名称: `中文项目 ${index + 1}`,
      详情: `[查看详情](https://example.com/details/${index + 1}?view=full#信息)`,
    }));
    const options = { enabled: true, label: "真实 JSON 字段" };
    const payload = { rows, options: JSON.stringify(options) };
    const source = {
      payload: JSON.stringify(payload),
      metadata: JSON.stringify({ count: rows.length }),
      说明: "保留 Markdown 详情链接",
    };
    const expandedPayload = { rows, options };
    const expanded = {
      ...source,
      payload: expandedPayload,
      metadata: { count: rows.length },
    };

    await t.test(
      "sixty Markdown detail links remain ordinary values with recursion enabled by default",
      async () => {
        assert.equal(await recursive.isChecked(), true);
        assert.equal(
          await page
            .getByRole("checkbox", { name: "自动去转义", exact: true })
            .isChecked(),
          true,
        );
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = JSON.stringify(rows);
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectFullCopy(application!, page, rows);
        await expectHealthy(page);
        assert.equal(
          await page.getByTestId("extracted-array-summary").count(),
          0,
        );
        await expectRawSaved(page, raw);
      },
    );

    await t.test(
      "mixed JSON field strings still expand without warnings in the full document and key extraction",
      async () => {
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const raw = JSON.stringify(source);
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        await expectFullCopy(application!, page, expanded);
        await expectHealthy(page);
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await poll(
          () => page.locator(".key-current code").textContent(),
          (value) => value === "$.payload",
          "The Markdown-bearing payload extraction did not become active",
        );
        await expectFullCopy(application!, page, expandedPayload);
        await expectHealthy(page);
        await expectRawSaved(page, raw);
      },
    );

    await t.test(
      "disabling recursion restores embedded strings and keeps every Markdown link intact",
      async () => {
        await recursive.uncheck();
        await expectFullCopy(application!, page, payload);
        await expectHealthy(page);
        assert.equal(
          await page.locator(".key-current code").innerText(),
          "$.payload",
        );
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectFullCopy(application!, page, source);
        await expectHealthy(page);
        assert.equal(await recursive.isChecked(), false);
        await expectRawSaved(page, JSON.stringify(source));
      },
    );

    assert.deepEqual(errors, []);
  },
);
