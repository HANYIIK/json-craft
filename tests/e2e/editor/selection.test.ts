import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Locator, type Page } from "playwright";
import sharp from "sharp";

import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshotDirectory = path.join(projectRoot, "output", "playwright");
const raw = '{"payload":"visible","answer":42}';
type Theme = "light" | "dark";

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

async function inputText(page: Page) {
  return (
    await page.getByTestId("input-editor").locator(".cm-line").allTextContents()
  ).join("\n");
}

async function returnToSplit(page: Page) {
  const close = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await close.isVisible()) await close.click();
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === null,
    "The editor did not return to the split layout",
  );
}

async function collapseSelection(page: Page, content: Locator) {
  await content.focus();
  await content.press("ControlOrMeta+Home");
  const editor = content.locator(
    "xpath=ancestor::*[contains(@class, 'cm-editor')]",
  );
  await poll(
    () => editor.locator(".cm-selectionBackground").count(),
    (count) => count === 0,
    "The previous visual selection was not cleared",
  );
  assert.equal(await page.evaluate(() => getSelection()?.toString()), "");
}

async function screenshot(page: Page, name?: string) {
  return page.screenshot({
    scale: "css",
    caret: "hide",
    animations: "disabled",
    ...(name ? { path: path.join(screenshotDirectory, `${name}.png`) } : {}),
  });
}

async function assertVisibleSelection(
  page: Page,
  editor: Locator,
  before: Buffer,
  text: string,
  name: string,
) {
  assert.equal(await page.evaluate(() => getSelection()?.toString()), text);
  const marker = editor.locator(".cm-selectionBackground").first();
  await marker.waitFor();
  const selection = await marker.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      color: getComputedStyle(element).backgroundColor,
    };
  });
  assert.ok(selection.width > 20 && selection.height > 8);
  const color = selection.color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  assert.ok(
    color && color.length === 3,
    `Invalid selection color: ${selection.color}`,
  );
  const region = {
    left: Math.ceil(selection.left) + 3,
    top: Math.ceil(selection.top) + 1,
    width: Math.min(60, Math.floor(selection.width) - 7),
    height: 2,
  };
  const after = await screenshot(page, name);
  const [previousPixels, selectedPixels] = await Promise.all([
    sharp(before).extract(region).removeAlpha().raw().toBuffer(),
    sharp(after).extract(region).removeAlpha().raw().toBuffer(),
  ]);
  let changed = 0;
  let matchesSelection = 0;
  const count = selectedPixels.length / 3;
  for (let index = 0; index < selectedPixels.length; index += 3) {
    const difference =
      Math.abs(selectedPixels[index] - previousPixels[index]) +
      Math.abs(selectedPixels[index + 1] - previousPixels[index + 1]) +
      Math.abs(selectedPixels[index + 2] - previousPixels[index + 2]);
    if (difference > 20) changed++;
    if (
      Math.abs(selectedPixels[index] - color[0]) <= 20 &&
      Math.abs(selectedPixels[index + 1] - color[1]) <= 20 &&
      Math.abs(selectedPixels[index + 2] - color[2]) <= 20
    )
      matchesSelection++;
  }
  assert.ok(
    changed / count >= 0.7,
    `Selected text has no visible background change (${name}, changed ${changed}/${count}, expected ${selection.color})`,
  );
  assert.ok(
    matchesSelection / count >= 0.7,
    `The selection layer is obscured (${name}, visible ${matchesSelection}/${count}, expected ${selection.color})`,
  );
}

async function dragValue(page: Page, content: Locator) {
  const coordinates = await content.evaluate((element, value) => {
    const from = element.textContent!.indexOf(value);
    const to = from + value.length;
    if (from < 0)
      throw new Error("The value is missing from the input editor.");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let consumed = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.textContent!.length;
      if (!started && from <= consumed + length) {
        range.setStart(node, from - consumed);
        started = true;
      }
      if (to <= consumed + length) {
        range.setEnd(node, to - consumed);
        break;
      }
      consumed += length;
    }
    const bounds = range.getBoundingClientRect();
    return {
      start: bounds.left + 0.5,
      end: bounds.right - 0.5,
      y: bounds.top + bounds.height / 2,
    };
  }, "visible");
  await page.mouse.move(coordinates.start, coordinates.y);
  await page.mouse.down();
  await page.mouse.move(coordinates.end, coordinates.y, { steps: 12 });
  await page.mouse.up();
}

