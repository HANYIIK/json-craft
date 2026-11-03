import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { json } from "@codemirror/lang-json";
import {
  foldable,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { _electron, type Page } from "playwright";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshots = path.join(projectRoot, "output", "playwright");
const tail = "__FOLDING_JSON_END__";
const longMarker = "__BRACKET_STRING_MIDDLE__";
type Pane = "input" | "output";

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
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

function editor(page: Page, pane: Pane) {
  return page.getByTestId(`${pane}-editor`);
}

async function marker(page: Page, pane: Pane, line: number) {
  return editor(page, pane)
    .locator(".cm-editor")
    .evaluate((element, number) => {
      const numbers = Array.from(
        element.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
      );
      const row = numbers.find(
        (node) =>
          node.textContent?.trim() === String(number) &&
          getComputedStyle(node).visibility !== "hidden",
      );
      if (!row) return null;
      const bounds = row.getBoundingClientRect();
      const gutter = Array.from(
        element.querySelectorAll(".cm-foldGutter .cm-gutterElement"),
      ).find(
        (node) =>
          getComputedStyle(node).visibility !== "hidden" &&
          Math.abs(node.getBoundingClientRect().top - bounds.top) <= 1,
      );
      const arrow = gutter?.querySelector("span[title]");
      if (!arrow) return { line: number, title: null, text: null, x: 0, y: 0 };
      const rect = arrow.getBoundingClientRect();
      return {
        line: number,
        title: arrow.getAttribute("title"),
        text: arrow.textContent,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, line);
}

async function expectFold(
  page: Page,
  pane: Pane,
  line: number,
  folded: boolean,
) {
  return poll(
    () => marker(page, pane, line),
    (value) => value?.title === (folded ? "展开此行" : "折叠此行"),
    `${pane} line ${line} does not expose its ${folded ? "unfold" : "fold"} arrow`,
  );
}

async function toggleFold(
  page: Page,
  pane: Pane,
  line: number,
  folded: boolean,
) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const arrow = await expectFold(page, pane, line, !folded);
  assert.ok(arrow);
  await page.mouse.click(arrow.x, arrow.y);
  await expectFold(page, pane, line, folded);
}

async function top(page: Page, pane: Pane) {
  const scroller = editor(page, pane).locator(".cm-scroller");
  await scroller.hover();
  await page.mouse.wheel(-10_000_000, -10_000_000);
  await poll(
    () => scroller.evaluate((element) => element.scrollTop),
    (value) => value <= 1,
    "The folding preview did not return to its top",
  );
}

async function returnToSplit(page: Page) {
  const back = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await back.isVisible()) {
    await back.click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === null,
    "The folding workspace did not return to split mode",
  );
}

async function focusPane(page: Page, pane: Pane) {
  await returnToSplit(page);
  await page
    .getByRole("button", {
      name: pane === "input" ? "独占查看原始输入" : "独占查看格式化结果",
      exact: true,
    })
    .click();
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === pane,
    "The folding editor did not enter focus mode",
  );
  await delay(100);
}

async function fullEditorText(page: Page, pane: Pane) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const text = await content.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  await content.press("ArrowLeft");
  return text;
}

async function search(page: Page, pane: Pane, text: string) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+f");
  const panel = editor(page, pane).locator(".cm-search");
  await panel.waitFor();
  await panel.locator('input[name="search"]').fill(text);
  await panel.locator('button[name="next"]').click();
  await poll(
    async () =>
      (await panel.locator(".cm-search-count").innerText()).replace(/\s/g, ""),
    (value) => value === "1/1",
    "Search did not select the folding fixture's unique match",
  );
  return panel;
}

function nativePartialState(raw: string) {
  const state = EditorState.create({ doc: raw, extensions: [json()] });
  const tree = syntaxTree(state);
  const line = state.doc.line(4);
  const child = state.doc.line(5);
  return {
    characters: state.doc.length,
    lines: state.doc.lines,
    treeLength: tree.length,
    fullTreeAvailable: syntaxTreeAvailable(state, state.doc.length),
    nativeArrayFold: foldable(state, line.from, line.to) ?? null,
    nativeChildFold: foldable(state, child.from, child.to) ?? null,
  };
}

