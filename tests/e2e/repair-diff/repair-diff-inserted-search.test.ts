import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
import type { ProcessingResult, RepairStage } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const marker = "JSON_CRAFT_EXCLUSIVE_BLOCK_MIDDLE";

function fixture(deletion: boolean): RepairStage {
  const compact = JSON.stringify(
    {
      headers: Array.from({ length: 30 }, (_, index) => `header_${index}`),
      entries: [],
      footer: Array.from({ length: 30 }, (_, index) => `footer_${index}`),
    },
    null,
    2,
  );
  const start = compact.indexOf('"entries": [') + '"entries": ['.length;
  const inserted =
    "\n" +
    Array.from(
      { length: 1_200 },
      (_, index) =>
        "    " +
        JSON.stringify(
          index === 600
            ? "exclusive ".repeat(1_200) + marker + " content".repeat(1_200)
            : `exclusive_entry_${index}`,
        ),
    ).join(",\n") +
    "\n  ";
  const expanded = compact.slice(0, start) + inserted + compact.slice(start);
  const before = deletion ? expanded : compact;
  const after = deletion ? compact : expanded;
  const prefix = before.slice(0, start).split("\n");
  const id = deletion ? "deleted_block" : "inserted_block";
  assert.doesNotThrow(() => JSON.parse(before));
  assert.doesNotThrow(() => JSON.parse(after));
  assert.ok(inserted.split("\n").length >= 1_000);
  assert.ok(expanded.split("\n").some((line) => line.length >= 10_000));
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
        label: deletion ? "删除字符" : "插入字符",
        before: deletion ? inserted : "",
        after: deletion ? "" : inserted,
        start,
        end: deletion ? start + inserted.length : start,
        line: prefix.length,
        column: prefix.at(-1)!.length + 1,
        layer: 0,
      },
    ],
  };
}

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 8_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 1_000)}`);
}

async function geometry(page: Page, side: "before" | "after") {
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
          throw new Error("The exclusive search marker is not rendered");
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
      const peer = host.querySelector(
        `[data-testid="diff-${side === "before" ? "after" : "before"}"]`,
      )!;
      const spacers = Array.from(
        peer.querySelectorAll(".cm-mergeSpacer"),
        (node) => {
          const rect = node.getBoundingClientRect();
          return {
            height: rect.height,
            overlap: Math.max(
              0,
              Math.min(rect.bottom, viewport.bottom) -
                Math.max(rect.top, viewport.top),
            ),
          };
        },
      );
      return {
        found: offset >= 0,
        rectangles: rectangles.length,
        visible:
          rectangles.length > 0 &&
          rectangles.every(
            (rect) =>
              rect.top >= viewport.top - 1 &&
              rect.bottom <= viewport.bottom + 1 &&
              rect.left >= Math.max(viewport.left, bounds.left) - 1 &&
              rect.right <= Math.min(viewport.right, bounds.right) + 1,
          ),
        legitimateSpacer: spacers.some(
          (spacer) =>
            spacer.height > viewport.height * 2 &&
            spacer.overlap > viewport.height / 2,
        ),
      };
    },
    { side, marker },
  );
}

async function copyDigest(page: Page, side: "before" | "after") {
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
  "exclusive inserted and deleted block searches preserve the source target and legitimate peer spacer",
  { timeout: 90_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-diff-exclusive-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    await writeFile(configPath, JSON.stringify(config));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
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
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1_200, 900);
      window.show();
      window.focus();
    });
    await page.getByRole("button", { name: "新建输入", exact: true }).click();
    const stages = [fixture(false), fixture(true)];
    const raw = '{"fixture":"exclusive diff searches"}';
    const result: ProcessingResult = {
      success: true,
      output: '{\n  "fixture": "exclusive diff searches"\n}',
      decodedLayers: 0,
      stages,
      changeCount: 2,
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
    await page.getByTestId("open-repair-diff").click();
    for (const [index, stage] of stages.entries()) {
      if (index) {
        await page.locator("#diff-stage-select").click();
        await page.getByRole("option").filter({ hasText: stage.path! }).click();
      }
      await poll(
        () => page.locator(".cm-collapsedLines").count(),
        (count) => count > 0,
        "The stage did not begin in context mode",
      );
      await page.getByTestId("diff-full-file").click();
      await poll(
        () => page.locator(".cm-collapsedLines").count(),
        (count) => count === 0,
        "Full-file mode retained hidden lines",
      );
      const side = index === 0 ? "after" : "before";
      const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
      await content.focus();
      await content.press("ControlOrMeta+f");
      const panel = page.getByTestId(`diff-${side}-panels`);
      const search = panel.locator('.cm-search input[name="search"]');
      await search.fill(marker);
      await search.press("Enter");
      await poll(
        () => geometry(page, side),
        (value) => value.found && value.visible && value.legitimateSpacer,
        `${stage.id}: search moved away from the source-only target or removed a legitimate spacer`,
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        await delay(80);
        const value = await geometry(page, side);
        assert.equal(
          value.visible,
          true,
          `${stage.id}: the source target moved out of view`,
        );
        assert.equal(
          value.legitimateSpacer,
          true,
          `${stage.id}: the peer lost its insertion alignment space`,
        );
      }
      await search.press("Escape");
      assert.equal(await panel.locator(".cm-search").count(), 0);
      for (const pane of ["before", "after"] as const)
        assert.equal(
          await copyDigest(page, pane),
          createHash("sha256").update(stage[pane]).digest("hex"),
        );
      await page.getByTestId("diff-full-file").click();
    }
    assert.deepEqual(errors, []);
  },
);
