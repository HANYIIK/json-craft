import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Locator, type Page } from "playwright";

import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const screenshots = path.join(projectRoot, "output", "playwright");
type Pane = "input" | "output";

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

function editor(page: Page, pane: Pane) {
  return page.getByTestId(`${pane}-editor`);
}

async function editorText(page: Page, pane: Pane) {
  return (await editor(page, pane).locator(".cm-line").allTextContents()).join(
    "\n",
  );
}

async function closePanels(page: Page) {
  for (const pane of ["input", "output"] as const) {
    const panel = editor(page, pane).locator(".cm-search");
    if (await panel.isVisible()) {
      await panel.locator('button[name="close"]').click();
      await panel.waitFor({ state: "hidden" });
    }
  }
}

async function prepare(page: Page, raw: string, short = true) {
  const back = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await back.isVisible()) {
    await back.click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
  await closePanels(page);
  const content = editor(page, "input").locator(".cm-content");
  await content.focus();
  await poll(
    () => content.evaluate((element) => element === document.activeElement),
    Boolean,
    "The input editor did not receive focus before replacing its document",
  );
  await content.press("ControlOrMeta+a");
  const consumed = await content.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    return !element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, raw);
  assert.equal(
    consumed,
    true,
    "CodeMirror did not handle the source JSON paste",
  );
  if (short) {
    await poll(
      () => editorText(page, "input"),
      (value) => value === raw,
      "The source JSON was not inserted exactly",
    );
    await poll(
      () => editorText(page, "output"),
      (value) => value === JSON.stringify(JSON.parse(raw), null, 2),
      "The result was not formatted before opening search",
    );
  } else {
    await poll(
      () => page.getByTestId("output-editor").locator(".cm-editor").count(),
      (value) => value === 1,
      "The long document result was not available",
    );
    await delay(500);
  }
}

async function openSearch(page: Page, pane: Pane, query = "") {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+Home");
  await content.press("ControlOrMeta+f");
  const panel = editor(page, pane).locator(".cm-search");
  await panel.waitFor();
  for (const name of ["case", "re", "word"]) {
    await panel.locator(`input[name="${name}"]`).uncheck();
  }
  await panel.locator('input[name="search"]').fill(query);
  return panel;
}

async function expectCount(panel: Locator, current: number, total: number) {
  const count = panel.locator(".cm-search-count");
  await poll(
    async () => (await count.innerText()).replace(/[\s,]/g, ""),
    (value) => value === `${current}/${total}`,
    "The search counter did not follow the query and selected match",
  );
  assert.equal(await count.getAttribute("role"), "status");
  assert.match(
    (await count.getAttribute("aria-label")) ?? "",
    /^(查找匹配进度|Search match position)$/,
  );
}

async function assertAlignedInputs(panel: Locator) {
  const boundaries = await panel.evaluate((element) => {
    const search = element
      .querySelector(".cm-search-field")!
      .getBoundingClientRect();
    const replace = element
      .querySelector('input[name="replace"]')!
      .getBoundingClientRect();
    return {
      search: { left: search.left, right: search.right, width: search.width },
      replace: {
        left: replace.left,
        right: replace.right,
        width: replace.width,
      },
    };
  });
  assert.ok(boundaries.search.width > 0 && boundaries.replace.width > 0);
  for (const edge of ["left", "right"] as const) {
    assert.ok(
      Math.abs(boundaries.search[edge] - boundaries.replace[edge]) <= 1,
      `The search and replacement inputs are not aligned at their ${edge} edges: ${JSON.stringify(boundaries)}`,
    );
  }
}

async function assertReadableQuery(panel: Locator, minimumTextWidth: number) {
  const sizes = await panel.locator(".cm-search-field").evaluate((element) => {
    const input = element.querySelector<HTMLInputElement>("input")!;
    const counter = element.querySelector<HTMLElement>(".cm-search-count")!;
    const inputRect = input.getBoundingClientRect();
    const countRect = counter.getBoundingClientRect();
    const fieldRect = element.getBoundingClientRect();
    const style = getComputedStyle(input);
    return {
      fieldWidth: fieldRect.width,
      textWidth:
        input.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight),
      inputRight: inputRect.right,
      countLeft: countRect.left,
      countRight: countRect.right,
      countWidth: countRect.width,
      fieldRight: fieldRect.right,
      paddingRight: parseFloat(style.paddingRight),
    };
  });
  assert.ok(
    sizes.textWidth >= minimumTextWidth,
    `The match counter or navigation controls squeeze the query text: ${JSON.stringify(sizes)}`,
  );
  assert.ok(sizes.inputRight <= sizes.countLeft + 1);
  assert.ok(sizes.countRight < sizes.fieldRight);
  assert.ok(sizes.countWidth <= sizes.fieldWidth * 0.4 + 1);
  assert.ok(sizes.paddingRight <= 8);
  return sizes;
}