test(
  "Electron folds complete large JSON parents without scrolling through the document",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-folding-"));
    const userData = path.join(workspace, "profile");
    const sourceDirectory = path.join(workspace, "source");
    await isolateWorkspace(userData);
    await Promise.all([
      mkdir(sourceDirectory),
      mkdir(screenshots, { recursive: true }),
    ]);
    const literal =
      'escaped quote " and brackets [{(text)}] with newline\n'.repeat(500);
    const value = {
      version: "1.0",
      exportTime: "2026-11-03T00:00:00.000Z",
      fieldDefinitions: Array.from({ length: 600 }, (_, index) => ({
        id: index,
        name: `synthetic-field-${index}`,
        data_type: index % 2 ? "string" : "object",
        description:
          'Brackets in strings must not close a container: [ ] { } \\"quoted\\" '.repeat(
            2,
          ),
        examples: [
          "example: [a,b]",
          'example: {"literal":true}',
          "line one\nline two",
        ],
        metadata: {
          required: index % 2 === 0,
          range: { min: index, max: index + 10 },
        },
        children:
          index % 3
            ? null
            : [
                {
                  name: `nested-${index}`,
                  enabled: true,
                  metadata: {
                    literal: "Brackets: [not a parent] {still a string}",
                  },
                },
              ],
        literal:
          index === 599 ? literal + longMarker + literal : `literal-${index}`,
      })),
      tail,
    };
    const raw = JSON.stringify(value, null, 2);
    assert.ok(raw.length >= 200_000);
    assert.ok(raw.split("\n").length >= 8000);
    assert.match(raw.split("\n")[3], /"fieldDefinitions": \[/);
    const filePath = path.join(sourceDirectory, "folding-fields.json");
    await writeFile(filePath, raw);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    const application = await _electron.launch({
      args: [projectRoot, `--user-data-dir=${userData}`, filePath],
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
    page.on("crash", () => errors.push("Renderer crashed"));
    await poll(
      () => page.getByRole("heading", { level: 1 }).innerText(),
      (text) => text.trim() === "folding-fields.json",
      "The large folding fixture was not imported",
    );
    await editor(page, "output").locator(".cm-content").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    const canonicalWorkspace = await realpath(workspace);
    const settings = (
      await page.evaluate(() => window.desktop!.workspace.load())
    ).settings;
    for (const directory of [
      settings.readDirectory,
      settings.writeDirectory,
      settings.historyDirectory,
    ])
      assert.ok(
        directory.startsWith(canonicalWorkspace + path.sep),
        "Folding test files escaped their temporary workspace",
      );

    await t.test(
      "initially exposes line 4 array and root fold arrows without visiting the document end",
      async () => {
        try {
          for (const pane of ["input", "output"] as const) {
            assert.equal(
              await editor(page, pane)
                .locator(".cm-scroller")
                .evaluate((element) => element.scrollTop),
              0,
            );
            await expectFold(page, pane, 5, false);
            await expectFold(page, pane, 4, false);
            await expectFold(page, pane, 1, false);
          }
        } catch (error) {
          console.log(
            "Native initial partial parsing",
            nativePartialState(raw),
          );
          for (const pane of ["input", "output"] as const)
            console.log(
              `${pane} initial fold gutters`,
              await Promise.all(
                [1, 4, 5].map((line) => marker(page, pane, line)),
              ),
            );
          throw error;
        } finally {
          await page.screenshot({
            path: path.join(screenshots, "folding-initial-parent-gutters.png"),
          });
        }
      },
    );

    await t.test(
      "keeps child folds when folding and reopening the large array and root",
      async () => {
        for (const pane of ["input", "output"] as const) {
          await returnToSplit(page);
          await top(page, pane);
          await toggleFold(page, pane, 5, true);
          await toggleFold(page, pane, 4, true);
          assert.equal(
            await editor(page, pane).locator(".cm-foldPlaceholder").count(),
            1,
          );
          await toggleFold(page, pane, 4, false);
          await expectFold(page, pane, 5, true);
          await toggleFold(page, pane, 1, true);
          assert.equal(
            await editor(page, pane).locator(".cm-foldPlaceholder").count(),
            1,
          );
          await toggleFold(page, pane, 1, false);
          await expectFold(page, pane, 4, false);
          await expectFold(page, pane, 5, true);
          assert.ok(
            (await fullEditorText(page, pane)) === raw,
            "Folding changed or omitted JSON content",
          );
          await toggleFold(page, pane, 5, false);
        }
      },
    );

    await t.test(
      "preserves folds through split, focus, resize, and parent navigation",
      async () => {
        for (const pane of ["input", "output"] as const) {
          await focusPane(page, pane);
          await top(page, pane);
          await toggleFold(page, pane, 5, true);
          await toggleFold(page, pane, 4, true);
          await returnToSplit(page);
          await expectFold(page, pane, 4, true);
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setContentSize(1100, 760),
          );
          await expectFold(page, pane, 4, true);
          await focusPane(page, pane);
          await expectFold(page, pane, 4, true);
          const nav = editor(page, pane).getByRole("navigation", {
            name: `${pane === "input" ? "输入 JSON" : "格式化 JSON 结果"} 父级路径`,
            exact: true,
          });
          await nav
            .getByRole("button", { name: "跳转到 $", exact: true })
            .click();
          await expectFold(page, pane, 4, true);
          await toggleFold(page, pane, 4, false);
          await expectFold(page, pane, 5, true);
          await toggleFold(page, pane, 5, false);
          await returnToSplit(page);
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setContentSize(1320, 920),
          );
        }
      },
    );

    await t.test(
      "supports searching escaped brackets inside a folded array while retaining unrelated child folds",
      async () => {
        for (const pane of ["input", "output"] as const) {
          await top(page, pane);
          await toggleFold(page, pane, 5, true);
          await toggleFold(page, pane, 4, true);
          const panel = await search(page, pane, longMarker);
          await panel.locator('button[name="close"]').click();
          const nav = editor(page, pane).getByRole("navigation", {
            name: `${pane === "input" ? "输入 JSON" : "格式化 JSON 结果"} 父级路径`,
            exact: true,
          });
          await poll(
            () =>
              nav.locator("button[data-path]").last().getAttribute("data-path"),
            (value) => value === "$.fieldDefinitions[599]",
            "Search or string brackets confused the selected parent container",
          );
          await nav
            .getByRole("button", {
              name: "跳转到 $.fieldDefinitions",
              exact: true,
            })
            .click();
          await expectFold(page, pane, 4, false);
          await expectFold(page, pane, 5, true);
          if (pane === "output") {
            await page.keyboard.insertText("MUST_NOT_CHANGE");
            assert.ok(
              (await fullEditorText(page, pane)) === raw,
              "A folded output became editable",
            );
          }
          await top(page, pane);
          await toggleFold(page, pane, 5, false);
        }
      },
    );

    await t.test(
      "preserves child folds and restores exact source with edit undo",
      async () => {
        await top(page, "input");
        await toggleFold(page, "input", 5, true);
        const panel = await search(page, "input", "1.0");
        await panel.locator('button[name="close"]').click();
        await delay(600);
        await page.keyboard.type("updated-2.0");
        const changed = raw.replace(
          '"version": "1.0"',
          '"version": "updated-2.0"',
        );
        await top(page, "input");
        await expectFold(page, "input", 4, false);
        await expectFold(page, "input", 5, true);
        assert.ok(
          (await fullEditorText(page, "input")) === changed,
          "Editing around folds changed unrelated JSON",
        );
        await editor(page, "input")
          .locator(".cm-content")
          .press("ControlOrMeta+z");
        assert.ok(
          (await fullEditorText(page, "input")) === raw,
          "Undo did not restore the original complete JSON",
        );
        await top(page, "input");
        await expectFold(page, "input", 4, false);
        await expectFold(page, "input", 5, true);
        await toggleFold(page, "input", 4, true);
        await page.screenshot({
          path: path.join(screenshots, "folding-large-array-collapsed.png"),
        });
      },
    );

    await t.test("finishes folding workflows without renderer errors", () =>
      assert.deepEqual(errors, []),
    );
  },
);
