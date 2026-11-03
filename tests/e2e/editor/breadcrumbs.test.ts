import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshots = path.join(projectRoot, "output", "playwright");
type Pane = "input" | "output";
const labels = { input: "输入 JSON", output: "格式化 JSON 结果" };

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

function crumbs(page: Page, pane: Pane) {
  return editor(page, pane).getByRole("navigation", {
    name: `${labels[pane]} 父级路径`,
    exact: true,
  });
}

async function paths(page: Page, pane: Pane) {
  return crumbs(page, pane)
    .locator("button[data-path]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-path")),
    );
}

async function expectParent(page: Page, pane: Pane, expected: string) {
  await poll(
    () => paths(page, pane),
    (value) => value.at(-1) === expected,
    `The ${pane} breadcrumb did not follow the preview's parent container`,
  );
  assert.equal((await paths(page, pane))[0], "$");
  const buttons = crumbs(page, pane).locator("button[data-path]");
  for (let index = 0; index < (await buttons.count()); index++) {
    const button = buttons.nth(index);
    assert.equal(
      await button.getAttribute("aria-label"),
      `跳转到 ${await button.getAttribute("data-path")}`,
    );
  }
}

async function returnToSplit(page: Page) {
  const back = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await back.isVisible()) await back.click();
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
    "The requested breadcrumb editor did not enter focus mode",
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

async function prepare(page: Page, raw: string, marker: string) {
  await returnToSplit(page);
  for (const pane of ["input", "output"] as const) {
    const panel = editor(page, pane).locator(".cm-search");
    if (await panel.isVisible())
      await panel.locator('button[name="close"]').click();
  }
  const wrap = page.getByRole("button", { name: "自动换行", exact: true });
  if ((await wrap.getAttribute("aria-pressed")) !== "true") await wrap.click();
  const content = editor(page, "input").locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  await content.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, raw);
  await editor(page, "output").locator(".cm-content").waitFor();
  assert.ok(
    (await fullEditorText(page, "input")) === raw,
    "Preparing a breadcrumb document changed the source JSON",
  );
  await poll(
    () => fullEditorText(page, "output"),
    (value) => value.includes(marker),
    "The output does not belong to the current breadcrumb document",
  );
  await expectParent(page, "input", "$");
  await expectParent(page, "output", "$");
}

async function markerGeometry(page: Page, pane: Pane, marker: string) {
  return editor(page, pane)
    .locator(".cm-scroller")
    .evaluate((element, text) => {
      const viewport = element.getBoundingClientRect();
      const content = element.querySelector(".cm-content")!;
      const start = content.textContent?.indexOf(text) ?? -1;
      if (start < 0) return null;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let consumed = 0;
      let started = false;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const length = node.textContent?.length ?? 0;
        if (!started && start < consumed + length) {
          range.setStart(node, start - consumed);
          started = true;
        }
        if (started && start + text.length <= consumed + length) {
          range.setEnd(node, start + text.length - consumed);
          const bounds = range.getBoundingClientRect();
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            viewportTop: viewport.top,
            viewportBottom: viewport.bottom,
            scrollTop: element.scrollTop,
          };
        }
        consumed += length;
      }
      return null;
    }, marker);
}

async function markerVisible(page: Page, pane: Pane, marker: string) {
  const bounds = await markerGeometry(page, pane, marker);
  return (
    bounds !== null &&
    bounds.top >= bounds.viewportTop - 1 &&
    bounds.bottom <= bounds.viewportBottom + 1
  );
}

async function scrollMarkerToTop(
  page: Page,
  pane: Pane,
  marker: string,
  initialScroll = 0,
) {
  const scroller = editor(page, pane).locator(".cm-scroller");
  await scroller.hover();
  await page.mouse.wheel(0, -10_000_000);
  await poll(
    () => scroller.evaluate((element) => element.scrollTop),
    (value) => value <= 1,
    "The preview did not scroll back to its start",
  );
  if (initialScroll) {
    await page.mouse.wheel(0, initialScroll);
    await delay(60);
  }
  for (let step = 0; step < 180; step++) {
    const markerBounds = await markerGeometry(page, pane, marker);
    if (markerBounds) {
      await scroller.hover();
      await page.mouse.wheel(
        0,
        markerBounds.top - markerBounds.viewportTop - 5,
      );
      await delay(60);
      const aligned = await markerGeometry(page, pane, marker);
      if (aligned && Math.abs(aligned.top - aligned.viewportTop - 5) <= 3)
        return aligned;
    } else {
      await page.mouse.wheel(0, 140);
      await delay(30);
    }
  }
  assert.fail(
    `The real wheel could not align ${marker} with the preview's upper edge`,
  );
}

