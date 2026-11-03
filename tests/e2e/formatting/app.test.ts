import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function outputText(page: Page) {
  return (
    await page
      .getByTestId("output-editor")
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function format(page: Page, raw: string, expected: string) {
  await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
  await poll(
    () => outputText(page),
    (value) => value === expected,
    "Unexpected formatted output",
  );
}

test(
  "production Electron app completes JSON and native file workflows",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-e2e-"));
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
    const clipboardSnapshotKey = `__jsonCraftClipboardSnapshot_${process.pid}`;
    t.after(async () => {
      try {
        await application.evaluate(async ({ clipboard }, key) => {
          if (!Reflect.has(globalThis, key)) return;
          const snapshot = Reflect.get(globalThis, key);
          if (snapshot?.length) await clipboard.write(snapshot);
          else clipboard.clear();
          Reflect.deleteProperty(globalThis, key);
        }, clipboardSnapshotKey);
      } finally {
        await application.close();
        await rm(workspace, { recursive: true, force: true });
      }
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(async ({ clipboard, ClipboardItem }, key) => {
      const items = await clipboard.read();
      const snapshot = [];
      for (const item of items) {
        const entries = await Promise.all(
          item.types.map(
            async (type) => [type, await item.getType(type)] as const,
          ),
        );
        snapshot.push(new ClipboardItem(Object.fromEntries(entries)));
      }
      Reflect.set(globalThis, key, snapshot);
    }, clipboardSnapshotKey);

    await t.test(
      "starts on the local app protocol without exposing Node APIs",
      async () => {
        await page
          .getByTestId("input-editor")
          .locator('.cm-content[contenteditable="true"]')
          .waitFor();
        assert.equal(await page.getByTestId("format-button").count(), 0);
        await poll(
          () => page.getByTestId("repair-count").innerText(),
          (text) => text.trim() === "3",
          "Missing default repair records",
        );
        assert.match(page.url(), /^app:\/\/json-craft\//);
        assert.equal(
          await page.evaluate(
            () => typeof (window as Window & { require?: unknown }).require,
          ),
          "undefined",
        );
        assert.equal(
          await page.evaluate(
            () => typeof (window as Window & { process?: unknown }).process,
          ),
          "undefined",
        );
        assert.deepEqual(
          await page.evaluate(() => Object.keys(window.desktop!).sort()),
          [
            "copyText",
            "getPathForFile",
            "importDroppedFiles",
            "onMenuAction",
            "onOpenFiles",
            "openFiles",
            "platform",
            "ready",
            "saveFile",
            "systemLocale",
            "workspace",
          ],
        );
      },
    );

    await t.test(
      "preserves large numbers, repeated keys and original string escapes",
      async () => {
        const raw =
          '{"id":9007199254740993,"x":1,"x":2,"text":"a\\nb","float":1e+09}';
        const expected =
          '{\n  "id": 9007199254740993,\n  "x": 1,\n  "x": 2,\n  "text": "a\\nb",\n  "float": 1e+09\n}';
        await format(page, raw, expected);
        assert.equal((await outputText(page)).match(/"x"/g)?.length, 2);
      },
    );

    await t.test(
      "unwraps JSON strings without altering escapes inside fields",
      async () => {
        const inner = '{"message":"hello\\nworld","active":true}';
        const expected =
          '{\n  "message": "hello\\nworld",\n  "active": true\n}';
        await format(page, JSON.stringify(inner), expected);
        assert.match(
          await page.getByTestId("processing-status").innerText(),
          /去转义.*1.*层/,
        );
        assert.equal(
          await page
            .getByTestId("input-editor")
            .locator(".cm-content")
            .innerText(),
          JSON.stringify(inner),
        );
      },
    );

    await t.test(
      "copies the result through the native clipboard bridge",
      async () => {
        const expected = '{\n  "clipboard": "native bridge"\n}';
        await format(page, '{"clipboard":"native bridge"}', expected);
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await poll(
          () => application.evaluate(({ clipboard }) => clipboard.readText()),
          (text) => text === expected,
          "Native clipboard did not receive result",
        );
      },
    );

    await t.test(
      "writes an exported JSON file through the native save dialog",
      async () => {
        const exported = path.join(workspace, "exported.formatted.json");
        const storageDirectory = await page.evaluate(
          async () =>
            (await window.desktop!.workspace.load()).settings.writeDirectory,
        );
        const expected = '{\n  "export": true\n}';
        await format(page, '{"export":true}', expected);
        await application.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath,
          })) as typeof dialog.showSaveDialog;
        }, exported);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        const content = await poll(
          () => readFile(exported, "utf8").catch(() => ""),
          (text) => text.trimEnd() === expected,
          "Exported content differs from result",
        );
        assert.equal(content.trimEnd(), expected);
        await poll(
          () => page.locator(".feedback").innerText(),
          (text) => text.includes("已导出"),
          "The native export did not finish",
        );
        assert.equal(
          await page.evaluate(
            async () =>
              (await window.desktop!.workspace.load()).settings.writeDirectory,
          ),
          storageDirectory,
          "Exporting elsewhere changed the JSON automatic storage directory",
        );
        await application.evaluate(({ dialog }) => {
          dialog.showSaveDialog = (async () => ({
            canceled: true,
            filePath: "",
          })) as typeof dialog.showSaveDialog;
        });
        const canceled = await page.evaluate(() =>
          window.desktop!.saveFile({ name: "canceled.json", content: "{}" }),
        );
        assert.equal(canceled.canceled, true);
      },
    );

    await t.test(
      "imports multiple files while isolating syntax and encoding failures",
      async () => {
        const valid = path.join(workspace, "native-valid.json");
        const invalid = path.join(workspace, "native-invalid.json");
        const invalidEncoding = path.join(workspace, "native-encoding.json");
        await Promise.all([
          writeFile(valid, '{"native":true}', "utf8"),
          writeFile(invalid, '{"bad":"\\uZZZZ"}', "utf8"),
          writeFile(invalidEncoding, Buffer.from([0xc3, 0x28])),
        ]);
        await application.evaluate(
          ({ dialog }, filePaths) => {
            dialog.showOpenDialog = (async () => ({
              canceled: false,
              filePaths,
            })) as typeof dialog.showOpenDialog;
          },
          [valid, invalid, invalidEncoding],
        );
        await page
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        await page
          .getByRole("button", { name: /^native-valid\.json，/ })
          .waitFor();
        await poll(
          () => outputText(page),
          (text) => text === '{\n  "native": true\n}',
          "First imported file was not processed",
        );
        const invalidButton = page.getByRole("button", {
          name: /^native-invalid\.json，/,
        });
        await invalidButton.click();
        await poll(
          () => page.getByTestId("processing-status").innerText(),
          (text) => /无法|失败|错误/.test(text),
          "Invalid JSON was not reported",
        );
        assert.equal(
          await page
            .getByRole("button", { name: "复制", exact: true })
            .isDisabled(),
          true,
        );
        await page
          .getByRole("button", { name: /^native-encoding\.json，/ })
          .click();
        assert.match(
          await page.getByTestId("processing-status").innerText(),
          /UTF-8|编码|读取|文件/,
        );
        await page
          .getByRole("button", { name: /^native-valid\.json，/ })
          .click();
        assert.equal(await outputText(page), '{\n  "native": true\n}');
      },
    );

    await t.test(
      "renders all workflows without uncaught browser errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
