import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
import type { ProcessingResult, RepairStage } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = path.join(projectRoot, "output", "playwright");

const marker = (id: string, part: "BEGIN" | "MIDDLE" | "END") =>
  `JSON_CRAFT_${id.toUpperCase()}_${part}`;

function fixture(
  id: string,
  repetitions: number,
  earlyChange: boolean,
): RepairStage {
  const content = 'synthetic 中文 escaped "JSON" content ';
  const middle = Math.floor(repetitions / 2);
  const after = JSON.stringify(
    {
      headers: Array.from({ length: 100 }, (_, index) => ({
        field: `field_${index}`,
        enabled: true,
      })),
      payload: JSON.stringify({
        catalog:
          marker(id, "BEGIN") +
          content.repeat(middle) +
          marker(id, "MIDDLE") +
          content.repeat(repetitions - middle) +
          marker(id, "END"),
      }),
      options: { temperature: 0, max_tokens: 12000, json_mode: false },
      cache_options: { enabled: false },
    },
    null,
    2,
  );
  const positions = [after.indexOf('},\n  "cache_options"') + 1];
  if (earlyChange) positions.unshift(after.indexOf("    },") + 5);
  let before = after;
  for (const position of [...positions].reverse())
    before = before.slice(0, position) + before.slice(position + 1);
  return {
    id,
    path: `$.${id}`,
    layer: 0,
    before,
    after,
    diffTruncated: false,
    changes: positions.map((position, index) => {
      const start = position - index;
      const prefix = before.slice(0, start).split("\n");
      return {
        id: `${id}-${index}`,
        stageId: id,
        label: "插入字符",
        before: "",
        after: ",",
        start,
        end: start,
        line: prefix.length,
        column: prefix.at(-1)!.length + 1,
        layer: 0,
      };
    }),
  };
}

function singleCharacterRepair(
  id: string,
  after: string,
  position: number,
  character: string,
): RepairStage {
  assert.ok(position >= 0);
  assert.equal(after[position], character);
  const before = after.slice(0, position) + after.slice(position + 1);
  assert.doesNotThrow(() => JSON.parse(after));
  assert.throws(() => JSON.parse(before));
  const prefix = before.slice(0, position).split("\n");
  return {
    id,
    path: `$.${id}`,
    layer: 0,
    before,
    after,
    diffTruncated: false,
    changes: [
      {
        id: `${id}-0`,
        stageId: id,
        label: "插入字符",
        before: "",
        after: character,
        start: position,
        end: position,
        line: prefix.length,
        column: prefix.at(-1)!.length + 1,
        layer: 0,
      },
    ],
  };
}

function sanityFixtures() {
  const id = "multiple_lines";
  const original = JSON.parse(fixture(id, 1_500, false).after);
  const extra = (name: string) =>
    JSON.stringify({
      catalog:
        marker(name, "BEGIN") +
        'additional 中文 escaped "JSON" content '.repeat(350) +
        marker(name, "MIDDLE") +
        'additional 中文 escaped "JSON" content '.repeat(350) +
        marker(name, "END"),
    });
  const multiple = JSON.stringify(
    {
      headers: original.headers,
      prior_payload: extra(`${id}_prior`),
      payload: original.payload,
      later_payload: extra(`${id}_later`),
      options: original.options,
      cache_options: original.cache_options,
    },
    null,
    2,
  );
  assert.equal(
    multiple.split("\n").filter((line) => line.length >= 20_000).length,
    3,
  );
  const changed = fixture("changed_long_line", 2_500, false).after;
  const slash = changed.indexOf(String.raw`\\\"JSON`);
  const result = [
    singleCharacterRepair(
      id,
      multiple,
      multiple.indexOf('},\n  "cache_options"') + 1,
      ",",
    ),
    singleCharacterRepair("changed_long_line", changed, slash, "\\"),
  ];
  assert.ok(
    result[1].before.split("\n")[result[1].changes[0].line - 1].length >=
      20_000,
  );
  return result;
}

