import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const artifacts = path.join(projectRoot, "output", "playwright");
type Pane = "input" | "output";

function syntheticDocument() {
  return JSON.stringify(
    {
      headers: Array.from({ length: 78 }, (_, index) => ({
        name: `synthetic-context-option-${index}`,
        enabled: true,
      })),
      request_params: {
        prompt_requests: [
          {
            variables: {
              context_json: JSON.stringify({
                field_catalog: Array.from({ length: 220 }, (_, index) => ({
                  id: index,
                  marker: `__PERFORMANCE_BLOCK_${index}__`,
                  label: "教育经历·专业名称·测试字段",
                  description:
                    '类型：字符串；示例："机械工程"；支持深层转义。'.repeat(3),
                  operations: ["exact", "in", "exists"],
                  allow_empty_string: false,
                })),
              }),
            },
          },
        ],
      },
      tail: "__PERFORMANCE_DOCUMENT_END__",
    },
    null,
    2,
  );
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
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

async function viewportCoverage(scroller: Locator) {
  return scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const content = element.querySelector(".cm-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const intervals: [number, number][] = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.length) continue;
      range.selectNodeContents(walker.currentNode);
      for (const rectangle of range.getClientRects())
        if (
          rectangle.width > 0 &&
          rectangle.bottom > bounds.top &&
          rectangle.top < bounds.bottom
        )
          intervals.push([
            Math.max(0, rectangle.top - bounds.top),
            Math.min(bounds.height, rectangle.bottom - bounds.top),
          ]);
    }
    intervals.sort((left, right) => left[0] - right[0]);
    let covered = 0;
    let maximumBlank = 0;
    for (const [from, to] of intervals) {
      maximumBlank = Math.max(maximumBlank, from - covered);
      covered = Math.max(covered, to);
    }
    maximumBlank = Math.max(maximumBlank, bounds.height - covered);
    return {
      maximumBlank,
      visibleRectangles: intervals.length,
      height: bounds.height,
      width: bounds.width,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      renderedCharacters: content.textContent?.length ?? 0,
      lineHeight: parseFloat(getComputedStyle(content).lineHeight),
      domNodes: content.querySelectorAll("*").length,
    };
  });
}

async function expectFilledViewport(page: Page, pane: Pane, phase: string) {
  const scroller = editor(page, pane).locator(".cm-scroller");
  return poll(
    () => viewportCoverage(scroller),
    (value) =>
      value.visibleRectangles > 0 &&
      value.maximumBlank <= value.lineHeight * 2 + 5,
    `${phase}: the wrapped middle of a long JSON line left a visible blank region`,
    3000,
  );
}

async function split(page: Page) {
  const back = page.getByRole("button", { name: "返回双栏", exact: true });
  if (await back.isVisible()) await back.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function focus(page: Page, pane: Pane) {
  await split(page);
  await page
    .getByRole("button", {
      name: pane === "input" ? "独占查看原始输入" : "独占查看格式化结果",
      exact: true,
    })
    .click();
  await delay(100);
}

async function find(page: Page, pane: Pane, marker: string) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+f");
  const search = editor(page, pane).locator('.cm-search input[name="search"]');
  await search.fill(marker);
  await search.press("Enter");
  await search.press("Escape");
  await editor(page, pane).locator(".cm-search").waitFor({ state: "hidden" });
  await delay(100);
}

