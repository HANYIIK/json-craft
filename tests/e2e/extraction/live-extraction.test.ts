import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

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

function query(page: Page) {
  return page.getByRole("textbox", { name: "提取 key 名称", exact: true });
}

async function editorText(page: Page, side: "input" | "output") {
  return (
    await page
      .getByTestId(`${side}-editor`)
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, value: unknown, indent = 2) {
  const expected = JSON.stringify(value, null, indent);
  await poll(
    () => editorText(page, "output"),
    (text) => text === expected,
    "Editing the source did not update the active result",
  );
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
    (record) => record?.raw === raw,
    "The original JSON did not persist unchanged",
  );
  assert.ok(record);
  return record;
}

async function expectPath(page: Page, path: string) {
  await poll(
    () => page.locator(".key-current code").innerText(),
    (value) => value === path,
    "The selected key path was not retained",
  );
}

async function expectChoices(page: Page, count: number) {
  await poll(
    () => page.getByRole("radio").count(),
    (value) => value === count,
    "Ambiguous matches did not request a path choice",
  );
  assert.equal(await page.getByRole("radio", { checked: true }).count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "提取选中值", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.locator(".key-current").count(), 0);
}

test(
  "Electron automatically extracts the current key after source edits without accepting stale searches",
  { timeout: 120_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-live-extraction-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
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
    let application: ElectronApplication | undefined;
    let page!: Page;
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
      page.on("crash", () => errors.push("Renderer crashed"));
      await application.evaluate(({ BrowserWindow, ipcMain }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 900);
        window.show();
        window.focus();
        ipcMain.removeHandler("json-craft:copy");
        ipcMain.handle("json-craft:copy", () => undefined);
      });
      await query(page).waitFor();
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    await launch();
    await page.getByRole("button", { name: "新建输入", exact: true }).click();

    await t.test(
      "uses a nonempty key immediately after editing source and keeps empty keys and per-document drafts intact",
      async () => {
        await replaceInput(page, '{"seed":true}');
        await expectOutput(page, { seed: true });
        await query(page).fill("payload");
        const first = JSON.stringify({
          payload: { version: 1 },
          untouched: "source",
        });
        await replaceInput(page, first);
        await expectOutput(page, { version: 1 });
        await expectPath(page, "$.payload");
        assert.equal(await editorText(page, "input"), first);
        const second = JSON.stringify({
          payload: '{"version":2,"list":[1,2]}',
          untouched: "updated source",
        });
        await replaceInput(page, second);
        await expectOutput(page, { version: 2, list: [1, 2] });
        await expectPath(page, "$.payload");
        assert.equal(await query(page).inputValue(), "payload");
        assert.equal(await editorText(page, "input"), second);
        await query(page).fill("");
        const full = { payload: { version: 3 }, untouched: "full document" };
        const raw = JSON.stringify(full);
        await replaceInput(page, raw);
        await expectOutput(page, full);
        assert.equal(await page.locator(".key-current").count(), 0);
        const original = await savedRecord(page, raw);
        await query(page).fill("draft_first_document");
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        assert.equal(await query(page).inputValue(), "");
        const otherRaw = '{"secondDocument":true}';
        await replaceInput(page, otherRaw);
        await expectOutput(page, { secondDocument: true });
        const other = await savedRecord(page, otherRaw);
        await query(page).fill("draft_second_document");
        await page
          .locator(`[data-history-id="${original.id}"] .history-entry-select`)
          .click();
        assert.equal(await query(page).inputValue(), "draft_first_document");
        await page
          .locator(`[data-history-id="${other.id}"] .history-entry-select`)
          .click();
        assert.equal(await query(page).inputValue(), "draft_second_document");
      },
    );

    await t.test(
      "preserves an explicitly chosen path or duplicate occurrence and requests new choices when it disappears",
      async () => {
        await query(page).fill("payload");
        const full = {
          a: { payload: { chosen: "a" } },
          b: { payload: { chosen: "b" } },
        };
        await replaceInput(page, JSON.stringify(full));
        await expectChoices(page, 2);
        await expectOutput(page, full);
        await page.getByRole("radio", { name: /\$\.b\.payload/ }).check();
        await page
          .getByRole("button", { name: "提取选中值", exact: true })
          .click();
        await expectOutput(page, { chosen: "b" });
        const updated = {
          b: { payload: { chosen: "b updated" } },
          a: { payload: { chosen: "a updated" } },
        };
        await replaceInput(page, JSON.stringify(updated));
        await expectOutput(page, { chosen: "b updated" });
        await expectPath(page, "$.b.payload");
        const replacement = {
          a: { payload: { chosen: "a new" } },
          c: { payload: { chosen: "c new" } },
        };
        await replaceInput(page, JSON.stringify(replacement));
        await expectChoices(page, 2);
        await expectOutput(page, replacement);
        const duplicates =
          '{"branch":{"payload":{"chosen":"first"},"payload":{"chosen":"second"}}}';
        await replaceInput(page, duplicates);
        await expectChoices(page, 2);
        await poll(
          () => editorText(page, "output"),
          (text) =>
            text.includes('"branch"') &&
            text.includes('"first"') &&
            text.includes('"second"'),
          "An ambiguous duplicate key retained the old extracted value",
        );
        await page
          .getByRole("radio", { name: /\$\.branch\.payload.*同路径第\s*2/ })
          .check();
        await page
          .getByRole("button", { name: "提取选中值", exact: true })
          .click();
        await expectOutput(page, { chosen: "second" });
        const changed = duplicates
          .replace('"first"', '"first changed"')
          .replace('"second"', '"second changed"');
        await replaceInput(page, changed);
        await expectOutput(page, { chosen: "second changed" });
        await expectPath(page, "$.branch.payload");
        assert.match(
          await page.locator(".key-current .key-occurrence").innerText(),
          /2\s*\/\s*2/,
        );
        assert.equal(await editorText(page, "input"), changed);
      },
    );

    await t.test(
      "shows the full new JSON on missing keys and respects an explicit reset until the next source edit",
      async () => {
        await query(page).fill("payload");
        await replaceInput(page, '{"payload":{"version":1},"keep":true}');
        await expectOutput(page, { version: 1 });
        const missing = { other: { current: true }, keep: "no matching key" };
        await replaceInput(page, JSON.stringify(missing));
        await expectOutput(page, missing);
        await page
          .locator(".key-message")
          .filter({ hasText: "payload" })
          .waitFor();
        assert.equal(await page.locator(".key-current").count(), 0);
        const full = { payload: { version: 2 }, keep: "reset" };
        await replaceInput(page, JSON.stringify(full));
        await expectOutput(page, { version: 2 });
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectOutput(page, full);
        assert.equal(await query(page).inputValue(), "payload");
        assert.equal(await page.locator(".key-current").count(), 0);
        await page
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        await poll(
          () => editorText(page, "output"),
          (value) => value === JSON.stringify(full, null, 4),
          "Changing indentation silently undid the explicit full-JSON reset",
        );
        await page
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "2 空格", exact: true }).click();
        await expectOutput(page, full);
        await replaceInput(
          page,
          '{"payload":{"version":3},"keep":"edited after reset"}',
        );
        await expectOutput(page, { version: 3 });
        await expectPath(page, "$.payload");
      },
    );

    await t.test(
      "keeps automatic lookup through indentation changes, rejects stale searches and restores the latest selection after restart",
      async () => {
        const oldRaw = JSON.stringify({
          race: "old",
          payload: { chosen: "old payload" },
          other: { chosen: "old other" },
        });
        const newRaw = JSON.stringify({
          race: "new",
          payload: { chosen: "new payload" },
          other: { chosen: "new other" },
        });
        await query(page).fill("payload");
        await page.evaluate((raw) => {
          Reflect.set(
            window,
            "__liveOriginalPostMessage",
            Worker.prototype.postMessage,
          );
          Reflect.set(window, "__livePending", {
            raw,
            requests: [],
            completed: 0,
          });
          const wrapper = {
            postMessage(this: Worker, ...args: unknown[]) {
              const request = args[0] as { kind?: string; raw?: string };
              const pending = Reflect.get(window, "__livePending");
              if (request.kind === "find-key" && request.raw === pending.raw) {
                pending.requests.push({ worker: this, args });
                return;
              }
              return Reflect.apply(
                Reflect.get(window, "__liveOriginalPostMessage"),
                this,
                args,
              );
            },
          };
          Worker.prototype.postMessage =
            wrapper.postMessage as typeof Worker.prototype.postMessage;
        }, oldRaw);
        try {
          await replaceInput(page, oldRaw);
          await poll(
            () =>
              page.evaluate(
                () => Reflect.get(window, "__livePending").requests.length,
              ),
            (value) => value > 0,
            "The edited source did not automatically search for its nonempty key",
          );
          await page
            .getByRole("combobox", { name: "JSON 缩进", exact: true })
            .click();
          await page
            .getByRole("option", { name: "4 空格", exact: true })
            .click();
          await poll(
            () =>
              page.evaluate(
                () => Reflect.get(window, "__livePending").requests.length,
              ),
            (value) => value >= 2,
            "Changing indentation canceled the pending automatic key lookup",
          );
          await query(page).fill("other");
          await poll(
            () =>
              page.evaluate(
                () => Reflect.get(window, "__livePending").requests.length,
              ),
            (value) => value >= 3,
            "Changing the query after indentation left automatic lookup stuck",
          );
          await replaceInput(page, newRaw);
          await expectOutput(page, { chosen: "new other" }, 4);
          await expectPath(page, "$.other");
          await page.evaluate(() => {
            const pending = Reflect.get(window, "__livePending");
            pending.raw = undefined;
            pending.expected = pending.requests.length;
            for (const request of pending.requests.splice(0)) {
              const listener = {
                message(event: MessageEvent<{ id: number }>) {
                  if (event.data.id === request.args[0].id) {
                    pending.completed++;
                    request.worker.removeEventListener(
                      "message",
                      listener.message,
                    );
                  }
                },
              };
              request.worker.addEventListener("message", listener.message);
              Reflect.apply(
                Reflect.get(window, "__liveOriginalPostMessage"),
                request.worker,
                request.args,
              );
            }
          });
          await poll(
            () =>
              page.evaluate(() => {
                const pending = Reflect.get(window, "__livePending");
                return {
                  completed: pending.completed,
                  expected: pending.expected,
                };
              }),
            (value) => value.expected > 0 && value.completed === value.expected,
            "The delayed real-worker response was not delivered",
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          await expectOutput(page, { chosen: "new other" }, 4);
          await expectPath(page, "$.other");
          assert.equal(await query(page).inputValue(), "other");
          assert.equal(await editorText(page, "input"), newRaw);
        } finally {
          await page.evaluate(() => {
            Worker.prototype.postMessage = Reflect.get(
              window,
              "__liveOriginalPostMessage",
            );
          });
        }
        const latest: HistoryRecord = await poll(
          () => savedRecord(page, newRaw),
          (record) =>
            record.extraction?.key === "other" &&
            record.extraction.path === "$.other",
          "The latest automatic extraction was not saved before relaunch",
        );
        assert.deepEqual(latest.extraction, {
          key: "other",
          path: "$.other",
          occurrence: 1,
        });
        await close();
        await launch();
        await expectOutput(page, { chosen: "new other" }, 4);
        await expectPath(page, "$.other");
        assert.equal(await query(page).inputValue(), "other");
        assert.equal(await editorText(page, "input"), newRaw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