async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 8_000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function coverage(page: Page) {
  return page.getByTestId("repair-diff-editor").evaluate((host) => {
    const viewport = host
      .querySelector(".cm-mergeView")!
      .getBoundingClientRect();
    return ["before", "after"].map((side) => {
      const content = host.querySelector(
        `[data-testid="diff-${side}"] .cm-content`,
      )!;
      const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const intervals: [number, number][] = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.length) continue;
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects())
          if (
            rect.width > 0 &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom
          )
            intervals.push([
              Math.max(0, rect.top - viewport.top),
              Math.min(viewport.height, rect.bottom - viewport.top),
            ]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      let end = 0,
        blank = 0;
      for (const [from, to] of intervals) {
        blank = Math.max(blank, from - end);
        end = Math.max(end, to);
      }
      blank = Math.max(blank, viewport.height - end);
      return {
        side,
        blank,
        lineHeight,
        rectangles: intervals.length,
        height: viewport.height,
        nodes: content.querySelectorAll("*").length,
        characters: content.textContent?.length ?? 0,
        largestSpacer: Math.max(
          0,
          ...Array.from(
            content.querySelectorAll(".cm-mergeSpacer"),
            (node) => node.getBoundingClientRect().height,
          ),
        ),
      };
    });
  });
}

async function expectFilled(page: Page, phase: string) {
  const value = await poll(
    () => coverage(page),
    (sides) =>
      sides.every(
        (side) =>
          side.rectangles > 0 &&
          side.blank < side.lineHeight * 4 + 5 &&
          side.largestSpacer < side.height / 2 &&
          side.characters < 180_000 &&
          side.nodes < 4_000,
      ),
    `${phase}: a virtual alignment spacer hid the JSON viewport`,
  );
  observations.push(...value);
  return value;
}

async function markerGeometry(page: Page, value: string) {
  return page.getByTestId("repair-diff-editor").evaluate((host, marker) => {
    const viewport = host
      .querySelector(".cm-mergeView")!
      .getBoundingClientRect();
    return ["before", "after"].map((side) => {
      const pane = host.querySelector(`[data-testid="diff-${side}"]`)!;
      const content = pane.querySelector(".cm-content")!;
      const bounds = pane.getBoundingClientRect();
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
          throw new Error("The rendered marker endpoint was not found");
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
          : Array.from(range.getClientRects())
              .filter((rect) => rect.width > 0 && rect.height > 0)
              .map((rect) => ({
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              }));
      return {
        side,
        found: offset >= 0,
        rectangles,
        intersectsViewport: rectangles.some(
          (rect) =>
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom &&
            rect.right > Math.max(viewport.left, bounds.left) &&
            rect.left < Math.min(viewport.right, bounds.right),
        ),
        visible:
          rectangles.length > 0 &&
          rectangles.every(
            (rect) =>
              rect.top >= viewport.top - 1 &&
              rect.bottom <= viewport.bottom + 1 &&
              rect.left >= Math.max(viewport.left, bounds.left) - 1 &&
              rect.right <= Math.min(viewport.right, bounds.right) + 1,
          ),
      };
    });
  }, value);
}

async function searchLongLine(page: Page, stage: RepairStage, width: number) {
  const after = page.getByTestId("diff-after").locator(".cm-content");
  await after.focus();
  await after.press("ControlOrMeta+f");
  const panel = page.getByTestId("diff-after-panels");
  const search = panel.locator('.cm-search input[name="search"]');
  await search.waitFor();
  assert.equal(
    await page.getByTestId("diff-before-panels").locator(".cm-search").count(),
    0,
  );
  for (const part of ["MIDDLE", "END"] as const) {
    const value = marker(stage.id, part);
    assert.equal(stage.before.split(value).length, 2);
    assert.equal(stage.after.split(value).length, 2);
    await search.fill(value);
    await search.press("Enter");
    await poll(
      () => markerGeometry(page, value),
      (sides) => sides.every((side) => side.found && side.visible),
      `${stage.id}: right-only ${part} search at ${width} hid the actual target characters`,
    );
    await expectFilled(
      page,
      `${stage.id}: right-only ${part} search at ${width}`,
    );
  }
  await search.press("Escape");
  assert.equal(await panel.locator(".cm-search").count(), 0);
  assert.equal(
    await page.locator(".application").getAttribute("data-page"),
    "diff",
  );
  await wheelAwayFromSearch(page, stage, width);
}

