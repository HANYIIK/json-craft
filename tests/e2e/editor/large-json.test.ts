import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Locator, type Page } from "playwright";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshots = path.join(projectRoot, "output", "playwright");
const tail = "__LARGE_JSON_FINAL_MARKER__";
const valueTail = "__LARGE_VALUE_FINAL_MARKER__";
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
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

function editor(page: Page, pane: Pane) {
  return page.getByTestId(`${pane}-editor`);
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

async function metrics(scroller: Locator) {
  return scroller.evaluate((element) => {
    const content = element.querySelector(".cm-content")!;
    const rect = element.getBoundingClientRect();
    const visible = Array.from(content.querySelectorAll(".cm-line")).filter(
      (line) => {
        const bounds = line.getBoundingClientRect();
        return bounds.bottom >= rect.top && bounds.top <= rect.bottom;
      },
    );
    return {
      top: element.scrollTop,
      left: element.scrollLeft,
      height: element.clientHeight,
      width: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      renderedCharacters: content.textContent?.length,
      first: visible[0]?.textContent?.slice(0, 80),
      last: visible.at(-1)?.textContent?.slice(-80),
      gaps: Array.from(content.querySelectorAll(".cm-line > div")).map(
        (gap) => ({
          height: gap.getBoundingClientRect().height,
          width: gap.getBoundingClientRect().width,
        }),
      ),
    };
  });
}

async function markerVisible(scroller: Locator, marker = tail) {
  return scroller.evaluate((element, marker) => {
    const viewport = element.getBoundingClientRect();
    const content = element.querySelector(".cm-content")!;
    const start = content.textContent?.indexOf(marker) ?? -1;
    if (start < 0) return false;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.textContent?.length ?? 0;
      if (!started && start < offset + length) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && start + marker.length <= offset + length) {
        range.setEnd(node, start + marker.length - offset);
        const rectangles = Array.from(range.getClientRects()).filter(
          (rect) => rect.width > 0,
        );
        return (
          rectangles.length > 0 &&
          rectangles.every(
            (rect) =>
              rect.top >= viewport.top - 2 &&
              rect.bottom <= viewport.bottom + 2 &&
              rect.left >= viewport.left - 2 &&
              rect.right <= viewport.right + 2,
          )
        );
      }
      offset += length;
    }
    return false;
  }, marker);
}

async function returnToSplit(page: Page) {
  const close = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await close.isVisible()) await close.click();
  await poll(
    () => page.locator(".application").getAttribute("data-focused-pane"),
    (value) => value === null,
    "The editor did not return to split mode",
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
    "The requested large editor did not enter focus mode",
  );
  await delay(100);
}

async function setWrapping(page: Page, wrap: boolean) {
  const button = page.getByRole("button", { name: "自动换行", exact: true });
  if ((await button.getAttribute("aria-pressed")) !== String(wrap))
    await button.click();
  await delay(100);
}

async function scrollToTail(
  page: Page,
  pane: Pane,
  name: string,
  marker = tail,
  horizontal = false,
) {
  const scroller = editor(page, pane).locator(".cm-scroller");
  await scroller.hover();
  for (let count = 0; count < 3; count++) {
    await page.mouse.wheel(horizontal ? 1_000_000 : 0, 1_000_000);
    await delay(100);
  }
  try {
    await poll(
      () => markerVisible(scroller, marker),
      Boolean,
      `The real final marker is missing: ${name}`,
    );
  } finally {
    await page.screenshot({
      path: path.join(screenshots, `large-${name}.png`),
    });
  }
  const size = await metrics(scroller);
  assert.ok(
    size.renderedCharacters && size.renderedCharacters > tail.length,
    `The viewport is entirely empty: ${JSON.stringify(size)}`,
  );
  return size;
}

async function openSearch(page: Page, pane: Pane, query: string) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+Home");
  await content.press("ControlOrMeta+f");
  const panel = editor(page, pane).locator(".cm-search");
  await panel.waitFor();
  await panel.locator('input[name="search"]').fill(query);
  return panel;
}