async function openSearch(page: Page, pane: Pane, query: string) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+f");
  const panel = editor(page, pane).locator(".cm-search");
  await panel.waitFor();
  await panel.locator('input[name="search"]').fill(query);
  return panel;
}

test(
  "Electron parent breadcrumbs track the preview viewport and navigate JSON containers",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-breadcrumbs-"),
    );
    const userData = path.join(workspace, "profile");
    await isolateWorkspace(userData);
    const canonicalWorkspace = await realpath(workspace);
    await mkdir(screenshots, { recursive: true });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    const application = await _electron.launch({
      args: [projectRoot, `--user-data-dir=${userData}`],
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
    const settings = (
      await page.evaluate(() => window.desktop!.workspace.load())
    ).settings;
    for (const directory of [
      settings.readDirectory,
      settings.writeDirectory,
      settings.historyDirectory,
    ])
      assert.ok(
        directory.startsWith(`${canonicalWorkspace}${path.sep}`),
        "A breadcrumb test escaped its temporary workspace",
      );

    const nested = {
      prefix: Array.from({ length: 35 }, (_, index) => `prefix-${index}`),
      groups: Array.from({ length: 2 }, (_, index) => ({
        same: {
          "a.b": {
            marker: `ARRAY_BRANCH_${index}`,
            padding: Array.from(
              { length: 25 },
              (_, position) => `branch-${index}-${position}`,
            ),
            'quote"key': {
              marker: `SPECIAL_BRANCH_${index}`,
              after: Array.from(
                { length: 35 },
                (_, position) => `special-${position}`,
              ),
            },
          },
        },
      })),
      suffix: Array.from({ length: 35 }, (_, index) => `suffix-${index}`),
    };
    const nestedRaw = JSON.stringify(nested, null, 2);

    await t.test(
      "provides a fixed accessible path bar and follows each editor independently",
      async () => {
        await prepare(page, nestedRaw, "SPECIAL_BRANCH_1");
        for (const pane of ["input", "output"] as const) {
          const size = await crumbs(page, pane).boundingBox();
          assert.ok(
            size && Math.abs(size.height - 26) <= 1,
            "The parent path bar does not have its fixed 26px height",
          );
        }
        await scrollMarkerToTop(page, "input", "ARRAY_BRANCH_1");
        await expectParent(page, "input", '$.groups[1].same["a.b"]');
        assert.deepEqual(await paths(page, "input"), [
          "$",
          "$.groups",
          "$.groups[1]",
          "$.groups[1].same",
          '$.groups[1].same["a.b"]',
        ]);
        await expectParent(page, "output", "$");
        const sourceScroll = await editor(page, "input")
          .locator(".cm-scroller")
          .evaluate((element) => element.scrollTop);
        await scrollMarkerToTop(page, "output", "SPECIAL_BRANCH_0");
        await expectParent(
          page,
          "output",
          '$.groups[0].same["a.b"]["quote\\\"key"]',
        );
        await expectParent(page, "input", '$.groups[1].same["a.b"]');
        assert.ok(
          Math.abs(
            (await editor(page, "input")
              .locator(".cm-scroller")
              .evaluate((element) => element.scrollTop)) - sourceScroll,
          ) <= 1,
          "Scrolling the output moved the input preview",
        );
      },
    );

    await t.test(
      "uses the top of the preview instead of a caret clicked into another visible container",
      async () => {
        const raw = JSON.stringify(
          {
            prefix: Array.from({ length: 35 }, (_, index) => `prefix-${index}`),
            first: { marker: "TOP_CONTAINER_MARKER", value: 1 },
            second: {
              marker: "CARET_OTHER_CONTAINER",
              value: 2,
              after: Array.from({ length: 45 }, (_, index) => `after-${index}`),
            },
          },
          null,
          2,
        );
        await prepare(page, raw, "CARET_OTHER_CONTAINER");
        for (const pane of ["input", "output"] as const) {
          await scrollMarkerToTop(page, pane, "TOP_CONTAINER_MARKER");
          await expectParent(page, pane, "$.first");
          const before = await editor(page, pane)
            .locator(".cm-scroller")
            .evaluate((element) => element.scrollTop);
          const caret = await markerGeometry(
            page,
            pane,
            "CARET_OTHER_CONTAINER",
          );
          assert.ok(
            caret && caret.bottom <= caret.viewportBottom,
            "The other container is not visible for the caret-only interaction",
          );
          await page.mouse.click(
            caret.left + 3,
            (caret.top + caret.bottom) / 2,
          );
          await delay(80);
          assert.ok(
            Math.abs(
              (await editor(page, pane)
                .locator(".cm-scroller")
                .evaluate((element) => element.scrollTop)) - before,
            ) <= 1,
            "The caret interaction also scrolled the preview",
          );
          await expectParent(page, pane, "$.first");
        }
      },
    );

    await t.test(
      "clicks the correct duplicate parent key and keeps output read-only",
      async () => {
        const first = JSON.stringify(
          {
            marker: "DUPLICATE_FIRST",
            after: Array.from({ length: 45 }, (_, index) => `first-${index}`),
          },
          null,
          2,
        );
        const second = JSON.stringify(
          {
            marker: "DUPLICATE_SECOND",
            after: Array.from({ length: 45 }, (_, index) => `second-${index}`),
          },
          null,
          2,
        );
        const raw = `{\n"same":${first},\n"same":${second}\n}`;
        await prepare(page, raw, "DUPLICATE_SECOND");
        const originalOutput = await fullEditorText(page, "output");
        for (const pane of ["input", "output"] as const) {
          await scrollMarkerToTop(page, pane, "DUPLICATE_SECOND");
          await expectParent(page, pane, "$.same");
          await crumbs(page, pane)
            .getByRole("button", { name: "跳转到 $.same", exact: true })
            .click();
          await poll(
            () => markerVisible(page, pane, "DUPLICATE_SECOND"),
            Boolean,
            "The parent button did not reveal the second same-named container",
          );
          assert.equal(
            await markerVisible(page, pane, "DUPLICATE_FIRST"),
            false,
            "The duplicate parent button jumped to the first property",
          );
          const selection = await page.evaluate(
            () => getSelection()?.toString() ?? "",
          );
          assert.match(
            selection,
            /same/,
            "The clicked parent key was not selected",
          );
          if (pane === "output") {
            await page.keyboard.insertText("MUST_NOT_EDIT");
            assert.ok(
              (await fullEditorText(page, "output")) === originalOutput,
              "Clicking a breadcrumb made the result editable",
            );
          }
        }
        assert.ok(
          (await fullEditorText(page, "input")) === raw,
          "Parent navigation changed the original JSON",
        );
      },
    );

    await t.test(
      "preserves paths and parent jumps across split and focused layouts",
      async () => {
        await prepare(page, nestedRaw, "SPECIAL_BRANCH_1");
        for (const pane of ["input", "output"] as const) {
          await focusPane(page, pane);
          await scrollMarkerToTop(page, pane, "SPECIAL_BRANCH_1");
          await expectParent(
            page,
            pane,
            '$.groups[1].same["a.b"]["quote\\\"key"]',
          );
          await crumbs(page, pane)
            .getByRole("button", {
              name: '跳转到 $.groups[1].same["a.b"]',
              exact: true,
            })
            .click();
          await poll(
            () => markerVisible(page, pane, "ARRAY_BRANCH_1"),
            Boolean,
            "The focused breadcrumb did not jump to its parent key",
          );
          await returnToSplit(page);
          await scrollMarkerToTop(page, pane, "SPECIAL_BRANCH_1");
          await expectParent(
            page,
            pane,
            '$.groups[1].same["a.b"]["quote\\\"key"]',
          );
        }
      },
    );

    await t.test(
      "resolves a wrapped single line from the visible character rather than its physical line start",
      async () => {
        const marker = "LONG_SECOND_PARENT_MARKER";
        const raw = JSON.stringify({
          first: { text: "first-data ".repeat(2500) },
          second: {
            nested: {
              text:
                "second-data ".repeat(2500) +
                marker +
                " after-data".repeat(2500),
            },
          },
          third: { text: "third-data ".repeat(2500) },
        });
        assert.equal(raw.includes("\n"), false);
        await prepare(page, raw, marker);
        for (const focused of [false, true]) {
          if (focused) await focusPane(page, "input");
          const panel = await openSearch(page, "input", marker);
          await panel.locator('button[name="next"]').click();
          await poll(
            () => markerVisible(page, "input", marker),
            Boolean,
            "Search did not locate the long-line marker",
          );
          await panel.locator('button[name="close"]').click();
          const target = await markerGeometry(page, "input", marker);
          assert.ok(target);
          const position =
            target.scrollTop + target.top - target.viewportTop - 5;
          const content = editor(page, "input").locator(".cm-content");
          await content.focus();
          await content.press("ControlOrMeta+Home");
          await scrollMarkerToTop(page, "input", marker, position);
          await expectParent(page, "input", "$.second.nested");
          await page.screenshot({
            path: path.join(
              screenshots,
              `breadcrumbs-long-line-${focused ? "focused" : "split"}.png`,
            ),
          });
        }
        await returnToSplit(page);
        assert.ok(
          (await fullEditorText(page, "input")) === raw,
          "Wrapped breadcrumb tracking altered the single-line source",
        );
      },
    );

    await t.test(
      "keeps search floating, retains its query during parent navigation, and preserves edit undo",
      async () => {
        const raw = JSON.stringify(
          {
            prefix: Array.from({ length: 35 }, (_, index) => `prefix-${index}`),
            outer: {
              marker: "before-edit",
              after: Array.from({ length: 40 }, (_, index) => `after-${index}`),
            },
          },
          null,
          2,
        );
        await prepare(page, raw, "before-edit");
        await scrollMarkerToTop(page, "input", "before-edit");
        await expectParent(page, "input", "$.outer");
        const scroller = editor(page, "input").locator(".cm-scroller");
        const before = await scroller.boundingBox();
        const panel = await openSearch(page, "input", "before-edit");
        assert.deepEqual(
          await scroller.boundingBox(),
          before,
          "Opening search displaced the preview below its breadcrumb",
        );
        await crumbs(page, "input")
          .getByRole("button", { name: "跳转到 $.outer", exact: true })
          .click();
        assert.equal(await panel.isVisible(), true);
        assert.equal(
          await panel.locator('input[name="search"]').inputValue(),
          "before-edit",
        );
        await panel.locator('button[name="next"]').click();
        await panel.locator('button[name="close"]').click();
        await delay(600);
        await page.keyboard.insertText("after-edit");
        const changed = raw.replace("before-edit", "after-edit");
        assert.ok(
          (await fullEditorText(page, "input")) === changed,
          "The selected source value could not be edited",
        );
        await crumbs(page, "input")
          .getByRole("button", { name: "跳转到 $", exact: true })
          .click();
        await focusPane(page, "input");
        const content = editor(page, "input").locator(".cm-content");
        await content.focus();
        await content.press("ControlOrMeta+z");
        assert.ok(
          (await fullEditorText(page, "input")) === raw,
          "Parent navigation or focus changes discarded the edit's undo history",
        );
        await returnToSplit(page);
      },
    );

    await t.test(
      "keeps deep paths horizontally reachable in compact light and dark editors",
      async () => {
        const keys = Array.from(
          { length: 9 },
          (_, index) => `long parent key ${index}`,
        );
        let value: unknown = {
          marker: "DEEP_PARENT_MARKER",
          after: Array.from({ length: 35 }, (_, index) => `after-${index}`),
        };
        for (const key of [...keys].reverse()) value = { [key]: value };
        const raw = JSON.stringify(
          {
            prefix: Array.from({ length: 35 }, (_, index) => `prefix-${index}`),
            tree: value,
          },
          null,
          2,
        );
        const expected =
          "$.tree" + keys.map((key) => `[${JSON.stringify(key)}]`).join("");
        await prepare(page, raw, "DEEP_PARENT_MARKER");
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () => page.evaluate(() => innerWidth),
          (width) => width === 780,
          "The breadcrumb test window did not reach compact size",
        );
        const colors: string[] = [];
        for (const theme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await poll(
            () => page.locator("html").getAttribute("data-theme"),
            (value) => value === theme,
            "The breadcrumb theme did not update",
          );
          for (const pane of ["input", "output"] as const) {
            await scrollMarkerToTop(page, pane, "DEEP_PARENT_MARKER");
            await expectParent(page, pane, expected);
            const nav = crumbs(page, pane);
            const overflow = await nav.evaluate((element) =>
              [element, ...Array.from(element.querySelectorAll("*"))].some(
                (node) =>
                  node.clientWidth > 0 &&
                  node.scrollWidth > node.clientWidth + 2 &&
                  /auto|scroll/.test(getComputedStyle(node).overflowX),
              ),
            );
            assert.equal(
              overflow,
              true,
              "The deep path has no horizontal scrolling container",
            );
            const buttons = nav.locator("button[data-path]");
            for (let index = 0; index < (await buttons.count()); index++) {
              const button = buttons.nth(index);
              await button.scrollIntoViewIfNeeded();
              const reachable = await button.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const nav = element.closest("nav")!.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
                return (
                  rect.left >= nav.left - 1 &&
                  rect.right <= nav.right + 1 &&
                  (hit === element || (hit !== null && element.contains(hit)))
                );
              });
              assert.equal(
                reachable,
                true,
                `A ${theme} parent crumb is clipped or covered`,
              );
            }
            colors.push(
              await buttons
                .last()
                .evaluate((element) => getComputedStyle(element).color),
            );
            const navSize = await nav.boundingBox();
            assert.ok(navSize && Math.abs(navSize.height - 26) <= 1);
          }
          await page.screenshot({
            path: path.join(screenshots, `breadcrumbs-${theme}-compact.png`),
          });
        }
        assert.notEqual(
          colors[0],
          colors[2],
          "The path text did not follow the theme",
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          true,
          "Deep breadcrumbs caused the application to overflow horizontally",
        );
      },
    );

    await t.test("finishes breadcrumb workflows without renderer errors", () =>
      assert.deepEqual(errors, []),
    );
  },
);
