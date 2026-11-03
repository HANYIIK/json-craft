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
type Pane = "input" | "output";

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
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

function editor(page: Page, pane: Pane) {
  return page.getByTestId(`${pane}-editor`);
}

function placeholder(page: Page, pane: Pane, count: number) {
  return editor(page, pane).locator(
    `.cm-foldPlaceholder[data-array-items="${count}"]`,
  );
}

async function expectCount(
  page: Page,
  pane: Pane,
  count: number,
  language: "zh-CN" | "en" = "zh-CN",
) {
  const widget = placeholder(page, pane, count);
  const expected =
    language === "zh-CN"
      ? `… ${count} 项`
      : `… ${count} ${count === 1 ? "item" : "items"}`;
  await poll(
    () => widget.allTextContents(),
    (texts) => texts.length === 1 && texts[0] === expected,
    `${pane} did not display the direct array member count in ${language}`,
  );
  assert.equal(await widget.getAttribute("role"), "button");
  assert.equal(await widget.getAttribute("tabindex"), "0");
  return widget;
}

async function marker(page: Page, pane: Pane, line: number) {
  return editor(page, pane).evaluate((element, number) => {
    const row = [
      ...element.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
    ].find(
      (node) =>
        node.textContent?.trim() === String(number) &&
        getComputedStyle(node).visibility !== "hidden",
    );
    if (!row) return null;
    const bounds = row.getBoundingClientRect();
    const gutter = [
      ...element.querySelectorAll(".cm-foldGutter .cm-gutterElement"),
    ].find(
      (node) =>
        getComputedStyle(node).visibility !== "hidden" &&
        Math.abs(node.getBoundingClientRect().top - bounds.top) <= 1,
    );
    const arrow = gutter?.querySelector("span[title]");
    if (!arrow) return null;
    const rect = arrow.getBoundingClientRect();
    return {
      title: arrow.getAttribute("title"),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, line);
}

async function foldLine(page: Page, pane: Pane, line: number) {
  const arrow = await poll(
    () => marker(page, pane, line),
    (value) => /^(折叠此行|Fold line)$/.test(value?.title ?? ""),
    `${pane} line ${line} did not expose its fold control`,
  );
  assert.ok(arrow);
  await page.mouse.click(arrow.x, arrow.y);
}

async function fullText(page: Page, pane: Pane) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const text = await content.evaluate((element) => {
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
  return text;
}

async function focusPane(page: Page, pane: Pane, focused: boolean) {
  await page.locator(`[data-focus-toggle="${pane}"]`).click();
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === (focused ? pane : null),
    "The editor did not change between split and focus mode",
  );
}

test(
  "folded JSON arrays show live direct member counts in source and output",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-fold-count-"),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    await mkdir(artifacts, { recursive: true });
    const value = [
      { kind: "object", text: "commas, [brackets], {braces}" },
      ["pair-a", "pair-b"],
      ["single"],
      'escaped quote " , ] [ { }',
      null,
    ];
    const raw = `[
  ${JSON.stringify(value[0], null, 2).replaceAll("\n", "\n  ")},
  [
    "pair-a",
    "pair-b"
  ], [
    "single"
  ],
  ${JSON.stringify(value[3])},
  null
]`;
    const formatted = JSON.stringify(value, null, 2);
    const record: HistoryRecord = {
      id: "fold-count",
      name: "fold-count.json",
      raw,
      source: "sample",
      options: { indent: "2", autoUnescape: true, repair: true },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = record.id;
    config.settings.theme = "light";
    config.settings.autoCopy = false;
    await writeFile(
      path.join(config.settings.historyDirectory, `history-${record.id}.json`),
      JSON.stringify(record),
    );
    await writeFile(configPath, JSON.stringify(config));
    const bootstrap = path.join(workspace, "bootstrap.cjs");
    await writeFile(
      bootstrap,
      `const { clipboard, shell } = require("electron");
clipboard.writeText = () => { throw new Error("Clipboard disabled in fold count tests"); };
shell.trashItem = async () => { throw new Error("Trash disabled in fold count tests"); };
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
    page.on("crash", () => errors.push("Renderer crashed"));
    await page.setViewportSize({ width: 1440, height: 960 });
    await poll(
      () => page.getByTestId("processing-status").getAttribute("class"),
      (classes) => /\bkind-ok\b/.test(classes ?? ""),
      "The isolated folding fixture did not finish formatting",
    );
    await poll(
      () => fullText(page, "output"),
      (text) => text === formatted,
      "The output did not preserve the array fixture",
    );
    const pairLine = (text: string) =>
      text.split("\n").findIndex((line) => line.includes('"pair-a"'));
    const singleLine = (text: string) =>
      text.split("\n").findIndex((line) => line.includes('"single"'));

    await t.test(
      "root counts include objects, nested arrays and bracket-bearing strings once each",
      async () => {
        for (const pane of ["input", "output"] as const) {
          await foldLine(page, pane, 1);
          await (await expectCount(page, pane, 5)).click();
          assert.equal(
            await editor(page, pane).locator(".cm-foldPlaceholder").count(),
            0,
          );
          assert.equal(
            await fullText(page, pane),
            pane === "input" ? raw : formatted,
          );
          await foldLine(page, pane, 2);
          const object = editor(page, pane).locator(
            ".cm-foldPlaceholder:not([data-array-items])",
          );
          await poll(
            () => object.allTextContents(),
            (texts) => texts.length === 1 && texts[0] === "…",
            "Object folding gained an array member count",
          );
          await object.click();
          assert.equal(
            await editor(page, pane).locator(".cm-foldPlaceholder").count(),
            0,
          );
        }
      },
    );

    await t.test(
      "nested arrays count two and one members and same-line widgets unfold independently",
      async () => {
        await foldLine(page, "input", singleLine(raw));
        await expectCount(page, "input", 1);
        await foldLine(page, "input", pairLine(raw));
        await expectCount(page, "input", 2);
        assert.equal(
          await editor(page, "input")
            .locator(".cm-foldPlaceholder")
            .evaluateAll(
              (widgets) =>
                widgets.length === 2 &&
                widgets[0].closest(".cm-line") ===
                  widgets[1].closest(".cm-line"),
            ),
          true,
        );
        await placeholder(page, "input", 1).click();
        await expectCount(page, "input", 2);
        assert.equal(await placeholder(page, "input", 1).count(), 0);
        assert.match(
          await editor(page, "input").locator(".cm-content").innerText(),
          /single/,
        );
        assert.doesNotMatch(
          await editor(page, "input").locator(".cm-content").innerText(),
          /pair-a/,
        );
        await placeholder(page, "input", 2).click();
        await focusPane(page, "output", true);
        await foldLine(page, "output", singleLine(formatted));
        await expectCount(page, "output", 1);
        await foldLine(page, "output", pairLine(formatted));
        await expectCount(page, "output", 2);
        await placeholder(page, "output", 2).click();
        await expectCount(page, "output", 1);
        await placeholder(page, "output", 1).click();
        await focusPane(page, "output", false);
      },
    );

    await t.test(
      "counts and folded ranges survive focus mode and localize existing widgets",
      async () => {
        await foldLine(page, "input", singleLine(raw));
        await expectCount(page, "input", 1);
        await foldLine(page, "input", pairLine(raw));
        await expectCount(page, "input", 2);
        await foldLine(page, "output", 1);
        await expectCount(page, "output", 5);
        for (const pane of ["input", "output"] as const) {
          await focusPane(page, pane, true);
          await expectCount(page, pane, pane === "input" ? 2 : 5);
          await focusPane(page, pane, false);
          await expectCount(page, pane, pane === "input" ? 1 : 5);
        }
        await page.screenshot({
          path: path.join(artifacts, "fold-count-zh-light.png"),
        });
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "深色", exact: true }).click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .nth(1)
          .click();
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await poll(
          () => page.locator("html").getAttribute("lang"),
          (language) => language === "en",
          "The existing fold widgets did not receive the English locale",
        );
        await page.locator(".workspace-settings-back").click();
        await expectCount(page, "input", 2, "en");
        await expectCount(page, "input", 1, "en");
        await expectCount(page, "output", 5, "en");
        await page.screenshot({
          path: path.join(artifacts, "fold-count-en-dark.png"),
        });
        await placeholder(page, "input", 1).click();
        await expectCount(page, "input", 2, "en");
        const two = placeholder(page, "input", 2);
        await two.focus();
        await two.press("Space");
        assert.equal(
          await editor(page, "input").locator(".cm-foldPlaceholder").count(),
          0,
        );
        const five = placeholder(page, "output", 5);
        await five.focus();
        await five.press("Enter");
        assert.equal(
          await editor(page, "output").locator(".cm-foldPlaceholder").count(),
          0,
        );
      },
    );

    await t.test(
      "replacement inside a folded array refreshes the count and undo restores it",
      async () => {
        const content = editor(page, "input").locator(".cm-content");
        await content.focus();
        await content.press("ControlOrMeta+Home");
        await foldLine(page, "input", 1);
        await expectCount(page, "input", 5, "en");
        await content.focus();
        await content.press("ControlOrMeta+f");
        const search = editor(page, "input").locator(".cm-search");
        await search.locator('input[name="search"]').fill("null");
        await search.locator('button[name="toggleReplace"]').click();
        await search
          .locator('input[name="replace"]')
          .fill('"added member", null');
        await search.locator('button[name="replaceAll"]').click();
        await expectCount(page, "input", 6, "en");
        await search.locator('button[name="close"]').click();
        await content.focus();
        await content.press("ControlOrMeta+z");
        await (await expectCount(page, "input", 5, "en")).click();
        assert.equal(await fullText(page, "input"), raw);
        await poll(
          () => fullText(page, "output"),
          (text) => text === formatted,
          "Undo did not restore the original formatted array",
        );
        await poll(
          () =>
            page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              record.id,
            ),
          (saved) => saved.raw === raw,
          "Fold count edits changed the original persisted JSON after undo",
        );
      },
    );

    assert.deepEqual(errors, []);
  },
);