async function wheelAwayFromSearch(
  page: Page,
  stage: RepairStage,
  width: number,
) {
  const scroller = page.locator(".cm-mergeView");
  const position = await scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const pane = element
      .querySelector('[data-testid="diff-after"]')!
      .getBoundingClientRect();
    return {
      top: element.scrollTop,
      height: element.clientHeight,
      x: (pane.left + pane.right) / 2,
      y: (viewport.top + viewport.bottom) / 2,
    };
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.wheel(0, -position.height * 1.5);
  await poll(
    () => scroller.evaluate((element) => element.scrollTop),
    (top) => position.top - top > position.height * 0.75,
    `${stage.id}: the native wheel did not leave the old END search at ${width}`,
  );
  const end = marker(stage.id, "END");
  await poll(
    () => markerGeometry(page, end),
    (sides) => sides.every((side) => !side.intersectsViewport),
    `${stage.id}: the native wheel kept the old END search in view at ${width}`,
  );
  await expectFilled(
    page,
    `${stage.id}: native wheel away from END at ${width}`,
  );
  for (let sample = 0; sample < 8; sample++) {
    await delay(80);
    const sides = await markerGeometry(page, end);
    assert.ok(
      sides.every((side) => !side.intersectsViewport),
      `${stage.id}: recovery jumped back to the old END search after the native wheel at ${width}: ${JSON.stringify(sides)}`,
    );
  }
  await expectFilled(
    page,
    `${stage.id}: retain native wheel reading position at ${width}`,
  );
}

const observations: Awaited<ReturnType<typeof coverage>> = [];

async function monitorTextPeaks(page: Page) {
  await page.evaluate(() => {
    const createDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "createTextNode",
    )!;
    const dataDescriptor = Object.getOwnPropertyDescriptor(
      CharacterData.prototype,
      "data",
    )!;
    const valueDescriptor = Object.getOwnPropertyDescriptor(
      Node.prototype,
      "nodeValue",
    )!;
    const probe = {
      maximumTextNodeLength: 0,
      before: 0,
      after: 0,
      sample() {
        for (const side of ["before", "after"] as const) {
          const content = document.querySelector(
            `[data-testid="diff-${side}"] .cm-content`,
          );
          if (!content) continue;
          const walker = document.createTreeWalker(
            content,
            NodeFilter.SHOW_TEXT,
          );
          let characters = 0;
          while (walker.nextNode()) {
            const length = (walker.currentNode as Text).length;
            characters += length;
            this.maximumTextNodeLength = Math.max(
              this.maximumTextNodeLength,
              length,
            );
          }
          this[side] = Math.max(this[side], characters);
        }
      },
      stop() {
        observer.disconnect();
        Object.defineProperty(
          Document.prototype,
          "createTextNode",
          createDescriptor,
        );
        Object.defineProperty(CharacterData.prototype, "data", dataDescriptor);
        Object.defineProperty(Node.prototype, "nodeValue", valueDescriptor);
      },
    };
    const methods = {
      createTextNode(
        this: Document,
        ...args: Parameters<Document["createTextNode"]>
      ) {
        const node = Reflect.apply(createDescriptor.value, this, args) as Text;
        probe.maximumTextNodeLength = Math.max(
          probe.maximumTextNodeLength,
          node.length,
        );
        return node;
      },
      setData(this: CharacterData, value: string) {
        Reflect.apply(dataDescriptor.set!, this, [value]);
        if (this.nodeType === Node.TEXT_NODE)
          probe.maximumTextNodeLength = Math.max(
            probe.maximumTextNodeLength,
            this.length,
          );
      },
      setNodeValue(this: Node, value: string | null) {
        Reflect.apply(valueDescriptor.set!, this, [value]);
        if (this.nodeType === Node.TEXT_NODE)
          probe.maximumTextNodeLength = Math.max(
            probe.maximumTextNodeLength,
            this.nodeValue?.length ?? 0,
          );
      },
    };
    Object.defineProperty(Document.prototype, "createTextNode", {
      ...createDescriptor,
      value: methods.createTextNode,
    });
    Object.defineProperty(CharacterData.prototype, "data", {
      ...dataDescriptor,
      set: methods.setData,
    });
    Object.defineProperty(Node.prototype, "nodeValue", {
      ...valueDescriptor,
      set: methods.setNodeValue,
    });
    const observer = new MutationObserver(() => probe.sample());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    Reflect.set(window, "__jsonCraftDiffTextPeaks", probe);
  });
}