async function entireText(page: Page, pane: Pane) {
  const content = editor(page, pane).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
  const actual = await content.evaluate((element) => {
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
  return actual;
}

test(
  "Electron keeps mixed-width escaped long JSON lines visible with unescaping disabled through repeated pane and window changes",
  { timeout: 180_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-performance-")),
    );
    const profile = path.join(workspace, "profile");
    const files = path.join(workspace, "files");
    const history = path.join(workspace, "history");
    await Promise.all(
      [profile, files, history, artifacts].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(
      path.join(profile, "workspace-settings.json"),
      JSON.stringify({
        version: 1,
        initialized: true,
        activeId: null,
        settings: {
          readDirectory: files,
          writeDirectory: files,
          historyDirectory: history,
          theme: "dark",
          autoCopy: false,
          language: "zh-CN",
        },
      }),
    );
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
    await editor(page, "input").locator(".cm-content").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
      window.setSize(1440, 1000);
    });

    const raw = syntheticDocument();
    assert.ok(Math.max(...raw.split("\n").map((line) => line.length)) > 50_000);
    await page.getByRole("button", { name: "新建输入", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "自动去转义", exact: true })
      .uncheck();
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
    }, raw);
    assert.equal(consumed, true);
    await poll(
      () => editor(page, "output").locator(".cm-content").textContent(),
      (value) => Boolean(value?.length),
      "The pasted JSON was not formatted",
    );

    await t.test(
      "fills each viewport after repeated changes without an extra keystroke",
      async () => {
        for (const pane of ["input", "output"] as const) {
          for (let index = 0; index < 6; index++) {
            await split(page);
            await find(page, pane, `__PERFORMANCE_BLOCK_${22 + index * 28}__`);
            await expectFilledViewport(page, pane, `${pane} split ${index}`);
            await focus(page, pane);
            try {
              await expectFilledViewport(
                page,
                pane,
                `${pane} focused ${index}`,
              );
              await application.evaluate(({ BrowserWindow }, index) => {
                BrowserWindow.getAllWindows()[0].setSize(
                  ...((index % 2 ? [1920, 1200] : [1024, 768]) as [
                    number,
                    number,
                  ]),
                );
              }, index);
              await expectFilledViewport(
                page,
                pane,
                `${pane} resized ${index}`,
              );
            } finally {
              await page.screenshot({
                path: path.join(artifacts, `performance-${pane}-${index}.png`),
              });
            }
          }
        }
      },
    );

    await t.test(
      "preserves the source, output and automatic JSON file exactly",
      async () => {
        await split(page);
        assert.equal(digest(await entireText(page, "input")), digest(raw));
        assert.equal(digest(await entireText(page, "output")), digest(raw));
        const saved = await poll(
          async () => {
            const state = await page.evaluate(() =>
              window.desktop!.workspace.load(),
            );
            const record = state.records.find(
              (record) => record.characters === raw.length,
            );
            return record
              ? page.evaluate(
                  (id) => window.desktop!.workspace.read(id),
                  record.id,
                )
              : null;
          },
          (value) => value?.raw === raw && Boolean(value.managedPath),
          "The complete pasted JSON was not persisted",
        );
        assert.ok(saved?.managedPath);
        assert.equal(saved.options.autoUnescape, false);
        assert.equal(path.dirname(saved.managedPath), files);
        assert.equal(
          digest(await readFile(saved.managedPath, "utf8")),
          digest(raw),
        );
      },
    );

    await t.test(
      "settles long-line rendering instead of redrawing continuously",
      async () => {
        await focus(page, "input");
        await find(page, "input", "__PERFORMANCE_BLOCK_110__");
        await expectFilledViewport(page, "input", "idle rendering");
        await delay(350);
        const mutations = await editor(page, "input")
          .locator(".cm-content")
          .evaluate(
            (element) =>
              new Promise<number>((resolve) => {
                let count = 0;
                const observer = new MutationObserver((records) => {
                  count += records.length;
                });
                observer.observe(element, {
                  childList: true,
                  subtree: true,
                  characterData: true,
                  attributes: true,
                });
                setTimeout(() => {
                  observer.disconnect();
                  resolve(count);
                }, 700);
              }),
          );
        assert.equal(
          mutations,
          0,
          "The unchanged long-line viewport kept modifying its DOM",
        );
      },
    );

    await t.test(
      "renders a supported 20 MiB line above the native height scaling threshold",
      async () => {
        await split(page);
        await application.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
        });
        await delay(100);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        const half = "abcde-".repeat(
          Math.floor((20 * 1024 * 1024 - 1024) / 12),
        );
        const raw = JSON.stringify(
          { payload: half + "__LIMIT_MIDDLE__" + half, tail: "__LIMIT_END__" },
          null,
          2,
        );
        assert.ok(Buffer.byteLength(raw) < 20 * 1024 * 1024);
        const content = editor(page, "input").locator(".cm-content");
        const startup = await editor(page, "output").evaluateHandle(
          (element) => {
            const probe = {
              maxCharacters: 0,
              maxTextNodes: 0,
              observer: null as MutationObserver | null,
            };
            const observer = new MutationObserver(() => {
              const content = element.querySelector(".cm-content");
              if (!content) return;
              const walker = document.createTreeWalker(
                content,
                NodeFilter.SHOW_TEXT,
              );
              let characters = 0;
              let nodes = 0;
              while (walker.nextNode()) {
                characters += walker.currentNode.textContent?.length ?? 0;
                nodes++;
              }
              probe.maxCharacters = Math.max(probe.maxCharacters, characters);
              probe.maxTextNodes = Math.max(probe.maxTextNodes, nodes);
            });
            observer.observe(element, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            probe.observer = observer;
            return probe;
          },
        );
        await content.focus();
        await content.evaluate((element, raw) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", raw);
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        }, raw);
        await page
          .locator(".output-footer")
          .getByText("有效 JSON", { exact: true })
          .waitFor();
        const startupSize = await startup.evaluate((probe) => {
          probe.observer?.disconnect();
          return {
            maxCharacters: probe.maxCharacters,
            maxTextNodes: probe.maxTextNodes,
          };
        });
        await startup.dispose();
        assert.ok(
          startupSize.maxCharacters < 250_000,
          "The result editor briefly inserted the entire huge line into its DOM",
        );
        assert.ok(
          startupSize.maxTextNodes < 1000,
          "The result editor created unbounded text nodes during startup",
        );
        await find(page, "input", "__LIMIT_MIDDLE__");
        const middle = await expectFilledViewport(
          page,
          "input",
          "20 MiB split middle",
        );
        assert.ok(
          middle.scrollHeight > 7_000_000,
          "The fixture did not exercise the native height scaling threshold",
        );
        assert.ok(
          middle.renderedCharacters < 250_000,
          "The huge line stopped virtualizing its offscreen text",
        );
        assert.ok(
          middle.domNodes < 1000,
          "The huge line created unbounded DOM nodes",
        );
        await focus(page, "input");
        await expectFilledViewport(page, "input", "20 MiB focused middle");
        await find(page, "input", "__LIMIT_END__");
        const tailVisible = await content.evaluate((element) => {
          const bounds = element.parentElement!.getBoundingClientRect();
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          const range = document.createRange();
          while (walker.nextNode()) {
            const start =
              walker.currentNode.textContent?.indexOf("__LIMIT_END__") ?? -1;
            if (start < 0) continue;
            range.setStart(walker.currentNode, start);
            range.setEnd(walker.currentNode, start + "__LIMIT_END__".length);
            const rectangle = range.getBoundingClientRect();
            return (
              rectangle.top >= bounds.top - 2 &&
              rectangle.bottom <= bounds.bottom + 2
            );
          }
          return false;
        });
        assert.ok(
          tailVisible,
          "The huge line's final marker is outside the viewport",
        );
        t.diagnostic(
          `20 MiB viewport and startup: ${JSON.stringify({ middle, startupSize })}`,
        );
      },
    );

    await t.test("does not report renderer errors", () =>
      assert.deepEqual(errors, []),
    );
  },
);
