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
const markers = [
  "ASCII_BUDGET_BEGIN",
  "ASCII_BUDGET_MIDDLE",
  "ASCII_BUDGET_END",
];

function fixture() {
  const unit = 'synthetic ASCII "quoted JSON" with \\escaped\\ paths ';
  const document = (repetitions: number) =>
    JSON.stringify(
      {
        payload: JSON.stringify({
          catalog:
            markers[0] +
            unit.repeat(Math.floor(repetitions / 2)) +
            markers[1] +
            unit.repeat(repetitions - Math.floor(repetitions / 2)) +
            markers[2],
        }),
        tail: true,
      },
      null,
      2,
    );
  const base = document(0).length;
  const encodedUnit = document(1).length - base;
  const repetitions = Math.floor((19 * 1024 * 1024 - base) / encodedUnit);
  const before = document(repetitions);
  const position = before.indexOf(markers[1]) + markers[1].length;
  assert.equal(before[position], "s");
  const after = before.slice(0, position) + "S" + before.slice(position + 1);
  assert.equal(Buffer.byteLength(before), before.length);
  assert.ok(before.length > 18.9 * 1024 * 1024);
  assert.ok(before.length < 20 * 1024 * 1024);
  return { before, after };
}

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 30_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(60);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 1_000)}`);
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
          throw new Error("The height-budget marker endpoint is not rendered");
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
        visible:
          rectangles.length > 0 &&
          rectangles.every(
            (rect) =>
              rect.top >= viewport.top - 1 &&
              rect.bottom <= viewport.bottom + 1 &&
              rect.left >= Math.max(viewport.left, bounds.left) - 1 &&
              rect.right <= Math.min(viewport.right, bounds.right) + 1,
          ),
        characters: content.textContent?.length ?? 0,
        nodes: content.querySelectorAll("*").length,
        scrollLeft: pane.querySelector(".cm-scroller")!.scrollLeft,
      };
    },
    { side, marker },
  );
}

async function searchMarker(
  page: Page,
  side: "before" | "after",
  marker: string,
) {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+f");
  const panel = page.getByTestId(`diff-${side}-panels`);
  const field = panel.locator('input[name="search"]');
  await field.fill(marker);
  await field.press("Enter");
  const geometry = await poll(
    () => markerGeometry(page, side, marker),
    (value) =>
      value.found &&
      value.visible &&
      value.characters < 180_000 &&
      value.nodes < 4_000,
    `${side}: the 19MiB source target is not visible within the bounded DOM`,
  );
  await poll(
    () => panel.locator(".cm-search-count").textContent(),
    (value) => value?.replace(/\s/g, "") === "1/1",
    `${side}: source search counted synthetic rows or lost the marker`,
  );
  await field.press("Escape");
  return geometry;
}

async function copyDigest(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const result = await content.evaluate(async (element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    const copied = data.getData("text/plain");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(copied),
    );
    return {
      length: copied.length,
      digest: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  });
  await content.press("ArrowLeft");
  return result;
}

test(
  "real 19MiB ASCII comparison falls back before browser height limits and restores wrapping when widened",
  { timeout: 180_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-diff-height-budget-"),
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
    page.setDefaultTimeout(40_000);
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
    await resize(780);
    await page.getByTestId("open-comparison").click();
    await page
      .getByRole("checkbox", { name: "递归去转义", exact: true })
      .uncheck();
    const documents = fixture();
    await replaceInput(page, "left", documents.before);
    await replaceInput(page, "right", documents.after);
    const compare = page.getByTestId("compare-json");
    await poll(
      () => compare.isEnabled(),
      Boolean,
      "The real formatter did not finish preparing both 19MiB inputs",
    );
    const started = performance.now();
    await compare.click();
    await page.getByTestId("comparison-result").waitFor();
    const host = page.getByTestId("repair-diff-editor");
    await poll(
      () => host.getAttribute("data-wrap-fallback"),
      (value) => value === "true",
      "The narrow 19MiB diff exceeded its browser height budget without fallback",
    );
    const openingMilliseconds = Math.round(performance.now() - started);
    const note = page.getByTestId("diff-rendering-note");
    assert.equal(await note.isVisible(), true);
    assert.equal(
      await note.textContent(),
      "内容较长，已分段显示，可横向滚动查看完整内容。",
    );
    assert.equal(await host.getAttribute("data-difference-count"), "1");
    assert.equal(await host.getAttribute("data-added-lines"), "1");
    assert.equal(await host.getAttribute("data-removed-lines"), "1");
    await page.getByTestId("comparison-full-file").click();
    const observations = [];
    for (const side of ["before", "after"] as const) {
      for (const marker of markers)
        observations.push(await searchMarker(page, side, marker));
      const copied = await copyDigest(page, side);
      assert.equal(copied.length, documents[side].length);
      assert.equal(
        copied.digest,
        createHash("sha256").update(documents[side]).digest("hex"),
        `${side}: the height fallback changed full copied JSON`,
      );
    }
    await searchMarker(page, "after", markers[2]);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, "repair-diff-ascii-height-fallback.png"),
    });
    await resize(1_440);
    await poll(
      () => host.getAttribute("data-wrap-fallback"),
      (value) => value === "false",
      "Widening did not restore normal wrapping below the safe height budget",
    );
    assert.notEqual(
      await note.textContent(),
      "内容较长，已分段显示，可横向滚动查看完整内容。",
      "The fallback note remained visible after normal wrapping resumed",
    );
    for (const side of ["before", "after"] as const) {
      observations.push(await searchMarker(page, side, markers[2]));
      const copied = await copyDigest(page, side);
      assert.equal(copied.length, documents[side].length);
      assert.equal(
        copied.digest,
        createHash("sha256").update(documents[side]).digest("hex"),
        `${side}: restoring wrapping changed full copied JSON`,
      );
    }
    console.info(
      "Real ASCII height-budget comparison",
      JSON.stringify({
        sourceBytes: documents.before.length,
        openingMilliseconds,
        maximumRenderedCharacters: Math.max(
          ...observations.map((value) => value.characters),
        ),
        maximumNodes: Math.max(...observations.map((value) => value.nodes)),
        sourceDigestsPreserved: true,
        wideWrappingRestored: true,
      }),
    );
    assert.deepEqual(errors, []);
  },
);
