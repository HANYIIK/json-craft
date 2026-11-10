import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Locator, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 12_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

async function dimensions(owner: Locator) {
  return owner.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      offsetWidth: (element as HTMLElement).offsetWidth,
      offsetHeight: (element as HTMLElement).offsetHeight,
      borderWidth:
        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth),
      borderHeight:
        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
      scrollbarWidth: style.scrollbarWidth,
      scrollbarGutter: style.scrollbarGutter,
    };
  });
}

async function noNativeGutter(owner: Locator) {
  const size = await dimensions(owner);
  assert.equal(size.scrollbarWidth, "none");
  assert.equal(size.scrollbarGutter, "auto");
  assert.ok(
    Math.abs(size.offsetWidth - size.clientWidth - size.borderWidth) <= 2,
    `A vertical native scrollbar still occupies layout space: ${JSON.stringify(size)}`,
  );
  assert.ok(
    Math.abs(size.offsetHeight - size.clientHeight - size.borderHeight) <= 2,
    `A horizontal native scrollbar still occupies layout space: ${JSON.stringify(size)}`,
  );
  return size;
}

async function hoverOwner(page: Page, owner: Locator, axis: "x" | "y" = "y") {
  const handle = await owner.elementHandle();
  assert.ok(handle, "The original scroll element is missing");
  const bounds = await owner.boundingBox();
  assert.ok(bounds, "The scroll element is not visible");
  await owner.hover({
    position: { x: Math.max(8, bounds.width - 20), y: bounds.height / 2 },
  });
  const overlay = page.getByTestId("overlay-scrollbars");
  await poll(
    () =>
      overlay
        .locator(`[data-axis="${axis}"]`)
        .evaluate(
          (element, expected) =>
            !(element as HTMLElement).hidden &&
            Reflect.get(element, "scrollOwner") === expected,
          handle,
        ),
    Boolean,
    "The overlay did not select exactly the hovered native scroll owner",
  );
  await overlay.locator(`[data-axis="${axis}"]`).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("overlay-scrollbars").count(), 1);
  return overlay;
}

async function leaveScrollArea(page: Page) {
  await page.mouse.move(650, 18);
  await poll(
    () =>
      page
        .getByTestId("overlay-scrollbars")
        .evaluate(
          (element) =>
            (element as HTMLElement).hidden &&
            Reflect.get(element, "scrollOwner") === null,
        ),
    Boolean,
    "The previous scroll owner left a visible or retained overlay",
  );
}

async function exerciseAxis(page: Page, owner: Locator, axis: "x" | "y") {
  const read = () =>
    owner.evaluate(
      (element, coordinate) =>
        coordinate === "x" ? element.scrollLeft : element.scrollTop,
      axis,
    );
  const reset = () =>
    owner.evaluate((element, coordinate) => {
      if (coordinate === "x") element.scrollLeft = 0;
      else element.scrollTop = 0;
    }, axis);
  await reset();
  const overlay = await hoverOwner(page, owner, axis);
  const track = overlay.locator(`[data-axis="${axis}"]`);
  const thumb = track.getByTestId("overlay-scrollbar-thumb");
  const before = await read();
  await page.mouse.wheel(axis === "x" ? 300 : 0, axis === "y" ? 300 : 0);
  await poll(
    read,
    (value) => value > before,
    `Native ${axis}-axis wheel input did not scroll its original element`,
  );
  await reset();
  await hoverOwner(page, owner, axis);
  await poll(
    () => thumb.boundingBox(),
    (value) => Boolean(value && value.width > 0 && value.height > 0),
    "The overlay thumb has no draggable bounds",
  );
  const thumbBounds = await thumb.boundingBox();
  const trackBounds = await track.boundingBox();
  assert.ok(thumbBounds && trackBounds, "The overlay track disappeared");
  await page.mouse.move(
    thumbBounds.x + thumbBounds.width / 2,
    thumbBounds.y + thumbBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    axis === "x"
      ? trackBounds.x + trackBounds.width * 0.7
      : thumbBounds.x + thumbBounds.width / 2,
    axis === "y"
      ? trackBounds.y + trackBounds.height * 0.7
      : thumbBounds.y + thumbBounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await poll(
    read,
    (value) => value > 0,
    `Dragging the ${axis}-axis overlay thumb did not move its owner`,
  );
  await reset();
  await hoverOwner(page, owner, axis);
  const clickBounds = await track.boundingBox();
  assert.ok(clickBounds, "The overlay track disappeared before clicking");
  await page.mouse.click(
    clickBounds.x + clickBounds.width * (axis === "x" ? 0.9 : 0.5),
    clickBounds.y + clickBounds.height * (axis === "y" ? 0.9 : 0.5),
  );
  await poll(
    read,
    (value) => value > 0,
    `Clicking the ${axis}-axis overlay track did not move its owner`,
  );
}

async function paste(page: Page, testId: string, text: string) {
  const content = page.getByTestId(testId).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  await content.evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, text);
}

