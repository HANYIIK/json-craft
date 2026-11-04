import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Locator, type Page } from "playwright";
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

async function editorText(page: Page, side: "input" | "output") {
  return (
    await page
      .getByTestId(`${side}-editor`)
      .locator(".cm-line")
      .allTextContents()
  ).join("\n");
}

async function expectOutput(page: Page, expected: unknown) {
  await poll(
    () => editorText(page, "output"),
    (value) => value === JSON.stringify(expected, null, 2),
    "The current input did not finish formatting",
  );
}

async function copySelection(content: Locator) {
  return content.evaluate((element) => {
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
}

async function expectSourceSelection(
  page: Page,
  row: Locator,
  raw: string,
  selected: string,
) {
  const start = raw.indexOf(selected);
  assert.ok(start >= 0);
  const prefix = raw.slice(0, start);
  const line = prefix.split("\n").length;
  const column = start - prefix.lastIndexOf("\n");
  await row.click();
  assert.equal(
    await page.locator(".application").getAttribute("data-page"),
    "workspace",
  );
  assert.equal(await page.getByTestId("repair-diff-page").count(), 0);
  const input = page.getByTestId("input-editor").locator(".cm-content");
  await poll(
    () => input.evaluate((element) => element === document.activeElement),
    Boolean,
    "The repair record did not focus the source editor",
  );
  await poll(
    () => copySelection(input),
    (value) => value === selected,
    "The repair record selected decoded coordinates instead of the original source value",
  );
  assert.equal(await row.getAttribute("data-source-line"), String(line));
  assert.equal(await row.getAttribute("data-source-column"), String(column));
  assert.equal(await row.getAttribute("data-location-exact"), "false");
  assert.equal(await editorText(page, "input"), raw);
}

async function copyDiff(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const copied = await copySelection(content);
  await content.press("ArrowLeft");
  return copied;
}

test(
  "Electron preserves bracketed text and locates nested repairs in the original source",
  { timeout: 90_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-repair-source-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "light";
    config.settings.recursiveUnescape = true;
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
    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1380, 900);
      window.show();
      window.focus();
      ipcMain.removeHandler("json-craft:copy");
      ipcMain.handle("json-craft:copy", () => undefined);
    });
    await page.getByRole("button", { name: "新建输入", exact: true }).click();

    await t.test(
      "keeps redaction markers and Extended JSON fields unchanged",
      async () => {
        const exported = {
          exported_at: "2026-01-01T00:00:00.000Z",
          source: { host: "mongo.example.test", collection: "demo-users" },
          users: [
            {
              _id: { $oid: "000000000000000000000001" },
              _created: { $date: 1700000000000 },
              email: "first@example.test",
              password: "[REDACTED]",
            },
            {
              _id: { $oid: "000000000000000000000002" },
              email: "second@example.test",
              password: "[REDACTED]",
            },
          ],
          placeholders: ["[MASKED]", "[hidden]", "[text]"],
        };
        const raw = JSON.stringify(exported, null, 2);
        await replaceInput(page, raw);
        await expectOutput(page, exported);
        assert.equal(await page.locator(".repair-row").count(), 0);
        assert.equal(await page.getByTestId("open-repair-diff").count(), 0);
        assert.equal(await editorText(page, "input"), raw);
      },
    );

    const details = '{"active":True}';
    const users = [
      { name: "First demo user", password: "[REDACTED]", details },
      { name: "Second demo user", password: "[REDACTED]" },
    ];
    await t.test(
      "clicks a nested repair to select its serialized source value",
      async () => {
        const raw = JSON.stringify(
          { heading: "Source coordinates", users },
          null,
          2,
        );
        await replaceInput(page, raw);
        await expectOutput(page, {
          heading: "Source coordinates",
          users: [{ ...users[0], details: { active: true } }, users[1]],
        });
        const row = page
          .locator(".repair-row")
          .filter({ hasText: "$.users[0].details" })
          .first();
        await row.waitFor();
        assert.equal(
          await page
            .locator(".repair-row")
            .filter({ hasText: "password" })
            .count(),
          0,
        );
        await expectSourceSelection(page, row, raw, JSON.stringify(details));
      },
    );

    await t.test(
      "opens the nested repair stage only through the explicit diff action",
      async () => {
        await page.getByTestId("open-repair-diff").click();
        await page.getByTestId("repair-diff-page").waitFor();
        await poll(
          () => copyDiff(page, "before"),
          (value) => value === details,
          "The diff page did not show the inner repair text",
        );
        assert.deepEqual(JSON.parse(await copyDiff(page, "after")), {
          active: true,
        });
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "diff",
        );
        await page.getByTestId("diff-back").click();
        await page.getByTestId("input-editor").waitFor();
      },
    );

    await t.test(
      "maps extracted-value repairs back through the selected key path",
      async () => {
        const value = { users };
        const raw = JSON.stringify(
          { label: "Before payload", payload: value, end: true },
          null,
          2,
        );
        await replaceInput(page, raw);
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("payload");
        await page
          .getByRole("button", { name: "查找并提取", exact: true })
          .click();
        await expectOutput(page, {
          users: [{ ...users[0], details: { active: true } }, users[1]],
        });
        const row = page
          .locator('.repair-row[data-origin="extracted"]')
          .filter({ hasText: "$.users[0].details" })
          .first();
        await row.waitFor();
        await expectSourceSelection(page, row, raw, JSON.stringify(details));
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "提取 key 名称", exact: true })
          .fill("");
      },
    );

    await t.test(
      "selects the outer source string when inner coordinates cannot map exactly",
      async () => {
        const value = { users: [{ password: "[REDACTED]", details }] };
        const raw = JSON.stringify(JSON.stringify(value));
        await replaceInput(page, raw);
        await expectOutput(page, {
          users: [{ password: "[REDACTED]", details: { active: true } }],
        });
        const row = page
          .locator(".repair-row")
          .filter({ hasText: "$.users[0].details" })
          .first();
        await row.waitFor();
        await expectSourceSelection(page, row, raw, raw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
