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
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

async function editorText(page: Page, side: "input" | "output") {
  return (
    await page
      .getByTestId(`${side}-editor`)
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, value: unknown) {
  const expected = JSON.stringify(value, null, 2);
  await poll(
    () => editorText(page, "output"),
    (text) => text === expected,
    "The active result did not finish formatting",
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

async function search(page: Page, key: string) {
  await page
    .getByRole("textbox", { name: "提取 key 名称", exact: true })
    .fill(key);
  await page.getByRole("button", { name: "查找并提取", exact: true }).click();
}

async function expectRecords(page: Page, origins: ("source" | "extracted")[]) {
  const count = origins.length;
  assert.equal(await page.locator(".key-preparation").count(), 0);
  await poll(
    () => page.locator(".processing-records .repair-row").count(),
    (value) => value === count,
    "The unified processing records contain missing or stale repairs",
  );
  const rows = page.getByTestId("processing-records").locator(".repair-row");
  const records = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute("data-repair-id"),
      stageId: element.getAttribute("data-stage-id"),
      origin: element.getAttribute("data-origin"),
    })),
  );
  assert.deepEqual(
    records.map((record) => record.origin),
    origins,
  );
  assert.equal(new Set(records.map((record) => record.id)).size, count);
  for (const record of records) {
    assert.ok(record.id && record.stageId);
    if (await page.locator(".key-current").count()) {
      assert.ok(record.id.startsWith(`${record.origin}:`));
      assert.ok(record.stageId.startsWith(`${record.origin}:`));
    }
  }
  if (count) {
    assert.equal(await page.locator(".processing-records").count(), 1);
    assert.equal(
      await page.getByTestId("repair-count").innerText(),
      String(count),
    );
    assert.match(
      (await page.getByTestId("processing-status").getAttribute("class")) ?? "",
      /kind-repair/,
    );
    assert.equal(
      await page.locator(".processing-records").evaluate((records) => {
        const editors = document.querySelector(".editors")!;
        return Boolean(
          editors.compareDocumentPosition(records) &
            Node.DOCUMENT_POSITION_FOLLOWING &&
          records.getBoundingClientRect().top >=
            editors.getBoundingClientRect().bottom - 1,
        );
      }),
      true,
    );
    await page.getByTestId("open-repair-diff").waitFor();
  } else {
    assert.equal(await page.getByTestId("open-repair-diff").count(), 0);
  }
}

async function copyDiff(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const value = await content.evaluate((element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return data.getData("text/plain");
  });
  await content.press("ArrowLeft");
  return value;
}

async function expectDiff(
  page: Page,
  before: string,
  after: string,
  origin = "source",
) {
  await page.getByTestId("repair-diff-page").waitFor();
  await poll(
    () => copyDiff(page, "before"),
    (value) => value === before,
    "The selected repair stage points to the wrong source text",
  );
  assert.equal(await copyDiff(page, "after"), after);
  assert.equal(
    await page.getByTestId("repair-diff-page").getAttribute("data-origin"),
    origin,
  );
  if (origin === "source")
    assert.equal(await page.locator(".repair-diff-source-path").count(), 0);
  else
    assert.match(
      await page.locator(".repair-diff-source-path").innerText(),
      /\$\.payload/,
    );
  assert.equal(
    await page
      .getByTestId("repair-diff-editor")
      .getAttribute("data-active-difference"),
    "0",
  );
}

async function leaveDiff(page: Page) {
  await page.getByTestId("diff-back").click();
  await poll(
    () => page.locator(".application").getAttribute("data-page"),
    (value) => value === "workspace",
    "Returning from the unified diff did not restore the workspace",
  );
}