test(
  "Electron selection visibility survives themes and editor focus",
  { timeout: 90_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-selection-"),
    );
    await mkdir(screenshotDirectory, { recursive: true });
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
      .getByTestId("input-editor")
      .locator('.cm-content[contenteditable="true"]')
      .waitFor();
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });

    for (const theme of ["light", "dark"] as const) {
      for (const focused of [false, true]) {
        const layout = focused ? "focused" : "split";
        await t.test(
          `${theme} ${layout} shows keyboard and mouse selections without changing source`,
          async () => {
            await returnToSplit(page);
            await page.emulateMedia({ colorScheme: theme as Theme });
            await poll(
              () => page.locator("html").getAttribute("data-theme"),
              (value) => value === theme,
              "The requested editor theme did not apply",
            );
            const input = page
              .getByTestId("input-editor")
              .locator(".cm-content");
            await input.focus();
            await input.press("ControlOrMeta+a");
            await page.keyboard.insertText(raw);
            await poll(
              () => inputText(page),
              (value) => value === raw,
              "The short source document was not inserted exactly",
            );
            await poll(
              () =>
                page
                  .getByTestId("output-editor")
                  .locator(".cm-line")
                  .allTextContents(),
              (lines) =>
                lines.join("\n") === JSON.stringify(JSON.parse(raw), null, 2),
              "Formatting did not settle before measuring mouse coordinates",
            );
            if (focused) {
              await page
                .getByRole("button", { name: "独占查看原始输入", exact: true })
                .click();
              await poll(
                () =>
                  page
                    .locator(".application")
                    .getAttribute("data-focused-pane"),
                (value) => value === "input",
                "The input did not enter focus mode",
              );
            }
            const editor = page.getByTestId("input-editor");
            await collapseSelection(page, input);
            for (let index = 0; index < raw.indexOf("payload"); index++)
              await input.press("ArrowRight");
            const beforeKey = await screenshot(page);
            for (let index = 0; index < "payload".length; index++)
              await input.press("Shift+ArrowRight");
            await assertVisibleSelection(
              page,
              editor,
              beforeKey,
              "payload",
              `selection-${theme}-${layout}-key`,
            );
            await collapseSelection(page, input);
            const beforeValue = await screenshot(page);
            await dragValue(page, input);
            await assertVisibleSelection(
              page,
              editor,
              beforeValue,
              "visible",
              `selection-${theme}-${layout}-value`,
            );
            assert.equal(await inputText(page), raw);
            await delay(600);
            await page.keyboard.insertText("edited");
            await poll(
              () => inputText(page),
              (value) => value === raw.replace("visible", "edited"),
              "The visibly selected value was not editable",
            );
            await input.press("ControlOrMeta+z");
            await poll(
              () => inputText(page),
              (value) => value === raw,
              "Undo did not restore the original selected source",
            );
          },
        );
      }
    }

    await t.test(
      "keeps selection highlighting visible in the read-only output",
      async () => {
        await returnToSplit(page);
        await page.emulateMedia({ colorScheme: "light" });
        await poll(
          () =>
            page
              .getByTestId("output-editor")
              .locator(".cm-line")
              .allTextContents(),
          (lines) =>
            lines.join("\n") === JSON.stringify(JSON.parse(raw), null, 2),
          "The output did not restore the original JSON",
        );
        const editor = page.getByTestId("output-editor");
        const output = editor.locator(".cm-content");
        await collapseSelection(page, output);
        const keyOffset = JSON.stringify(JSON.parse(raw), null, 2).indexOf(
          "payload",
        );
        for (let index = 0; index < keyOffset; index++)
          await output.press("ArrowRight");
        const before = await screenshot(page);
        for (let index = 0; index < "payload".length; index++)
          await output.press("Shift+ArrowRight");
        await assertVisibleSelection(
          page,
          editor,
          before,
          "payload",
          "selection-light-readonly-key",
        );
        assert.equal(await output.getAttribute("aria-readonly"), "true");
        assert.equal(await inputText(page), raw);
      },
    );

    await t.test(
      "finishes selection workflows without uncaught renderer errors",
      () => {
        assert.deepEqual(errors, []);
      },
    );
  },
);