async function editorGeometry(page: Page, pane: Pane) {
  return editor(page, pane)
    .locator(".cm-editor")
    .evaluate((element) => {
      const scroller = element.querySelector(".cm-scroller")!;
      const content = element.querySelector(".cm-content")!;
      const bounds = scroller.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      const visibleLine = Array.from(element.querySelectorAll(".cm-line"))
        .map((line) => ({
          text: line.textContent,
          bounds: line.getBoundingClientRect(),
        }))
        .find((line) => line.bounds.bottom > bounds.top + 1);
      return {
        scroller: {
          top: bounds.top,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
          scrollTop: scroller.scrollTop,
          scrollLeft: scroller.scrollLeft,
        },
        content: { top: contentBounds.top, left: contentBounds.left },
        visibleLine: visibleLine
          ? { text: visibleLine.text, top: visibleLine.bounds.top }
          : null,
      };
    });
}

function assertGeometryUnchanged(
  before: Awaited<ReturnType<typeof editorGeometry>>,
  after: Awaited<ReturnType<typeof editorGeometry>>,
  context: string,
) {
  for (const key of [
    "top",
    "left",
    "width",
    "height",
    "scrollTop",
    "scrollLeft",
  ] as const) {
    assert.ok(
      Math.abs(after.scroller[key] - before.scroller[key]) <= 1,
      `${context}: editor scroller ${key} moved (${before.scroller[key]} -> ${after.scroller[key]})`,
    );
  }
  assert.ok(
    Math.abs(after.content.top - before.content.top) <= 1,
    `${context}: JSON content moved vertically`,
  );
  assert.ok(
    Math.abs(after.content.left - before.content.left) <= 1,
    `${context}: JSON content moved horizontally`,
  );
  assert.equal(
    after.visibleLine?.text,
    before.visibleLine?.text,
    `${context}: the first visible JSON line changed`,
  );
  assert.ok(
    before.visibleLine !== null &&
      after.visibleLine !== null &&
      Math.abs(after.visibleLine.top - before.visibleLine.top) <= 1,
    `${context}: the visible JSON line moved vertically`,
  );
}

async function assertOverlay(panel: Locator) {
  const overlay = await panel
    .locator('input[name="search"]')
    .evaluate((field) => {
      const container = field.closest(".cm-panels")!;
      const editor = field.closest(".cm-editor")!;
      const scroller = editor
        .querySelector(".cm-scroller")!
        .getBoundingClientRect();
      const bounds = field.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        overlapping:
          x >= scroller.left &&
          x <= scroller.right &&
          y >= scroller.top &&
          y <= scroller.bottom,
        reachable: hit === field || (hit !== null && field.contains(hit)),
        top: container.getBoundingClientRect().top,
        right: container.getBoundingClientRect().right,
        editorTop: editor.getBoundingClientRect().top,
        editorRight: editor.getBoundingClientRect().right,
      };
    });
  assert.equal(
    overlay.overlapping,
    true,
    "The search panel does not overlay the editor scroller",
  );
  assert.equal(
    overlay.reachable,
    true,
    "The editor covers the floating search input",
  );
  assert.ok(
    overlay.top >= overlay.editorTop && overlay.top <= overlay.editorTop + 12,
  );
  assert.ok(
    overlay.right <= overlay.editorRight &&
      overlay.right >= overlay.editorRight - 16,
  );
}