test(
  "Electron unifies source preparation and extracted-value repairs below the editors",
  { timeout: 120_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-extraction-repairs-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "dark";
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
    await page.getByRole("button", { name: "新建输入", exact: true }).click();

    await t.test(
      "keeps source repairs visible when the extracted value needs no repair",
      async () => {
        const raw = '{"payload":{"valid":true},"keep":"source",}';
        await replaceInput(page, raw);
        await expectOutput(page, { payload: { valid: true }, keep: "source" });
        await search(page, "payload");
        await expectOutput(page, { valid: true });
        await expectRecords(page, ["source"]);
        assert.equal(await editorText(page, "input"), raw);
        await page
          .getByTestId("processing-records")
          .locator('.repair-row[data-origin="source"]')
          .click();
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "workspace",
        );
        await poll(
          () => page.evaluate(() => getSelection()?.toString()),
          (value) => value === ",",
          "A source repair did not select its comma in the original editor",
        );
        await page.getByTestId("open-repair-diff").click();
        await expectDiff(page, raw, raw.replace(/,}$/, "}"));
        await leaveDiff(page);
      },
    );

    await t.test(
      "keeps source and value stages distinct and restores both after relaunch",
      async () => {
        const value = '{"inner":1,}';
        const raw = JSON.stringify({
          payload: value,
          other: { clean: true },
        }).replace(/}$/, ",}");
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("");
        await replaceInput(page, raw);
        await expectOutput(page, {
          payload: { inner: 1 },
          other: { clean: true },
        });
        await search(page, "payload");
        await expectOutput(page, { inner: 1 });
        await expectRecords(page, ["source", "extracted"]);
        await mkdir(artifacts, { recursive: true });
        await page.getByTestId("processing-records").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(
            artifacts,
            "extraction-repairs-unified-records-dark.png",
          ),
        });
        await page.getByTestId("open-repair-diff").click();
        await expectDiff(page, raw, raw.replace(/,}$/, "}"));
        assert.match(
          await page.locator("#diff-stage-select").innerText(),
          /源 JSON/,
        );
        await page.locator("#diff-stage-select").click();
        assert.equal(await page.getByRole("option").count(), 2);
        await page.getByRole("option").nth(1).click();
        await expectDiff(page, value, '{"inner":1}', "extracted");
        await leaveDiff(page);
        await page
          .getByTestId("processing-records")
          .locator('.repair-row[data-origin="extracted"]')
          .click();
        await expectDiff(page, value, '{"inner":1}', "extracted");
        await leaveDiff(page);
        await close();
        await launch();
        await expectOutput(page, { inner: 1 });
        await expectRecords(page, ["source", "extracted"]);
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
        assert.equal(await editorText(page, "input"), raw);
      },
    );

    await t.test(
      "shows source repairs before choosing matches and removes stale records after reset, switching and edits",
      async () => {
        const raw =
          '{"payload":{"first":1},"nested":{"payload":{"second":2}},"other":{"clean":true},}';
        const full = {
          payload: { first: 1 },
          nested: { payload: { second: 2 } },
          other: { clean: true },
        };
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("");
        await replaceInput(page, raw);
        await expectOutput(page, full);
        await search(page, "payload");
        await poll(
          () => page.getByRole("radio").count(),
          (count) => count === 2,
          "The repeated key candidates did not appear",
        );
        assert.equal(
          await page.getByRole("radio", { checked: true }).count(),
          0,
        );
        await expectRecords(page, ["source"]);
        await page.getByTestId("open-repair-diff").click();
        await expectDiff(page, raw, raw.replace(/,}$/, "}"));
        await leaveDiff(page);
        await search(page, "missing_key");
        await page
          .locator(".key-message")
          .filter({ hasText: "missing_key" })
          .waitFor();
        await expectRecords(page, ["source"]);
        assert.equal(await page.getByRole("radio").count(), 0);
        await search(page, "payload");
        await page.getByRole("radio", { name: /\$\.nested\.payload/ }).check();
        await page
          .getByRole("button", { name: "提取选中值", exact: true })
          .click();
        await expectOutput(page, { second: 2 });
        await expectRecords(page, ["source"]);
        await search(page, "other");
        await expectOutput(page, { clean: true });
        await expectRecords(page, ["source"]);
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await expectOutput(page, full);
        await expectRecords(page, ["source"]);
        const originalId = await page.evaluate(
          async () => (await window.desktop!.workspace.load()).activeId,
        );
        assert.ok(originalId);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await replaceInput(page, '{"fresh":{"ok":true}}');
        await expectOutput(page, { fresh: { ok: true } });
        await expectRecords(page, []);
        await page
          .locator(`[data-history-id="${originalId}"] .history-entry-select`)
          .click();
        await expectOutput(page, full);
        await expectRecords(page, ["source"]);
        assert.equal(await page.getByRole("radio").count(), 0);
        await replaceInput(page, '{"replacement":true}');
        await expectOutput(page, { replacement: true });
        await expectRecords(page, []);
        assert.equal(await page.locator(".key-current").count(), 0);
      },
    );
    await t.test(
      "retains source decoding notes when extracting an irreparable value fails",
      async () => {
        const raw = JSON.stringify(JSON.stringify({ payload: "{[}" }));
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("");
        await replaceInput(page, raw);
        await expectOutput(page, { payload: "{[}" });
        await search(page, "payload");
        await poll(
          () => page.getByTestId("processing-status").getAttribute("class"),
          (value) => Boolean(value?.includes("kind-error")),
          "The irreparable extracted value did not enter its error state",
        );
        const records = page.getByTestId("processing-records");
        await records.waitFor();
        await expectRecords(page, []);
        assert.match(await records.innerText(), /源 JSON 已去转义\s*1\s*层/);
        assert.equal(await records.locator(".clean-record").count(), 0);
        assert.equal(await page.getByTestId("repair-count").count(), 0);
        assert.equal(await editorText(page, "input"), raw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