test(
  "Electron overlay scrollbars occupy no layout space and follow their real scroll owners",
  { timeout: 180_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-scrollbars-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const rows = Array.from({ length: 180 }, (_, index) => ({
      id: index,
      text: `row-${index}-${"scrollbar-layout ".repeat(180)}`,
    }));
    const raw = JSON.stringify({ name: "Scrollbar fixture", rows }, null, 2);
    const records: HistoryRecord[] = Array.from({ length: 18 }, (_, index) => ({
      id: `scrollbar-${index}`,
      name: `scrollbar-${index}.json`,
      raw: index === 0 ? raw : JSON.stringify({ index, synthetic: true }),
      source: "sample",
      options: { indent: "2", autoUnescape: true, repair: true },
      createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    config.initialized = true;
    config.activeId = records[0].id;
    config.settings.theme = "light";
    config.settings.language = "en";
    config.settings.autoCopy = false;
    await Promise.all(
      records.map((record) =>
        writeFile(
          path.join(
            config.settings.historyDirectory,
            `history-${record.id}.json`,
          ),
          JSON.stringify(record),
        ),
      ),
    );
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
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Renderer crashed"));
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1360, 820);
      window.show();
      window.focus();
    });
    await page.getByTestId("input-editor").locator(".cm-content").waitFor();
    await poll(
      () =>
        page
          .getByRole("button", { name: "New input", exact: true })
          .isEnabled(),
      Boolean,
      "The isolated workspace did not become ready",
    );
    const history = page.locator(".file-list");
    const input = page.getByTestId("input-editor").locator(".cm-scroller");

    await t.test(
      "history hover, wheel, thumb and track affect only history",
      async () => {
        await leaveScrollArea(page);
        const before = await noNativeGutter(history);
        const inputTop = await input.evaluate((element) => element.scrollTop);
        const historyOverlay = await hoverOwner(page, history);
        const railEdge = await historyOverlay
          .locator('[data-axis="y"]')
          .boundingBox();
        const sidebarEdge = await page
          .locator("#workspace-sidebar")
          .boundingBox();
        assert.ok(railEdge && sidebarEdge, "History scrollbar is missing");
        assert.ok(
          Math.abs(
            railEdge.x +
              railEdge.width -
              (sidebarEdge.x + sidebarEdge.width - 1),
          ) <= 1,
          "History scrollbar leaves an unused strip inside the sidebar edge",
        );
        assert.deepEqual(await dimensions(history), before);
        await exerciseAxis(page, history, "y");
        assert.equal(
          await input.evaluate((element) => element.scrollTop),
          inputTop,
        );
        await leaveScrollArea(page);
        assert.deepEqual(await dimensions(history), before);
      },
    );

    await t.test(
      "both editor axes overlay content without reserving a gutter",
      async () => {
        const wrap = page.getByRole("button", {
          name: "Word wrap",
          exact: true,
        });
        if ((await wrap.getAttribute("aria-pressed")) === "true")
          await wrap.click();
        await poll(
          () =>
            input.evaluate(
              (element) => element.scrollWidth - element.clientWidth,
            ),
          (value) => value > 100,
          "The long JSON fixture did not expose horizontal editor scrolling",
        );
        await leaveScrollArea(page);
        const before = await noNativeGutter(input);
        const historyTop = await history.evaluate(
          (element) => element.scrollTop,
        );
        await hoverOwner(page, input);
        assert.deepEqual(await dimensions(input), before);
        await exerciseAxis(page, input, "y");
        await exerciseAxis(page, input, "x");
        assert.equal(
          await history.evaluate((element) => element.scrollTop),
          historyTop,
        );
        assert.deepEqual(await dimensions(input), before);
        await leaveScrollArea(page);
        assert.deepEqual(await dimensions(input), before);
      },
    );

    await t.test(
      "settings own their overlay and switch its palette immediately",
      async () => {
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        const settings = page.locator(".workspace-settings");
        await settings.waitFor();
        await leaveScrollArea(page);
        const before = await noNativeGutter(settings);
        const overlay = await hoverOwner(page, settings);
        assert.deepEqual(await dimensions(settings), before);
        const light = await overlay
          .locator('[data-axis="y"]')
          .getByTestId("overlay-scrollbar-thumb")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        await exerciseAxis(page, settings, "y");
        await settings.evaluate((element) => (element.scrollTop = 0));
        await page
          .getByRole("combobox", { name: "Theme", exact: true })
          .click();
        await page.getByRole("option", { name: "Dark", exact: true }).click();
        await poll(
          () => page.locator("html").getAttribute("data-theme"),
          (value) => value === "dark",
          "The dark theme did not apply to the scrollbar fixture",
        );
        await hoverOwner(page, settings);
        const dark = await overlay
          .locator('[data-axis="y"]')
          .getByTestId("overlay-scrollbar-thumb")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        assert.notEqual(light, "rgba(0, 0, 0, 0)");
        assert.notEqual(dark, "rgba(0, 0, 0, 0)");
        assert.notEqual(dark, light);
        assert.deepEqual(await dimensions(settings), before);
        await page.locator(".workspace-settings-back").click();
        await leaveScrollArea(page);
        assert.equal(await settings.count(), 0);
      },
    );

    await t.test(
      "diff scrolling keeps its native owner and clears on route changes",
      async () => {
        await page.getByTestId("open-comparison").click();
        const diffRows = rows.map(({ id }) => ({
          id,
          text: `diff-row-${id}-${"wide ".repeat(80)}`,
        }));
        const reference = { title: "before", rows: diffRows };
        const changed = {
          title: "after",
          rows: diffRows.map((row) => ({ ...row })),
        };
        changed.rows[175].text = "changed";
        await paste(page, "comparison-left", JSON.stringify(reference));
        await paste(page, "comparison-right", JSON.stringify(changed));
        const compare = page.getByTestId("compare-json");
        await poll(
          () => compare.isEnabled(),
          Boolean,
          "Comparison inputs did not finish formatting",
        );
        await compare.click();
        await page.getByTestId("comparison-result").waitFor();
        await poll(
          () =>
            page
              .getByTestId("repair-diff-editor")
              .getAttribute("data-difference-count"),
          (value) => Number(value) >= 2,
          "The diff editor did not finish computing the fixture",
        );
        await page.getByTestId("comparison-full-file").click();
        const diff = page
          .getByTestId("repair-diff-editor")
          .locator(".cm-mergeView");
        await poll(
          () =>
            diff.evaluate(
              (element) => element.scrollHeight - element.clientHeight,
            ),
          (value) => value > 100,
          "Full-file diff did not expose its original vertical scroll container",
        );
        await leaveScrollArea(page);
        const before = await noNativeGutter(diff);
        await hoverOwner(page, diff);
        assert.deepEqual(await dimensions(diff), before);
        await exerciseAxis(page, diff, "y");
        assert.deepEqual(await dimensions(diff), before);
        await page.getByTestId("comparison-back").click();
        await leaveScrollArea(page);
        assert.equal(await diff.count(), 0);
        assert.equal(await page.getByTestId("overlay-scrollbars").count(), 1);
      },
    );

    await t.test(
      "resize and sidebar hiding leave no stale tracks or owner",
      async () => {
        await hoverOwner(page, history);
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1180, 700),
        );
        const overlay = await hoverOwner(page, history);
        const ownerBounds = await history.boundingBox();
        const trackBounds = await overlay
          .locator('[data-axis="y"]')
          .boundingBox();
        assert.ok(
          ownerBounds && trackBounds,
          "Resizing removed an active track",
        );
        assert.ok(trackBounds.x >= ownerBounds.x - 1);
        assert.ok(trackBounds.y >= ownerBounds.y - 1);
        assert.ok(
          trackBounds.x + trackBounds.width <=
            ownerBounds.x + ownerBounds.width + 1,
        );
        assert.ok(
          trackBounds.y + trackBounds.height <=
            ownerBounds.y + ownerBounds.height + 1,
        );
        await noNativeGutter(history);
        await page
          .locator('.titlebar-navigation [aria-controls="workspace-sidebar"]')
          .click();
        await poll(
          () => history.isVisible(),
          (value) => !value,
          "The sidebar did not collapse",
        );
        await leaveScrollArea(page);
        await page
          .locator('.titlebar-navigation [aria-controls="workspace-sidebar"]')
          .click();
        await poll(
          () => history.isVisible(),
          Boolean,
          "The sidebar did not expand",
        );
        await hoverOwner(page, history);
        await noNativeGutter(history);
        await leaveScrollArea(page);
      },
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.desktop!.workspace.load()).records.length,
      ),
      records.length,
    );
    assert.deepEqual(errors, []);
  },
);
