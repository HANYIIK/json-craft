import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";

import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

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

async function editorText(
  page: Page,
  editor: "input-editor" | "output-editor",
) {
  return (
    await page.getByTestId(editor).locator(".cm-line").allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, expected: string) {
  await poll(
    () => editorText(page, "output-editor"),
    (value) => value === expected,
    "Unexpected extraction output",
  );
}

async function prepare(page: Page, raw: string, expected: string) {
  await page
    .getByRole("textbox", { name: "提取 key 名称", exact: true })
    .fill("");
  await page.getByRole("checkbox", { name: "自动去转义", exact: true }).check();
  await page.getByRole("checkbox", { name: "尝试修复", exact: true }).check();
  await page.getByRole("combobox", { name: "JSON 缩进" }).click();
  await page.getByRole("option", { name: "2 空格", exact: true }).click();
  await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
  await expectOutput(page, expected);
}

async function search(page: Page, key: string) {
  await page
    .getByRole("textbox", { name: "提取 key 名称", exact: true })
    .fill(key);
  await page.getByRole("button", { name: "查找并提取", exact: true }).click();
}

async function expectNoSelection(page: Page) {
  await poll(
    () => page.getByRole("radio", { checked: true }).count(),
    (count) => count === 0,
    "A stale extraction candidate remains selected",
  );
  const extract = page.getByRole("button", { name: "提取选中值", exact: true });
  if (await extract.count()) assert.equal(await extract.isDisabled(), true);
}

async function prepareChoices(page: Page) {
  const raw =
    '{"a":{"payload":{"from":"a"}},"items":[{"payload":[1,2]}],"payload":"root"}';
  const expected = JSON.stringify(JSON.parse(raw), null, 2);
  await prepare(page, raw, expected);
  await search(page, "payload");
  await poll(
    () => page.getByRole("radio").count(),
    (count) => count === 3,
    "Recursive key search did not expose all three JSONPaths",
  );
  return { raw, expected };
}

test(
  "Electron key extraction preserves source and requires unambiguous choices",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-extract-"));
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
      .getByRole("textbox", { name: "提取 key 名称", exact: true })
      .waitFor();
    await page.getByTestId("repair-count").waitFor();

    await t.test(
      "extracts a sole list match and restores the full JSON without changing source",
      async () => {
        const raw = '{"meta":"preserve","payload":[{"id":1},{"id":2}]}';
        const full = JSON.stringify(JSON.parse(raw), null, 2);
        const extracted = JSON.stringify([{ id: 1 }, { id: 2 }], null, 2);
        await prepare(page, raw, full);
        await search(page, "payload");
        await expectOutput(page, extracted);
        assert.equal(await editorText(page, "input-editor"), raw);
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectOutput(page, full);
        assert.equal(await editorText(page, "input-editor"), raw);
      },
    );

    await t.test("extracts an object from a nested parent", async () => {
      const value = { name: "nested", ids: [1, 2] };
      const raw = JSON.stringify({
        envelope: { payload: value },
        untouched: true,
      });
      await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
      await search(page, "payload");
      await expectOutput(page, JSON.stringify(value, null, 2));
      assert.equal(await editorText(page, "input-editor"), raw);
    });

    await t.test(
      "decodes a compressed JSON string value through the normal formatter",
      async () => {
        const raw = JSON.stringify({
          payload: '{"list":[1,2],"ok":true}',
          context: "keep",
        });
        await prepare(
          page,
          raw,
          JSON.stringify(
            {
              payload: { list: [1, 2], ok: true },
              context: "keep",
            },
            null,
            2,
          ),
        );
        assert.equal(await editorText(page, "input-editor"), raw);
        await search(page, "payload");
        await expectOutput(
          page,
          '{\n  "list": [\n    1,\n    2\n  ],\n  "ok": true\n}',
        );
        assert.equal(await editorText(page, "input-editor"), raw);
        assert.match(
          await page.getByTestId("processing-status").innerText(),
          /去转义.*1.*层|解码.*1.*层/,
        );
      },
    );

    await t.test(
      "requires a full JSONPath choice across nested objects and arrays",
      async () => {
        const { raw, expected } = await prepareChoices(page);
        const action = page.getByRole("button", {
          name: "提取选中值",
          exact: true,
        });
        assert.equal(await action.isDisabled(), true);
        assert.equal(
          await page.getByRole("radio", { checked: true }).count(),
          0,
        );
        await expectOutput(page, expected);
        await page.getByRole("radio", { name: /\$\.a\.payload/ }).waitFor();
        await page.getByRole("radio", { name: /\$\.payload/ }).waitFor();
        await page
          .getByRole("radio", { name: /\$\.items\[0\]\.payload/ })
          .check();
        assert.equal(await action.isEnabled(), true);
        await action.click();
        await expectOutput(page, "[\n  1,\n  2\n]");
        assert.equal(await editorText(page, "input-editor"), raw);
      },
    );

    await t.test(
      "distinguishes repeated keys at the same JSONPath by occurrence",
      async () => {
        const raw = '{"payload":0,"payload":false}';
        const full = '{\n  "payload": 0,\n  "payload": false\n}';
        await prepare(page, raw, full);
        await search(page, "payload");
        await poll(
          () => page.getByRole("radio").count(),
          (count) => count === 2,
          "Repeated same-path keys were collapsed",
        );
        const action = page.getByRole("button", {
          name: "提取选中值",
          exact: true,
        });
        assert.equal(await action.isDisabled(), true);
        await page
          .getByRole("radio", {
            name: /\$\.payload.*同路径第\s*2(?:\s*\/\s*2)?\s*项/,
          })
          .check();
        await action.click();
        await expectOutput(page, "false");
        assert.equal(await editorText(page, "input-editor"), raw);
      },
    );

    await t.test(
      "retains zero, false, null and an empty string as extractable values",
      async () => {
        for (const value of [0, false, null, ""]) {
          const raw = JSON.stringify({ value, another: "source" });
          await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
          await search(page, "value");
          await expectOutput(page, JSON.stringify(value));
          assert.equal(await editorText(page, "input-editor"), raw);
        }
      },
    );

    await t.test(
      "treats a dotted key name literally instead of as a path",
      async () => {
        const raw = '{"a.b":{"selected":1},"a":{"b":{"selected":2}}}';
        await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
        await search(page, "a.b");
        await expectOutput(page, '{\n  "selected": 1\n}');
        assert.equal(await editorText(page, "input-editor"), raw);
      },
    );

    await t.test(
      "keeps the existing extracted output when no key matches",
      async () => {
        const raw = '{"payload":[1,2],"keep":"source"}';
        await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
        await search(page, "payload");
        const extracted = "[\n  1,\n  2\n]";
        await expectOutput(page, extracted);
        await search(page, "missing_key");
        await page
          .getByText(/未找到|没有找到|没有匹配|无匹配/)
          .last()
          .waitFor();
        await expectOutput(page, extracted);
        assert.equal(await editorText(page, "input-editor"), raw);
        assert.equal(await page.getByRole("radio").count(), 0);
      },
    );

    await t.test("keeps the extraction when indentation changes", async () => {
      const value = { keep: { leaf: [1, 2] } };
      const raw = JSON.stringify({ payload: value, unselected: true });
      await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
      await search(page, "payload");
      await expectOutput(page, JSON.stringify(value, null, 2));
      await page.getByRole("combobox", { name: "JSON 缩进" }).click();
      await page.getByRole("option", { name: "4 空格", exact: true }).click();
      await expectOutput(page, JSON.stringify(value, null, 4));
      await page
        .getByRole("button", { name: "返回完整 JSON", exact: true })
        .waitFor();
      assert.equal(await editorText(page, "input-editor"), raw);
    });

    await t.test(
      "invalidates a previous candidate when the original source changes",
      async () => {
        await prepareChoices(page);
        await page.getByRole("radio", { name: /\$\.a\.payload/ }).check();
        assert.equal(
          await page
            .getByRole("button", { name: "提取选中值", exact: true })
            .isEnabled(),
          true,
        );
        const replacement = '{"replacement":true}';
        await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .fill(replacement);
        await expectNoSelection(page);
        assert.equal(
          await page
            .getByRole("button", { name: "复制", exact: true })
            .isDisabled(),
          true,
        );
        await expectOutput(page, '{\n  "replacement": true\n}');
      },
    );

    await t.test(
      "invalidates a candidate when switching files and returning",
      async () => {
        await prepareChoices(page);
        await page.getByRole("radio", { name: /\$\.a\.payload/ }).check();
        await page.getByRole("button", { name: /^settings\.json，/ }).click();
        await expectNoSelection(page);
        await page.getByRole("button", { name: /^release\.json，/ }).click();
        await expectNoSelection(page);
      },
    );

    await t.test(
      "invalidates previous choices when repair or unescaping changes",
      async () => {
        for (const label of ["尝试修复", "自动去转义"]) {
          await prepareChoices(page);
          await page.getByRole("radio", { name: /\$\.a\.payload/ }).check();
          await page
            .getByRole("checkbox", { name: label, exact: true })
            .uncheck();
          await expectNoSelection(page);
          await page
            .getByRole("checkbox", { name: label, exact: true })
            .check();
        }
      },
    );

    await t.test(
      "routes copy and native export to the extracted output without touching the system clipboard",
      async () => {
        const raw = '{"payload":{"selected":true},"excluded":"full JSON"}';
        const expected = '{\n  "selected": true\n}';
        await prepare(page, raw, JSON.stringify(JSON.parse(raw), null, 2));
        await search(page, "payload");
        await expectOutput(page, expected);
        const copiedKey = `__jsonCraftExtractCopy_${process.pid}`;
        await application.evaluate(({ ipcMain }, key) => {
          ipcMain.removeHandler("json-craft:copy");
          ipcMain.handle("json-craft:copy", (_event, text: unknown) => {
            Reflect.set(globalThis, key, text);
          });
        }, copiedKey);
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await poll(
          () =>
            application.evaluate(
              (_electron, key) => Reflect.get(globalThis, key),
              copiedKey,
            ),
          (text) => text === expected,
          "Copy did not receive the extracted output",
        );
        const exported = path.join(workspace, "extracted.formatted.json");
        await application.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await poll(
          () => readFile(exported, "utf8").catch(() => ""),
          (text) => text.trimEnd() === expected,
          "Native export did not write the extracted output",
        );
        assert.equal(await editorText(page, "input-editor"), raw);
      },
    );

    await t.test(
      "finishes the extraction workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