async function textPeaks(page: Page, stop = false) {
  return page.evaluate((stop) => {
    const probe = Reflect.get(window, "__jsonCraftDiffTextPeaks") as {
      maximumTextNodeLength: number;
      before: number;
      after: number;
      sample(): void;
      stop(): void;
    };
    probe.sample();
    const peaks = {
      maximumTextNodeLength: probe.maximumTextNodeLength,
      before: probe.before,
      after: probe.after,
    };
    if (stop) {
      probe.stop();
      Reflect.deleteProperty(window, "__jsonCraftDiffTextPeaks");
    }
    return peaks;
  }, stop);
}

async function copyDigest(page: Page, side: string) {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const value = await content.evaluate((element) => {
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
  return createHash("sha256").update(value).digest("hex");
}

test(
  "Electron keeps both long-line diff viewports populated during navigation, full view, scrolling and resize",
  { timeout: 180_000 },
  async (t) => {
    const started = performance.now();
    const trace = (
      stage: string,
      phase: string,
      width?: number,
      state?: {
        visibility?: string;
        rendererFocused?: boolean;
        isFocused?: boolean;
        isVisible?: boolean;
        backgroundThrottling?: boolean;
      },
    ) => {
      if (process.env.JSON_CRAFT_DIFF_STRESS === "1")
        console.info(
          "Large diff stress phase",
          JSON.stringify({
            stage,
            phase,
            width,
            ...state,
            elapsedMilliseconds: Math.round(performance.now() - started),
          }),
        );
    };
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-diff-large-"),
    );
    await mkdir(artifacts, { recursive: true });
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.settings.theme = "dark";
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
    const windowId = await (
      await application.browserWindow(page)
    ).evaluate((window) => window.id as number);
    const focusWindow = (size?: { width: number; height: number }) =>
      application.evaluate(
        ({ BrowserWindow, app }, { windowId, size }) => {
          const window = BrowserWindow.fromId(windowId);
          if (!window) throw new Error("The isolated diff window is closed");
          window.webContents.setBackgroundThrottling(false);
          if (size) window.setContentSize(size.width, size.height);
          window.show();
          app.focus({ steal: true });
          window.focus();
          return {
            isFocused: window.isFocused(),
            isVisible: window.isVisible(),
            backgroundThrottling: window.webContents.getBackgroundThrottling(),
          };
        },
        { windowId, size },
      );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 200));
    });
    trace("setup", "initial resize sent", 1440);
    trace(
      "setup",
      "initial resize returned",
      1440,
      await focusWindow({ width: 1440, height: 950 }),
    );
    trace(
      "setup",
      "initial renderer visibility",
      1440,
      await page.evaluate(() => ({
        visibility: document.visibilityState,
        rendererFocused: document.hasFocus(),
      })),
    );
    await page.getByRole("button", { name: "新建输入", exact: true }).click();
    const baseBytes = Buffer.byteLength(fixture("stress", 0, false).before);
    const repeatBytes =
      Buffer.byteLength(fixture("stress", 1, false).before) - baseBytes;
    const stages =
      process.env.JSON_CRAFT_DIFF_STRESS === "1"
        ? [
            fixture(
              "twenty_megabytes",
              Math.floor((20 * 1024 * 1024 - 1024 - baseBytes) / repeatBytes),
              false,
            ),
          ]
        : process.env.JSON_CRAFT_DIFF_SANITY === "1"
          ? sanityFixtures()
          : [
              fixture("late_only", 2_500, false),
              fixture("two_repairs", 2_500, true),
              fixture("two_megabytes", 50_000, false),
            ];
    const raw = '{"fixture":"large diff rendering"}';
    const result: ProcessingResult = {
      success: true,
      output: '{\n  "fixture": "large diff rendering"\n}',
      decodedLayers: 0,
      stages,
      changeCount: stages.reduce((sum, stage) => sum + stage.changes.length, 0),
    };
    await page.evaluate(
      ({ raw, result }) => {
        const original = Worker.prototype.postMessage;
        const wrapper = {
          postMessage(this: Worker, ...args: unknown[]) {
            const request = args[0] as {
              kind: string;
              raw: string;
              id: number;
            };
            if (request.kind === "format" && request.raw === raw) {
              queueMicrotask(() =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: { id: request.id, kind: request.kind, result },
                  }),
                ),
              );
              return;
            }
            return Reflect.apply(original, this, args);
          },
        };
        Worker.prototype.postMessage =
          wrapper.postMessage as Worker["postMessage"];
      },
      { raw, result },
    );
    const input = page.getByTestId("input-editor").locator(".cm-content");
    await input.focus();
    await input.press("ControlOrMeta+a");
    await input.evaluate((element, value) => {
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
    if (process.env.JSON_CRAFT_DIFF_STRESS === "1")
      await monitorTextPeaks(page);
    await page.getByTestId("open-repair-diff").click();
    for (const [index, stage] of stages.entries()) {
      trace(stage.id, "stage entered");
      if (index) {
        await page.locator("#diff-stage-select").click();
        await page.getByRole("option").filter({ hasText: stage.path! }).click();
      }
      await poll(
        () =>
          page
            .getByTestId("repair-diff-editor")
            .getAttribute("data-difference-count"),
        (count) => Number(count) === stage.changes.length,
        "The selected diff did not initialize",
      );
      await page.getByTestId("diff-full-file").click();
      if (stage.changes.length > 1) await page.getByTestId("diff-next").click();
      await expectFilled(page, `${stage.id}: navigate to final repair`);
      trace(stage.id, "full navigation passed");
      await page.screenshot({
        path: path.join(artifacts, `repair-diff-large-${stage.id}.png`),
      });
      for (const width of [1440, 780]) {
        trace(stage.id, "resize sent", width);
        trace(
          stage.id,
          "resize returned",
          width,
          await focusWindow({ width, height: 900 }),
        );
        trace(
          stage.id,
          "renderer visibility",
          width,
          await page.evaluate(() => ({
            visibility: document.visibilityState,
            rendererFocused: document.hasFocus(),
          })),
        );
        await expectFilled(page, `${stage.id}: resize ${width}`);
        for (const ratio of [0.1, 0.5, 0.95, 1]) {
          await page.locator(".cm-mergeView").evaluate((element, value) => {
            element.scrollTop =
              (element.scrollHeight - element.clientHeight) * value;
          }, ratio);
          await expectFilled(page, `${stage.id}: scroll ${ratio} at ${width}`);
        }
        trace(stage.id, "width geometry passed", width);
        await searchLongLine(page, stage, width);
        trace(stage.id, "width search passed", width);
      }
      trace(stage.id, "before copy started");
      trace(stage.id, "before copy focused", undefined, await focusWindow());
      assert.equal(
        await copyDigest(page, "before"),
        createHash("sha256").update(stage.before).digest("hex"),
      );
      trace(stage.id, "before copy passed");
      trace(stage.id, "after copy started");
      trace(stage.id, "after copy focused", undefined, await focusWindow());
      assert.equal(
        await copyDigest(page, "after"),
        createHash("sha256").update(stage.after).digest("hex"),
      );
      trace(stage.id, "after copy passed");
      if (process.env.JSON_CRAFT_DIFF_STRESS === "1") {
        const peaks = await textPeaks(page);
        console.info("Large diff DOM text peaks", JSON.stringify(peaks));
        assert.ok(peaks.maximumTextNodeLength < 180_000);
        assert.ok(peaks.before > 0 && peaks.before < 180_000);
        assert.ok(peaks.after > 0 && peaks.after < 180_000);
      }
      await page.getByTestId("diff-full-file").click();
      await poll(
        () => page.locator(".cm-collapsedLines").count(),
        (count) => count > 0,
        "Context mode did not collapse unchanged lines again",
      );
    }
    if (process.env.JSON_CRAFT_DIFF_STRESS === "1") {
      const peaks = await textPeaks(page, true);
      console.info("Large diff final DOM text peaks", JSON.stringify(peaks));
      assert.ok(peaks.maximumTextNodeLength < 180_000);
      assert.ok(peaks.before > 0 && peaks.before < 180_000);
      assert.ok(peaks.after > 0 && peaks.after < 180_000);
    }
    console.info(
      "Large diff geometry",
      JSON.stringify({
        bytes: stages.map((stage) => Buffer.byteLength(stage.before)),
        samples: observations.length,
        maximumBlank: Math.max(...observations.map((value) => value.blank)),
        maximumSpacer: Math.max(
          ...observations.map((value) => value.largestSpacer),
        ),
        maximumNodes: Math.max(...observations.map((value) => value.nodes)),
        maximumRenderedCharacters: Math.max(
          ...observations.map((value) => value.characters),
        ),
        digestsPreserved: true,
      }),
    );
    assert.deepEqual(errors, []);
  },
);