async function assertContained(panel: Locator) {
  const geometry = await panel.evaluate((element) => {
    const container = element.closest(".cm-panels")!;
    const editor = element.closest(".cm-editor")!;
    const panelRect = container.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const controls = Array.from(
      element.querySelectorAll("input, button, .cm-search-count"),
    )
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          name: control.getAttribute("name") || control.className,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      });
    return {
      panel: {
        left: panelRect.left,
        top: panelRect.top,
        right: panelRect.right,
        bottom: panelRect.bottom,
        width: panelRect.width,
        height: panelRect.height,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      },
      editor: {
        left: editorRect.left,
        top: editorRect.top,
        right: editorRect.right,
        bottom: editorRect.bottom,
      },
      controls,
    };
  });
  assert.ok(geometry.panel.left >= geometry.editor.left);
  assert.ok(geometry.panel.right <= geometry.editor.right + 1);
  assert.ok(geometry.panel.top >= geometry.editor.top);
  assert.ok(geometry.panel.bottom <= geometry.editor.bottom + 1);
  for (const control of geometry.controls) {
    assert.ok(control.width > 0 && control.height > 0);
    assert.ok(
      control.left >= geometry.panel.left - 1 &&
        control.right <= geometry.panel.right + 1,
      `Search control overflows horizontally: ${control.name}`,
    );
    if (
      control.top < geometry.panel.top - 1 ||
      control.bottom > geometry.panel.bottom + 1
    ) {
      assert.ok(
        geometry.panel.scrollHeight > geometry.panel.clientHeight,
        `A clipped search control cannot be scrolled into view: ${control.name}`,
      );
    }
  }
  const controls = panel.locator(
    "input:visible, button:visible, .cm-search-count:visible",
  );
  for (let index = 0; index < (await controls.count()); index++) {
    const control = controls.nth(index);
    await control.scrollIntoViewIfNeeded();
    const visible = await control.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const panel = element.closest(".cm-panels")!.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      return {
        name: element.getAttribute("name") || element.className,
        hit: hit?.outerHTML.slice(0, 400),
        bounds: {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
        },
        panel: {
          top: panel.top,
          bottom: panel.bottom,
          left: panel.left,
          right: panel.right,
        },
        contained:
          bounds.top >= panel.top - 1 && bounds.bottom <= panel.bottom + 1,
        reachable:
          element.classList.contains("cm-search-count") ||
          element === hit ||
          (hit !== null && element.contains(hit)),
      };
    });
    assert.equal(visible.contained, true, "A search control remains clipped");
    if (!visible.reachable)
      await panel.page().screenshot({
        path: path.join(screenshots, "search-control-covered.png"),
      });
    assert.equal(
      visible.reachable,
      true,
      `A search control is covered: ${JSON.stringify(visible)}`,
    );
  }
  return geometry;
}