async function expectCount(panel: Locator, expected: string) {
  await poll(
    async () =>
      (await panel.locator(".cm-search-count").innerText()).replace(/\s/g, ""),
    (value) => value === expected,
    "The full-document search count or selected match is incorrect",
  );
}

async function expectFullText(page: Page, pane: Pane, expected: string) {
  const actual = await fullEditorText(page, pane);
  assert.equal(
    actual.length,
    expected.length,
    `${pane} document length changed`,
  );
  assert.ok(actual === expected, `${pane} document contents changed`);
}

test(
  "Electron large JSON remains visible after wrapping and pane changes",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-large-")),
    );
    const userData = path.join(workspace, "user-data");
    const sourceDirectory = path.join(workspace, "source");
    const settings = {
      readDirectory: sourceDirectory,
      writeDirectory: path.join(workspace, "stored-json"),
      historyDirectory: path.join(workspace, "history"),
      theme: "system",
      autoCopy: false,
      language: "zh-CN",
    };
    await Promise.all(
      [
        userData,
        sourceDirectory,
        settings.writeDirectory,
        settings.historyDirectory,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await writeFile(
      path.join(userData, "workspace-settings.json"),
      JSON.stringify({
        version: 1,
        initialized: true,
        activeId: null,
        settings,
      }),
    );
    const synthetic = {
      rows: Array.from({ length: 900 }, (_, index) => ({
        id: index,
        title: `synthetic-entry-${index}`,
        nested: {
          operations: ["exact", "in", "exists"],
          allow_empty_string: false,
          value: "synthetic-value-".repeat(4),
        },
      })),
      tail,
    };
    const fixtures = [
      {
        name: "compressed",
        raw: JSON.stringify(synthetic),
        expected: JSON.stringify(synthetic, null, 2),
      },
      {
        name: "escaped",
        raw: JSON.stringify(JSON.stringify(JSON.stringify(synthetic))),
        expected: JSON.stringify(synthetic, null, 2),
      },
      {
        name: "long-value",
        raw: JSON.stringify({
          payload:
            'synthetic-long-value with escaped quote " and newline\n'.repeat(
              3500,
            ) + valueTail,
          tail,
        }),
        expected: JSON.stringify(
          {
            payload:
              'synthetic-long-value with escaped quote " and newline\n'.repeat(
                3500,
              ) + valueTail,
            tail,
          },
          null,
          2,
        ),
      },
      {
        name: "multiline",
        raw: JSON.stringify(
          {
            rows: Array.from({ length: 2050 }, (_, id) => ({
              id,
              value: "needle",
            })),
            tail,
          },
          null,
          2,
        ),
        expected: "",
      },
    ];
    fixtures[3].expected = fixtures[3].raw;
    await mkdir(screenshots, { recursive: true });
    for (const fixture of fixtures)
      await writeFile(
        path.join(sourceDirectory, `${fixture.name}.json`),
        fixture.raw,
      );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    const application = await _electron.launch({
      args: [
        projectRoot,
        `--user-data-dir=${userData}`,
        ...fixtures.map((fixture) =>
          path.join(sourceDirectory, `${fixture.name}.json`),
        ),
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
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Renderer crashed"));
    await page.getByTestId("input-editor").locator(".cm-content").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    const loadedSettings = (
      await page.evaluate(() => window.desktop!.workspace.load())
    ).settings;
    assert.equal(loadedSettings.writeDirectory, settings.writeDirectory);
    assert.equal(loadedSettings.historyDirectory, settings.historyDirectory);
    const selectFixture = async (name: string) => {
      await returnToSplit(page);
      await page
        .getByRole("button", { name: new RegExp(`^${name}\\.json，`) })
        .click();
      await poll(
        () => page.getByRole("heading", { level: 1 }).innerText(),
        (value) => value.trim() === `${name}.json`,
        "The intended large document did not become active",
      );
      await editor(page, "output").locator(".cm-content").waitFor();
      await delay(100);
    };
    for (const fixture of fixtures) {
      await t.test(
        `${fixture.name} reaches its real final marker in split and focused editors`,
        async () => {
          await selectFixture(fixture.name);
          await poll(
            async () => {
              const state = await page.evaluate(() =>
                window.desktop!.workspace.load(),
              );
              const record = state.records.find(
                (entry) => entry.name === `${fixture.name}.json`,
              );
              return record
                ? page.evaluate(
                    (id) => window.desktop!.workspace.read(id),
                    record.id,
                  )
                : null;
            },
            (record) => record?.raw === fixture.raw,
            "The full imported JSON was not preserved",
          );
          await delay(500);
          await expectFullText(page, "input", fixture.raw);
          await expectFullText(page, "output", fixture.expected);
          for (const wrap of [true, false]) {
            for (const focused of [false, true]) {
              for (const pane of ["input", "output"] as const) {
                await returnToSplit(page);
                if (focused) await focusPane(page, pane);
                await setWrapping(page, wrap);
                const mode = `${focused ? "focused" : "split"}-${wrap ? "wrapped" : "unwrapped"}`;
                const size = await scrollToTail(
                  page,
                  pane,
                  `${fixture.name}-${pane}-${mode}`,
                  !wrap && fixture.name === "long-value" && pane === "output"
                    ? valueTail
                    : tail,
                  !wrap &&
                    fixture.name !== "multiline" &&
                    (pane === "input" || fixture.name === "long-value"),
                );
                if (
                  !wrap &&
                  fixture.name !== "multiline" &&
                  (pane === "input" || fixture.name === "long-value")
                ) {
                  assert.ok(
                    size.scrollWidth > size.width + 100_000,
                    "The unwrapped long JSON did not allow horizontal scrolling",
                  );
                  assert.ok(
                    size.left > 100_000,
                    "The real horizontal wheel did not reach the long line's tail",
                  );
                  await editor(page, pane).locator(".cm-scroller").hover();
                  await page.mouse.wheel(-10_000_000, 0);
                  await poll(
                    () => metrics(editor(page, pane).locator(".cm-scroller")),
                    (value) => value.left < 2,
                    "The horizontal wheel did not return to the line start",
                  );
                  if (fixture.name === "long-value" && pane === "output") {
                    await poll(
                      () =>
                        markerVisible(
                          editor(page, pane).locator(".cm-scroller"),
                        ),
                      Boolean,
                      "The formatted document's final short line is missing after horizontal scrolling returns left",
                    );
                  }
                }
              }
            }
          }
          await returnToSplit(page);
          await setWrapping(page, true);
          await expectFullText(page, "input", fixture.raw);
          await expectFullText(page, "output", fixture.expected);
        },
      );
    }

    await t.test(
      "pastes a compressed 170k JSON through CodeMirror and saves its exact contents",
      async () => {
        await returnToSplit(page);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const content = editor(page, "input").locator(".cm-content");
        await content.focus();
        const consumed = await content.evaluate((element, raw) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", raw);
          return !element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        }, fixtures[0].raw);
        assert.equal(
          consumed,
          true,
          "CodeMirror did not handle the paste event",
        );
        await expectFullText(page, "input", fixtures[0].raw);
        await poll(
          async () => {
            const state = await page.evaluate(() =>
              window.desktop!.workspace.load(),
            );
            return state.activeId
              ? (
                  await page.evaluate(
                    (id) => window.desktop!.workspace.read(id),
                    state.activeId,
                  )
                ).raw === fixtures[0].raw
              : false;
          },
          Boolean,
          "The pasted source was not persisted exactly",
        );
        const filePath = await poll(
          async () =>
            (await page
              .getByTestId("managed-file-path")
              .getAttribute("title")) ?? "",
          (value) => path.isAbsolute(value) && /\.json$/i.test(value),
          "The pasted source did not receive a stored JSON file",
        );
        assert.equal(
          await realpath(path.dirname(filePath)),
          await realpath(settings.writeDirectory),
        );
        assert.ok(
          (await readFile(filePath, "utf8")) === fixtures[0].raw,
          "The saved JSON file differs from the pasted source",
        );
        await focusPane(page, "input");
        await setWrapping(page, false);
        await scrollToTail(
          page,
          "input",
          "paste-focused-unwrapped",
          tail,
          true,
        );
        await setWrapping(page, true);
        await scrollToTail(page, "input", "paste-focused-wrapped");
        await returnToSplit(page);
        await scrollToTail(page, "input", "paste-split-wrapped");
      },
    );

    await t.test(
      "restores long-line layout after settings hides and reveals the workspace",
      async () => {
        await selectFixture("long-value");
        for (let repeat = 0; repeat < 2; repeat++) {
          await scrollToTail(page, "input", `settings-before-${repeat}`);
          await scrollToTail(
            page,
            "output",
            `settings-output-before-${repeat}`,
          );
          const inputNode = await editor(page, "input")
            .locator(".cm-content")
            .elementHandle();
          assert.ok(inputNode);
          await page
            .getByRole("button", { name: "应用设置", exact: true })
            .click();
          await page.locator("main.settings-page").waitFor();
          assert.equal(await editor(page, "input").isVisible(), false);
          await page
            .getByRole("button", { name: "关闭应用设置", exact: true })
            .click();
          await editor(page, "input").waitFor();
          assert.equal(
            await inputNode.evaluate(
              (element) =>
                element.isConnected &&
                element ===
                  document.querySelector(
                    '[data-testid="input-editor"] .cm-content',
                  ),
            ),
            true,
          );
          await scrollToTail(page, "input", `settings-after-${repeat}`);
          await scrollToTail(page, "output", `settings-output-after-${repeat}`);
        }
        await expectFullText(page, "input", fixtures[2].raw);
      },
    );

    await t.test(
      "keeps long-document search, replacement expansion, and field selection through resize",
      async () => {
        await selectFixture("long-value");
        for (const pane of ["input", "output"] as const) {
          const panel = await openSearch(page, pane, tail);
          await expectCount(panel, "0/1");
          const query = panel.locator('input[name="search"]');
          if (pane === "input") {
            await panel.locator('button[name="toggleReplace"]').click();
            await panel
              .locator('input[name="replace"]')
              .fill("replacement-retained");
          }
          await query.focus();
          await query.press("ControlOrMeta+a");
          await query.press("ArrowLeft");
          for (let index = 0; index < 7; index++)
            await query.press("Shift+ArrowRight");
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setContentSize(1100, 760),
          );
          await poll(
            () =>
              query.evaluate((element) => ({
                focused: element === document.activeElement,
                from: (element as HTMLInputElement).selectionStart,
                to: (element as HTMLInputElement).selectionEnd,
              })),
            (value) => value.focused && value.from === 0 && value.to === 7,
            "Resizing lost the active search field or its text selection",
          );
          await expectCount(panel, "0/1");
          if (pane === "input") {
            assert.equal(
              await panel
                .locator('button[name="toggleReplace"]')
                .getAttribute("aria-expanded"),
              "true",
            );
            assert.equal(
              await panel.locator('input[name="replace"]').inputValue(),
              "replacement-retained",
            );
          }
          await panel.locator('button[name="next"]').click();
          await expectCount(panel, "1/1");
          await panel.locator('button[name="close"]').click();
          await poll(
            () => markerVisible(editor(page, pane).locator(".cm-scroller")),
            Boolean,
            "Search did not reveal the large document's final match",
          );
          await focusPane(page, pane);
          await scrollToTail(page, pane, `search-${pane}-focused`);
          await returnToSplit(page);
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setContentSize(1320, 920),
          );
        }
      },
    );

    await t.test(
      "keeps focus in the chosen search panel or external field while both long editors resize",
      async () => {
        await selectFixture("long-value");
        const panels = {
          input: await openSearch(page, "input", tail),
          output: await openSearch(page, "output", tail),
        };
        await expectCount(panels.input, "0/1");
        await expectCount(panels.output, "0/1");
        for (const pane of ["input", "output"] as const) {
          const query = panels[pane].locator('input[name="search"]');
          await query.focus();
          await query.press("ControlOrMeta+a");
          await query.press("ArrowLeft");
          for (let index = 0; index < 7; index++)
            await query.press("Shift+ArrowRight");
          const width = pane === "input" ? 1100 : 1320;
          await application.evaluate(
            ({ BrowserWindow }, size) =>
              BrowserWindow.getAllWindows()[0].setContentSize(size, 840),
            width,
          );
          await poll(
            () => page.evaluate(() => innerWidth),
            (value) => value === width,
            "The window did not reach its requested search-focus width",
          );
          await delay(150);
          await poll(
            () =>
              query.evaluate((element) => ({
                focused: element === document.activeElement,
                from: (element as HTMLInputElement).selectionStart,
                to: (element as HTMLInputElement).selectionEnd,
              })),
            (value) => value.focused && value.from === 0 && value.to === 7,
            `The other editor stole focus from ${pane} search during resize`,
          );
          await expectCount(panels.input, "0/1");
          await expectCount(panels.output, "0/1");
        }
        const key = page.getByRole("textbox", {
          name: "提取 key 名称",
          exact: true,
        });
        await key.fill("external-key");
        await key.press("ControlOrMeta+a");
        await key.press("ArrowLeft");
        for (let index = 0; index < 5; index++)
          await key.press("Shift+ArrowRight");
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1200, 840),
        );
        await poll(
          () => page.evaluate(() => innerWidth),
          (value) => value === 1200,
          "The external-field resize did not finish",
        );
        await delay(150);
        await poll(
          () =>
            key.evaluate((element) => ({
              focused: element === document.activeElement,
              from: (element as HTMLInputElement).selectionStart,
              to: (element as HTMLInputElement).selectionEnd,
            })),
          (value) => value.focused && value.from === 0 && value.to === 5,
          "A search panel stole focus from the external key field",
        );
        assert.equal(await key.inputValue(), "external-key");
        await key.fill("");
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        const setting = page.getByRole("textbox", {
          name: "默认读取目录",
          exact: true,
        });
        await setting.focus();
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1320, 920),
        );
        await poll(
          () => page.evaluate(() => innerWidth),
          (value) => value === 1320,
          "The settings-field resize did not finish",
        );
        await delay(150);
        assert.equal(
          await setting.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
          "A hidden editor stole focus from the settings field",
        );
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
        for (const pane of ["input", "output"] as const)
          await panels[pane].locator('button[name="close"]').click();
      },
    );

    await t.test(
      "preserves exact source and undo while editing and repeatedly changing long-line layouts",
      async () => {
        const fixture = fixtures[1];
        await selectFixture(fixture.name);
        await focusPane(page, "input");
        const panel = await openSearch(page, "input", "synthetic-entry-0");
        await expectCount(panel, "0/1");
        await panel.locator('button[name="next"]').click();
        await expectCount(panel, "1/1");
        await panel.locator('button[name="close"]').click();
        const content = editor(page, "input").locator(".cm-content");
        await delay(600);
        await page.keyboard.insertText("edited-entry-0");
        const changed = fixture.raw.replace(
          "synthetic-entry-0",
          "edited-entry-0",
        );
        for (let repeat = 0; repeat < 2; repeat++) {
          await returnToSplit(page);
          await setWrapping(page, false);
          await focusPane(page, "input");
          await setWrapping(page, true);
        }
        await expectFullText(page, "input", changed);
        await content.press("ControlOrMeta+z");
        await expectFullText(page, "input", fixture.raw);
        await returnToSplit(page);
        await poll(
          async () => {
            const state = await page.evaluate(() =>
              window.desktop!.workspace.load(),
            );
            const record = state.records.find(
              (value) => value.name === `${fixture.name}.json`,
            );
            return record
              ? (
                  await page.evaluate(
                    (id) => window.desktop!.workspace.read(id),
                    record.id,
                  )
                ).raw === fixture.raw
              : false;
          },
          Boolean,
          "Undo did not persist the entire original source",
        );
      },
    );
    assert.deepEqual(errors, []);
  },
);
