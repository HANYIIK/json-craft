import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = path.join(projectRoot, "output", "playwright");
const markers = ["PROJECTED_BEGIN", "PROJECTED_MIDDLE", "PROJECTED_END"];
const crossSegment = `CROSS_SEGMENT_${Array.from(
  { length: 100 },
  (_, index) => `${index.toString(36).padStart(2, "0")}z`,
).join("")}_${"boundary_match_".repeat(80)}_FINISHED`;
const repeatedNeedle = `SOURCE_MULTI_SELECT_${"across_rows_".repeat(110)}_END`;

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
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 1_000)}`);
}

function documents(insert: boolean) {
  const repeated = 'synthetic 中文 "quoted JSON" with \\escaped\\ paths ';
  const prefix = repeated.repeat(800);
  const suffix = repeated.repeat(800);
  const inserted = 'different \\"density\\" 中文 \\\\ '.repeat(650);
  const catalog = (extra: string) =>
    JSON.stringify({
      catalog:
        markers[0] +
        prefix +
        repeatedNeedle +
        crossSegment +
        markers[1] +
        extra +
        suffix +
        repeatedNeedle +
        markers[2],
    });
  const headers = Array.from({ length: 20 }, (_, index) => `header_${index}`);
  const left = { headers, payload: catalog(""), tail: true };
  const right = {
    headers,
    payload: insert
      ? catalog(inserted)
      : catalog("").replace(markers[2], `${markers[2]}X`),
    tail: true,
  };
  return {
    left: JSON.stringify(left, null, 2),
    right: JSON.stringify(right, null, 2),
    reorderedRight: JSON.stringify({
      tail: right.tail,
      payload: right.payload,
      headers: right.headers,
    }),
  };
}

async function replaceInput(page: Page, side: "left" | "right", raw: string) {
  const content = page.getByTestId(`comparison-${side}`).locator(".cm-content");
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

async function compare(page: Page) {
  const button = page.getByTestId("compare-json");
  await poll(
    () => button.isEnabled(),
    Boolean,
    "The real formatter did not finish processing both long-line inputs",
  );
  await button.click();
  await page.getByTestId("comparison-result").waitFor();
  await poll(
    () =>
      page
        .getByTestId("repair-diff-editor")
        .getAttribute("data-difference-count"),
    (value) => value !== null,
    "The real key-alignment and diff pipeline did not initialize",
  );
}

async function copiedSelection(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  const search = page
    .getByTestId(`diff-${side}-panels`)
    .locator('input[name="search"]');
  const searching = await search.count();
  if (searching) await search.press("Escape");
  await content.focus();
  const copied = await content.evaluate((element) => {
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
  if (searching) await content.press("ControlOrMeta+f");
  return copied;
}

async function copyDigest(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const copied = await copiedSelection(page, side);
  await content.press("ArrowLeft");
  return createHash("sha256").update(copied).digest("hex");
}

async function markerGeometry(
  page: Page,
  side: "before" | "after",
  marker: string,
) {
  return page.getByTestId("repair-diff-editor").evaluate(
    (host, { side, marker }) => {
      const viewport = host
        .querySelector(".cm-mergeView")!
        .getBoundingClientRect();
      const pane = host.querySelector(`[data-testid="diff-${side}"]`)!;
      const bounds = pane.getBoundingClientRect();
      const content = pane.querySelector(".cm-content")!;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const text = nodes.map((node) => node.data).join("");
      const offset = text.indexOf(marker);
      const positions = {
        endpoint(offset: number): [Text, number] {
          for (const node of nodes) {
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
          }
          throw new Error("The projected marker endpoint is not rendered");
        },
      };
      const range = document.createRange();
      if (offset >= 0) {
        range.setStart(...positions.endpoint(offset));
        range.setEnd(...positions.endpoint(offset + marker.length));
      }
      const rectangles =
        offset < 0
          ? []
          : Array.from(range.getClientRects()).filter(
              (rect) => rect.width > 0 && rect.height > 0,
            );
      return {
        found: offset >= 0,
        bounds: {
          left: Math.max(viewport.left, bounds.left),
          right: Math.min(viewport.right, bounds.right),
          top: viewport.top,
          bottom: viewport.bottom,
        },
        rectangles: rectangles.map((rect) => ({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        })),
        scrollLeft: pane.querySelector(".cm-scroller")!.scrollLeft,
        visible:
          rectangles.length > 0 &&
          rectangles.every(
            (rect) =>
              rect.top >= viewport.top - 1 &&
              rect.bottom <= viewport.bottom + 1 &&
              rect.left >= Math.max(viewport.left, bounds.left) - 1 &&
              rect.right <= Math.min(viewport.right, bounds.right) + 1,
          ),
        nodes: content.querySelectorAll("*").length,
        characters: content.textContent?.length ?? 0,
      };
    },
    { side, marker },
  );
}

async function openSearch(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+f");
  const panel = page.getByTestId(`diff-${side}-panels`);
  const field = panel.locator('input[name="search"]');
  await field.waitFor();
  return { panel, field };
}

async function searchMarker(
  page: Page,
  side: "before" | "after",
  marker: string,
) {
  const { panel, field } = await openSearch(page, side);
  await panel.locator('input[name="re"]').uncheck();
  await field.fill(marker);
  await field.press("Enter");
  await poll(
    () => markerGeometry(page, side, marker),
    (value) =>
      value.found &&
      value.visible &&
      value.nodes < 4_000 &&
      value.characters < 60_000,
    `${side}: the selected source marker was hidden by a long-line gap`,
  );
  await poll(
    () => panel.locator(".cm-search-count").textContent(),
    (value) => value?.replace(/\s/g, "") === "1/1",
    `${side}: the source marker search count is incorrect`,
  );
  await field.press("Escape");
}

async function idleMutations(page: Page) {
  return page.getByTestId("repair-diff-editor").evaluate(async (host) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    observer.disconnect();
    return mutations;
  });
}

test(
  "real comparison renders asymmetric escaped long lines with lossless projected search and copy",
  { timeout: 120_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-diff-projection-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.settings.theme = "dark";
    config.settings.recursiveUnescape = false;
    await writeFile(configPath, JSON.stringify(config));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.env.JSON_CRAFT_DIFF_TEST_DEV !== "1")
      delete env.VITE_DEV_SERVER_URL;
    const application = await _electron.launch({
      args: [projectRoot, `--user-data-dir=${profile}`],
      cwd: projectRoot,
      env,
    });
    t.after(async () => {
      try {
        await application.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 200));
    });
    const resize = (width: number) =>
      application.evaluate(({ BrowserWindow, app }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setBackgroundThrottling(false);
        window.setContentSize(width, 950);
        window.show();
        app.focus({ steal: true });
        window.focus();
      }, width);
    await resize(1_440);
    await page.getByTestId("open-comparison").click();
    await page
      .getByRole("checkbox", { name: "递归去转义", exact: true })
      .uncheck();
    const fixture = documents(true);
    assert.ok(Buffer.byteLength(fixture.left) > 100_000);
    await replaceInput(page, "left", fixture.left);
    await replaceInput(page, "right", fixture.reorderedRight);
    const opened = performance.now();
    await compare(page);
    const openingMilliseconds = Math.round(performance.now() - opened);
    const host = page.getByTestId("repair-diff-editor");
    await poll(
      () => host.getAttribute("data-added-lines"),
      (value) => value === "1",
      "Projected visual rows were incorrectly counted as added source lines",
    );
    assert.equal(await host.getAttribute("data-removed-lines"), "1");
    await page.getByTestId("comparison-full-file").click();
    for (const side of ["before", "after"] as const)
      for (const marker of markers) await searchMarker(page, side, marker);

    await t.test(
      "searches source text across synthetic row boundaries",
      async () => {
        const { panel, field } = await openSearch(page, "after");
        await field.fill(crossSegment);
        await field.press("Enter");
        await poll(
          () => panel.locator(".cm-search-count").textContent(),
          (value) => value?.replace(/\s/g, "") === "1/1",
          "A literal spanning multiple projected rows was not found once",
        );
        assert.equal(await copiedSelection(page, "after"), crossSegment);
        await panel.locator('input[name="re"]').check();
        await field.fill("CROSS_SEGMENT_[a-z0-9_]+_FINISHED");
        await field.press("Enter");
        await poll(
          () => panel.locator(".cm-search-count").textContent(),
          (value) => value?.replace(/\s/g, "") === "1/1",
          "A regex spanning projected rows was not found once",
        );
        assert.equal(await copiedSelection(page, "after"), crossSegment);
        await field.fill("^.{1,1024}$");
        const originalShortLines = fixture.right
          .split("\n")
          .filter((line) => line.length > 0 && line.length <= 1_024).length;
        await poll(
          () => panel.locator(".cm-search-count").textContent(),
          (value) =>
            value?.replace(/\s/g, "").split("/")[1] ===
            String(originalShortLines),
          "Regex anchors treated synthetic display breaks as original newlines",
        );
        await field.press("Escape");
      },
    );

    await t.test("adds source occurrences across projected rows", async () => {
      const { panel, field } = await openSearch(page, "after");
      await panel.locator('input[name="re"]').uncheck();
      await field.fill(repeatedNeedle);
      await field.press("Enter");
      await poll(
        () => panel.locator(".cm-search-count").textContent(),
        (value) => /^[12]\/2$/.test(value?.replace(/\s/g, "") ?? ""),
        "The repeated source selection was not found twice",
      );
      await field.press("Escape");
      await page
        .getByTestId("diff-after")
        .locator(".cm-content")
        .press("ControlOrMeta+d");
      assert.equal(
        await copiedSelection(page, "after"),
        `${repeatedNeedle}\n${repeatedNeedle}`,
        "Selecting the next occurrence used synthetic row breaks",
      );
    });

    await t.test("jumps to original source line numbers", async () => {
      const content = page.getByTestId("diff-after").locator(".cm-content");
      await content.focus();
      await content.press("ControlOrMeta+Alt+g");
      const dialog = page
        .getByTestId("diff-after-panels")
        .locator(".cm-goto-line");
      const line = dialog.locator('input[name="line"]');
      await line.waitFor();
      await line.press("ControlOrMeta+Alt+g");
      assert.equal(
        await page.locator(".cm-goto-line").count(),
        1,
        "Repeating Go to line created a second dialog",
      );
      const originalLines = fixture.right.split("\n");
      await line.fill(String(originalLines.length));
      await line.press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.equal(
        await copiedSelection(page, "after"),
        originalLines.at(-1),
        "Go to line navigated to a projected row instead of the source line",
      );
    });

    await t.test(
      "preserves search and source selection through resize",
      async () => {
        await resize(1_440);
        const { panel, field } = await openSearch(page, "after");
        await panel.locator('input[name="re"]').uncheck();
        await field.fill(markers[2]);
        await field.press("Enter");
        await poll(
          () => markerGeometry(page, "after", markers[2]),
          (value) => value.found && value.visible,
          "The source target was not visible before resize",
        );
        await resize(780);
        await poll(
          async () => ({
            query: await field.inputValue(),
            count: await panel.locator(".cm-search-count").textContent(),
            geometry: await markerGeometry(page, "after", markers[2]),
          }),
          (value) =>
            value.query === markers[2] &&
            value.count?.replace(/\s/g, "") === "1/1" &&
            value.geometry.found &&
            value.geometry.visible,
          "Resize discarded the source search query, count or reading position",
        );
        await field.press("Escape");
        assert.equal(
          await copiedSelection(page, "after"),
          markers[2],
          "Resize discarded the original source selection",
        );
        await resize(1_440);
      },
    );

    for (const width of [780, 1_440]) {
      await resize(width);
      for (const side of ["before", "after"] as const)
        await searchMarker(page, side, markers[2]);
    }
    assert.ok(
      (await idleMutations(page)) < 20,
      "The projected diff kept rebuilding DOM while idle",
    );
    for (const side of ["before", "after"] as const)
      assert.equal(
        await copyDigest(page, side),
        createHash("sha256")
          .update(side === "before" ? fixture.left : fixture.right)
          .digest("hex"),
        `${side}: copied JSON contains synthetic row breaks or lost source data`,
      );
    await mkdir(artifacts, { recursive: true });
    await searchMarker(page, "after", markers[2]);
    await page.screenshot({
      path: path.join(artifacts, "repair-diff-projected-long-lines.png"),
    });

    await t.test(
      "retains source text with wrapping off and back on",
      async () => {
        for (const enabled of [false, true]) {
          await page.getByTestId("comparison-back").click();
          const toggle = page
            .getByTestId("comparison-page")
            .getByRole("button", { name: "自动换行", exact: true });
          if ((await toggle.getAttribute("aria-pressed")) !== String(enabled))
            await toggle.click();
          await compare(page);
          await page.getByTestId("comparison-full-file").click();
          await searchMarker(page, "after", markers[2]);
          assert.equal(
            await copyDigest(page, "after"),
            createHash("sha256").update(fixture.right).digest("hex"),
          );
        }
      },
    );

    await t.test(
      "does not invent changes after a single-character edit",
      async () => {
        await page.getByTestId("comparison-back").click();
        const single = documents(false);
        await replaceInput(page, "left", single.left);
        await replaceInput(page, "right", single.reorderedRight);
        await compare(page);
        assert.equal(await host.getAttribute("data-difference-count"), "1");
        assert.equal(await host.getAttribute("data-added-lines"), "1");
        assert.equal(await host.getAttribute("data-removed-lines"), "1");
        await page.getByTestId("comparison-full-file").click();
        for (const side of ["before", "after"] as const)
          await searchMarker(page, side, markers[2]);
      },
    );
    console.info(
      "Projected real comparison",
      JSON.stringify({
        sourceBytes: [fixture.left, fixture.right].map((value) =>
          Buffer.byteLength(value),
        ),
        openingMilliseconds,
        originalLineCountsPreserved: true,
        copyDigestsPreserved: true,
      }),
    );
    assert.deepEqual(errors, []);
  },
);