test(
  "Electron search shows full-document match progress in compact panels",
  { timeout: 150_000 },
  async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "json-craft-search-"));
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
    await mkdir(screenshots, { recursive: true });

    for (const focused of [false, true]) {
      for (const pane of ["input", "output"] as const) {
        const layout = focused ? "focused" : "split";
        await t.test(
          `${pane} ${layout} search floats without moving JSON or its scroll position`,
          async () => {
            const raw = JSON.stringify(
              {
                rows: Array.from(
                  { length: 160 },
                  (_, index) => `entry-${index} needle`,
                ),
              },
              null,
              2,
            );
            await prepare(page, raw, false);
            if (focused) {
              await page
                .getByRole("button", {
                  name:
                    pane === "input"
                      ? "独占查看原始输入"
                      : "独占查看格式化结果",
                  exact: true,
                })
                .click();
            }
            const content = editor(page, pane).locator(".cm-content");
            await content.focus();
            await content.press("ControlOrMeta+Home");
            for (let line = 0; line < 60; line++)
              await content.press("ArrowDown");
            await poll(
              () => editorGeometry(page, pane),
              (value) => value.scroller.scrollTop > 500,
              "The long JSON did not scroll before opening search",
            );
            await delay(80);
            const before = await editorGeometry(page, pane);
            await content.press("ControlOrMeta+f");
            const panel = editor(page, pane).locator(".cm-search");
            await panel.waitFor();
            await panel.locator('input[name="search"]').fill("needle");
            await expectCount(panel, 0, 160);
            await delay(80);
            const opened = await editorGeometry(page, pane);
            await page.screenshot({
              path: path.join(
                screenshots,
                `search-overlay-${pane}-${layout}.png`,
              ),
            });
            assertGeometryUnchanged(
              before,
              opened,
              `${pane} ${layout} opening search`,
            );
            await assertOverlay(panel);
            if (pane === "input") {
              const toggle = panel.locator('button[name="toggleReplace"]');
              assert.equal(await toggle.getAttribute("aria-expanded"), "false");
              await toggle.click();
              await panel.locator(".cm-search-replace").waitFor();
              assertGeometryUnchanged(
                before,
                await editorGeometry(page, pane),
                `${pane} ${layout} expanding replacement`,
              );
              await assertOverlay(panel);
              await page.screenshot({
                path: path.join(
                  screenshots,
                  `search-overlay-${pane}-${layout}-expanded.png`,
                ),
              });
              await toggle.click();
              await panel
                .locator(".cm-search-replace")
                .waitFor({ state: "hidden" });
              assertGeometryUnchanged(
                before,
                await editorGeometry(page, pane),
                `${pane} ${layout} collapsing replacement`,
              );
            }
            await panel.locator('input[name="search"]').click();
            await panel.locator('button[name="close"]').click();
            await panel.waitFor({ state: "hidden" });
            await delay(80);
            assertGeometryUnchanged(
              before,
              await editorGeometry(page, pane),
              `${pane} ${layout} closing search`,
            );
          },
        );
      }
    }

    await t.test(
      "shows the selected index and wraps next and previous in both editors",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","alpha"]}');
        for (const pane of ["input", "output"] as const) {
          const panel = await openSearch(page, pane);
          await expectCount(panel, 0, 0);
          await panel.locator('input[name="search"]').fill("alpha");
          await expectCount(panel, 0, 3);
          await panel.locator('button[name="next"]').click();
          await expectCount(panel, 1, 3);
          await panel.locator('button[name="next"]').click();
          await expectCount(panel, 2, 3);
          await panel.locator('button[name="prev"]').click();
          await expectCount(panel, 1, 3);
          await panel.locator('button[name="prev"]').click();
          await expectCount(panel, 3, 3);
          await panel.locator('input[name="search"]').press("Enter");
          await expectCount(panel, 1, 3);
          await panel.locator('input[name="search"]').press("Shift+Enter");
          await expectCount(panel, 3, 3);
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
      },
    );

    await t.test(
      "respects case, whole-word, regexp, invalid regexp, and empty queries",
      async () => {
        await prepare(
          page,
          '{"values":["alpha","Alpha","alphabet","alpha","ALPHA","omega"]}',
        );
        const panel = await openSearch(page, "input", "alpha");
        await expectCount(panel, 0, 5);
        await panel.locator('input[name="word"]').check();
        await expectCount(panel, 0, 4);
        await panel.locator('input[name="case"]').check();
        await expectCount(panel, 0, 2);
        await panel.locator('input[name="case"]').uncheck();
        await panel.locator('input[name="word"]').uncheck();
        await panel.locator('input[name="re"]').check();
        await panel.locator('input[name="search"]').fill("alpha|omega");
        await expectCount(panel, 0, 6);
        await panel.locator('input[name="search"]').fill("[");
        await expectCount(panel, 0, 0);
        await panel.locator('input[name="search"]').fill("absent");
        await expectCount(panel, 0, 0);
        await panel.locator('input[name="search"]').fill("");
        await expectCount(panel, 0, 0);
      },
    );

    await t.test(
      "indexes overlapping text matches returned by native backward search",
      async () => {
        await prepare(page, '{"value":"banana"}');
        for (const pane of ["input", "output"] as const) {
          const panel = await openSearch(page, pane, "ana");
          await expectCount(panel, 0, 2);
          await panel.locator('button[name="prev"]').click();
          await expectCount(panel, 2, 2);
          await panel.locator('button[name="close"]').click();
        }
      },
    );

    await t.test(
      "counts zero-width regexp matches and reports the selected match",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","alpha"]}');
        const panel = await openSearch(page, "input", "(?=alpha)");
        await panel.locator('input[name="re"]').check();
        await expectCount(panel, 0, 3);
        await panel.locator('button[name="next"]').click();
        await expectCount(panel, 1, 3);
      },
    );

    await t.test(
      "keeps replacement collapsed by default and preserves values while toggling",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","beta"]}');
        let panel = await openSearch(page, "input", "alpha");
        await expectCount(panel, 0, 2);
        const toggle = panel.locator('button[name="toggleReplace"]');
        const region = panel.locator(".cm-search-replace");
        const replacement = region.locator('input[name="replace"]');
        assert.equal(await toggle.getAttribute("aria-label"), "展开替换");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        const controls = await toggle.getAttribute("aria-controls");
        assert.ok(controls);
        assert.equal(await region.getAttribute("id"), controls);
        assert.equal(await page.locator(`[id="${controls}"]`).count(), 1);
        assert.equal(await region.isVisible(), false);
        assert.equal(await replacement.isVisible(), false);
        assert.equal(
          await region.locator('button[name="replace"]').isVisible(),
          false,
        );
        assert.equal(
          await region.locator('button[name="replaceAll"]').isVisible(),
          false,
        );
        await toggle.focus();
        const tabOrder: string[] = [];
        for (let step = 0; step < 20; step++) {
          const focused = await panel.evaluate((element) => {
            const active = element.ownerDocument.activeElement;
            return {
              inside: active !== null && element.contains(active),
              name: active?.getAttribute("name") || "",
            };
          });
          if (!focused.inside) break;
          tabOrder.push(focused.name);
          await page.keyboard.press("Tab");
        }
        assert.ok(tabOrder.includes("search") && tabOrder.includes("close"));
        assert.ok(
          tabOrder.length < 20,
          "Keyboard focus is trapped in the collapsed search panel",
        );
        assert.ok(
          !tabOrder.includes("replace") && !tabOrder.includes("replaceAll"),
          "Collapsed replacement controls remain in the tab order",
        );
        const before = await editorGeometry(page, "input");
        await toggle.click();
        await region.waitFor();
        await assertAlignedInputs(panel);
        assert.equal(await toggle.getAttribute("aria-label"), "收起替换");
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        assertGeometryUnchanged(
          before,
          await editorGeometry(page, "input"),
          "Expanding replacement",
        );
        await replacement.fill("omega");
        await panel.locator('button[name="next"]').click();
        await expectCount(panel, 1, 2);
        await toggle.click();
        await region.waitFor({ state: "hidden" });
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        await expectCount(panel, 1, 2);
        assert.equal(
          await panel.locator('input[name="search"]').inputValue(),
          "alpha",
        );
        assert.equal(await replacement.inputValue(), "omega");
        await toggle.focus();
        await toggle.press("Space");
        await region.waitFor();
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        assert.equal(await replacement.inputValue(), "omega");
        await expectCount(panel, 1, 2);
        await toggle.press("Enter");
        await region.waitFor({ state: "hidden" });
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(await toggle.getAttribute("aria-label"), "展开替换");
        await expectCount(panel, 1, 2);
        await toggle.press("Enter");
        await region.waitFor();
        assert.equal(await replacement.inputValue(), "omega");
        await panel.locator('button[name="close"]').click();
        panel = await openSearch(page, "input", "alpha");
        assert.equal(
          await panel
            .locator('button[name="toggleReplace"]')
            .getAttribute("aria-expanded"),
          "false",
        );
        assert.equal(
          await panel.locator(".cm-search-replace").isVisible(),
          false,
        );
        await expectCount(panel, 0, 2);
        assert.equal(
          await editorText(page, "input"),
          '{"values":["alpha","alpha","beta"]}',
        );
      },
    );

    await t.test(
      "updates totals when source edits or replacements change matches",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","beta"]}');
        const panel = await openSearch(page, "input", "alpha");
        await expectCount(panel, 0, 2);
        const content = editor(page, "input").locator(".cm-content");
        await content.focus();
        await content.press("ControlOrMeta+a");
        await page.keyboard.insertText('{"values":["alpha","alpha","alpha"]}');
        await expectCount(panel, 0, 3);
        await content.press("ControlOrMeta+Home");
        await panel.locator('button[name="next"]').click();
        await expectCount(panel, 1, 3);
        await panel.locator('button[name="toggleReplace"]').click();
        await panel.locator('input[name="replace"]').fill("omega");
        await panel.locator('button[name="replace"]').click();
        await expectCount(panel, 1, 2);
        await poll(
          () => editorText(page, "input"),
          (value) => value === '{"values":["omega","alpha","alpha"]}',
          "Replacing a selected match did not change the original input",
        );
        await panel.locator('button[name="replaceAll"]').click();
        await expectCount(panel, 0, 0);
        await poll(
          () => editorText(page, "input"),
          (value) => value === '{"values":["omega","omega","omega"]}',
          "Replace all did not update every source match",
        );
      },
    );

    await t.test(
      "keeps each editor query and count independent and output read-only",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","beta"]}');
        const source = await openSearch(page, "input", "alpha");
        await expectCount(source, 0, 2);
        await source.locator('button[name="next"]').click();
        await expectCount(source, 1, 2);
        const output = await openSearch(page, "output", "beta");
        await expectCount(output, 0, 1);
        await output.locator('button[name="next"]').click();
        await expectCount(output, 1, 1);
        await expectCount(source, 1, 2);
        assert.equal(
          await output.locator('button[name="toggleReplace"]').count(),
          0,
        );
        assert.equal(await output.locator(".cm-search-replace").count(), 0);
        assert.equal(await output.locator('input[name="replace"]').count(), 0);
        assert.equal(
          await output
            .locator('button[name="replace"], button[name="replaceAll"]')
            .count(),
          0,
        );
        assert.equal(
          await editor(page, "output")
            .locator(".cm-content")
            .getAttribute("contenteditable"),
          "false",
        );
      },
    );

    await t.test(
      "counts matches beyond the rendered viewport and navigates to the last one",
      async () => {
        const raw = JSON.stringify(
          {
            rows: Array.from({ length: 2050 }, () => "needle"),
          },
          null,
          2,
        );
        await prepare(page, raw, false);
        for (const pane of ["input", "output"] as const) {
          const panel = await openSearch(page, pane, "needle");
          await expectCount(panel, 0, 2050);
          assert.ok(
            (await editor(page, pane).locator(".cm-searchMatch").count()) <
              2050,
            "The long document did not exceed the rendered viewport",
          );
          await panel.locator('button[name="prev"]').click();
          await expectCount(panel, 2050, 2050);
          await poll(
            () =>
              editor(page, pane)
                .locator(".cm-scroller")
                .evaluate((element) => element.scrollTop),
            (value) => value > 1000,
            "The last match did not scroll into view",
          );
          await panel.locator('button[name="close"]').click();
        }
      },
    );

    await t.test(
      "fits compact themed controls in split and focused views",
      async () => {
        await prepare(page, '{"values":["alpha","alpha","alpha"]}');
        await page.emulateMedia({ colorScheme: "dark" });
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The dark search theme did not apply",
        );
        const fullPanel = await openSearch(page, "output", "alpha");
        await fullPanel.locator('button[name="next"]').click();
        await expectCount(fullPanel, 1, 3);
        const full = await assertContained(fullPanel);
        assert.ok(full.panel.height <= 120);
        assert.ok(
          full.controls.find((control) => control.name === "search")!.height <=
            32,
        );
        assert.ok(
          full.controls.find((control) => control.name === "next")!.height <=
            30,
        );
        await page.screenshot({
          path: path.join(screenshots, "search-dark-compact.png"),
        });
        await closePanels(page);
        const darkInput = await openSearch(page, "input", "alpha");
        await page.screenshot({
          path: path.join(screenshots, "search-dark-input-collapsed.png"),
        });
        await darkInput.locator('button[name="toggleReplace"]').click();
        await darkInput.locator(".cm-search-replace").waitFor();
        await assertContained(darkInput);
        await assertAlignedInputs(darkInput);
        await page.screenshot({
          path: path.join(screenshots, "search-dark-input-expanded.png"),
        });
        await closePanels(page);
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 600),
        );
        await poll(
          () => page.evaluate(() => innerWidth),
          (value) => value === 780,
          "The native window did not reach its compact width",
        );
        for (const pane of ["input", "output"] as const) {
          const panel = await openSearch(page, pane, "alpha");
          await expectCount(panel, 0, 3);
          await assertContained(panel);
          if (pane === "input") {
            const before = await editorGeometry(page, pane);
            await panel.locator('button[name="toggleReplace"]').click();
            await panel.locator(".cm-search-replace").waitFor();
            await assertContained(panel);
            await assertAlignedInputs(panel);
            assertGeometryUnchanged(
              before,
              await editorGeometry(page, pane),
              "Compact split replacement expansion",
            );
            await page.screenshot({
              path: path.join(
                screenshots,
                "search-dark-input-split-expanded.png",
              ),
            });
          }
          await panel.locator('button[name="next"]').click();
          await expectCount(panel, 1, 3);
          await panel.locator('button[name="close"]').click();
          await page
            .getByRole("button", {
              name:
                pane === "input" ? "独占查看原始输入" : "独占查看格式化结果",
              exact: true,
            })
            .click();
          const focused = await openSearch(page, pane, "alpha");
          await expectCount(focused, 0, 3);
          await assertContained(focused);
          if (pane === "input") {
            const before = await editorGeometry(page, pane);
            await focused.locator('button[name="toggleReplace"]').click();
            await focused.locator(".cm-search-replace").waitFor();
            await assertContained(focused);
            await assertAlignedInputs(focused);
            assertGeometryUnchanged(
              before,
              await editorGeometry(page, pane),
              "Compact focused replacement expansion",
            );
          }
          await focused.locator('button[name="next"]').click();
          await expectCount(focused, 1, 3);
          await page.screenshot({
            path: path.join(screenshots, `search-dark-${pane}-focused.png`),
          });
          await page.keyboard.press("Escape");
          await focused.waitFor({ state: "hidden" });
          assert.equal(
            await page
              .locator(".application")
              .getAttribute("data-focused-pane"),
            pane,
          );
          if (await page.evaluate(() => Boolean(getSelection()?.toString()))) {
            await page.keyboard.press("Escape");
            await poll(
              () => page.evaluate(() => getSelection()?.toString() || ""),
              (value) => value === "",
              "Native Escape did not collapse the selected search match",
            );
            assert.equal(
              await page
                .locator(".application")
                .getAttribute("data-focused-pane"),
              pane,
              "Collapsing a search selection also exited the focused editor",
            );
          }
          await page.keyboard.press("Escape");
          await poll(
            () =>
              page.locator(".application").getAttribute("data-focused-pane"),
            (value) => value === null,
            "Escape with no panel or selection did not restore both editors",
          );
        }
      },
    );

    await t.test(
      "keeps long queries readable beside content-sized bilingual counters",
      async () => {
        const query = "feature_flag_allowed_nodes_context_json";
        await prepare(
          page,
          JSON.stringify({ values: Array.from({ length: 6 }, () => query) }),
        );
        for (const language of ["en", "zh-CN"] as const) {
          await page
            .getByRole("button", { name: /^(应用设置|Settings)$/ })
            .click();
          await page
            .locator(".workspace-settings-theme [role=combobox]")
            .nth(1)
            .click();
          await page
            .getByRole("option", {
              name: language === "en" ? "English" : "简体中文",
              exact: true,
            })
            .click();
          await poll(
            () => page.locator("html").getAttribute("lang"),
            (value) => value === language,
            "The search layout fixture did not switch its real UI language",
          );
          await page.locator(".workspace-settings-back").click();
          for (const layout of ["split", "focused", "compact"] as const) {
            const width = layout === "compact" ? 780 : 1440;
            await application.evaluate(({ BrowserWindow }, width) => {
              BrowserWindow.getAllWindows()[0].setContentSize(width, 820);
            }, width);
            await poll(
              () => page.evaluate(() => innerWidth),
              (value) => value === width,
              "The native window did not reach the search layout width",
            );
            if (layout === "focused")
              await page.locator('[data-focus-toggle="input"]').click();
            const panel = await openSearch(page, "input", query);
            await expectCount(panel, 0, 6);
            const sizes = await assertReadableQuery(
              panel,
              layout === "compact" ? 80 : 120,
            );
            assert.ok(
              sizes.countWidth < 32,
              `A six-match counter reserves unused width: ${JSON.stringify(sizes)}`,
            );
            assert.equal(
              await panel.locator('input[name="search"]').inputValue(),
              query,
            );
            await assertContained(panel);
            await panel.locator('button[name="toggleReplace"]').click();
            await panel.locator(".cm-search-replace").waitFor();
            await assertAlignedInputs(panel);
            await page.screenshot({
              path: path.join(
                screenshots,
                `search-readable-${language}-${layout}.png`,
              ),
            });
            await closePanels(page);
            if (layout === "focused")
              await page.locator('[data-focus-toggle="input"]').click();
          }
        }
        await application.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 820);
        });
        await prepare(
          page,
          JSON.stringify({ value: "needle ".repeat(12_345) }),
          false,
        );
        const panel = await openSearch(page, "input", "needle");
        await expectCount(panel, 0, 12_345);
        await panel.locator('button[name="prev"]').click();
        await expectCount(panel, 12_345, 12_345);
        await assertReadableQuery(panel, 80);
        assert.match(
          (await panel.locator(".cm-search-count").getAttribute("title")) ?? "",
          /12,345/,
        );
        await closePanels(page);
      },
    );

    await t.test("finishes search workflows without renderer errors", () => {
      assert.deepEqual(errors, []);
    });
  },
);
