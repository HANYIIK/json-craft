import assert from "node:assert/strict";
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
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

async function replaceInput(page: Page, raw: string) {
  const content = page.getByTestId("input-editor").locator(".cm-content");
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

async function copyPane(page: Page, side: "before" | "after") {
  const content = page.getByTestId(`diff-${side}`).locator(".cm-content");
  await content.focus();
  await content.press("ControlOrMeta+a");
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
  await content.press("ArrowLeft");
  return copied;
}

async function expectSearchUsable(page: Page) {
  await poll(
    () =>
      page.getByTestId("diff-after-panels").evaluate((container) => {
        const input = container.querySelector<HTMLElement>(
          'input[name="search"]',
        )!;
        const panel = input.closest<HTMLElement>(".cm-panels")!;
        const host = container.closest<HTMLElement>(
          '[data-testid="repair-diff-editor"]',
        )!;
        const bounds = input.getBoundingClientRect();
        const panelBounds = panel.getBoundingClientRect();
        const hostBounds = host.getBoundingClientRect();
        let left = 0;
        let top = 0;
        let right = innerWidth;
        let bottom = innerHeight;
        for (
          let parent = input.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
            left = Math.max(left, rect.left);
            right = Math.min(right, rect.right);
          }
          if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
        }
        const intersection =
          Math.max(
            0,
            Math.min(right, bounds.right) - Math.max(left, bounds.left),
          ) *
          Math.max(
            0,
            Math.min(bottom, bounds.bottom) - Math.max(top, bounds.top),
          );
        const controls = [
          input,
          ...container.querySelectorAll<HTMLElement>(
            '.cm-search button[name="next"], .cm-search button[name="prev"], .cm-search button[name="select"], .cm-search button[name="close"]',
          ),
        ];
        return {
          field: bounds.toJSON(),
          panel: panelBounds.toJSON(),
          host: hostBounds.toJSON(),
          fraction:
            bounds.width * bounds.height > 0
              ? intersection / (bounds.width * bounds.height)
              : 0,
          controls: controls.map((control) => {
            const rect = control.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return {
              name: control.getAttribute("name"),
              hit: Boolean(hit && (hit === control || control.contains(hit))),
              target: hit?.className,
            };
          }),
        };
      }),
    (value) =>
      value.fraction > 0.98 &&
      value.panel.left >= value.host.left + value.host.width / 2 - 1 &&
      value.panel.right <= value.host.right + 1 &&
      value.panel.right >= value.host.right - 24 &&
      value.panel.top >= value.host.top - 1 &&
      value.panel.top <= value.host.top + 24 &&
      value.controls.length >= 5 &&
      value.controls.every((control) => control.hit),
    "The search overlay is clipped, outside its pane, or cannot receive pointer input",
  );
}

async function openDiff(page: Page) {
  await page.getByTestId("open-repair-diff").click();
  await page.getByTestId("repair-diff-page").waitFor();
  await poll(
    () =>
      page
        .getByTestId("repair-diff-editor")
        .getAttribute("data-difference-count"),
    (value) => Number(value) > 0,
    "The diff page did not finish computing its changes",
  );
  await poll(
    () =>
      page
        .getByTestId("diff-after")
        .locator(".cm-content")
        .evaluate((element) => element === document.activeElement),
    Boolean,
    "Entering the diff page did not focus its editor",
  );
  await page.keyboard.press("ControlOrMeta+f");
  const search = page
    .getByTestId("diff-after-panels")
    .locator('.cm-search input[name="search"]');
  await search.waitFor();
  await expectSearchUsable(page);
  await search.press("Escape");
  assert.equal(
    await page.locator(".application").getAttribute("data-page"),
    "diff",
  );
}

async function chooseStage(page: Page, label: string) {
  await page.locator("#diff-stage-select").click();
  await page.getByRole("option").filter({ hasText: label }).click();
  await poll(
    () =>
      page
        .getByTestId("repair-diff-editor")
        .getAttribute("data-difference-count"),
    (value) => Number(value) > 0,
    "The selected stage did not become available",
  );
}

async function expectContextMode(page: Page, expanded: boolean) {
  const toggle = page.getByTestId("diff-full-file");
  await poll(
    () => toggle.getAttribute("aria-pressed"),
    (value) => value === String(expanded),
    "The context toggle did not follow the editor's expansion state",
  );
  assert.match(
    await toggle.innerText(),
    expanded
      ? /仅显示差异|Show differences only/
      : /显示完整文件|Show full file/,
  );
}

async function collapsedCounts(page: Page) {
  return Promise.all(
    (["before", "after"] as const).map((side) =>
      page.getByTestId(`diff-${side}`).locator(".cm-collapsedLines").count(),
    ),
  );
}

function stage(
  id: string,
  before: string,
  path: string,
  edits: { start: number; before: string; after: string }[],
): RepairStage {
  let after = "";
  let position = 0;
  for (const edit of edits) {
    after += before.slice(position, edit.start) + edit.after;
    position = edit.start + edit.before.length;
  }
  after += before.slice(position);
  return {
    id,
    path,
    layer: 1,
    before,
    after,
    diffTruncated: false,
    changes: edits.map((edit, index) => {
      const prefix = before.slice(0, edit.start).split("\n");
      return {
        id: `${id}-${index}`,
        stageId: id,
        label: "修复字符",
        path,
        layer: 1,
        start: edit.start,
        end: edit.start + edit.before.length,
        before: edit.before,
        after: edit.after,
        line: prefix.length,
        column: prefix[prefix.length - 1].length + 1,
      };
    }),
  };
}

test(
  "Electron reviews repair differences on an independent page with complete text and bounded rendering",
  {
    timeout: 180_000,
  },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-repair-diff-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "dark";
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
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("crash", () => errors.push("Renderer crashed"));
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 900);
      window.show();
      window.focus();
    });
    await poll(
      () =>
        page.getByRole("button", { name: "新建输入", exact: true }).isEnabled(),
      Boolean,
      "The isolated workspace did not load",
    );
    await page.getByRole("button", { name: "新建输入", exact: true }).click();

    await t.test(
      "collapses unchanged context by default and returns to the same input selection, undo and scroll",
      async () => {
        const valid = JSON.stringify(
          {
            title: "before",
            rows: Array.from(
              { length: 350 },
              (_, index) => `row_${String(index).padStart(3, "0")}`,
            ),
            tail: true,
          },
          null,
          2,
        );
        const raw = valid
          .replace('"row_040",', '"row_040"')
          .replace('"row_280",', '"row_280"');
        await replaceInput(page, raw);
        await page.getByTestId("open-repair-diff").waitFor();
        const savedRaw = () =>
          page.evaluate(async () => {
            const state = await window.desktop!.workspace.load();
            return state.activeId
              ? (await window.desktop!.workspace.read(state.activeId)).raw
              : "";
          });
        await poll(
          savedRaw,
          (value) => value === raw,
          "The original fixture did not finish saving",
        );
        await poll(
          () => page.getByTestId("processing-status").getAttribute("class"),
          (value) => Boolean(value?.includes("kind-repair")),
          "The original fixture did not finish processing",
        );
        const input = page.getByTestId("input-editor").locator(".cm-content");
        const identity = await input.elementHandle();
        assert.ok(identity);
        await input.focus();
        await input.press("ControlOrMeta+Home");
        for (let index = 0; index < raw.indexOf("before"); index++)
          await input.press("ArrowRight");
        for (let index = 0; index < "before".length; index++)
          await input.press("Shift+ArrowRight");
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "before",
        );
        await delay(600);
        await page.keyboard.insertText("after");
        const edited = raw.replace("before", "after");
        await poll(
          async () => {
            const raw = await savedRaw();
            const difference =
              Array.from(
                { length: Math.max(raw.length, edited.length) },
                (_, index) => index,
              ).find((index) => raw[index] !== edited[index]) ?? -1;
            return {
              matches: raw === edited,
              difference,
              actualLength: raw.length,
              expectedLength: edited.length,
              actual: raw.slice(Math.max(0, difference - 35), difference + 35),
              expected: edited.slice(
                Math.max(0, difference - 35),
                difference + 35,
              ),
            };
          },
          (value) => value.matches,
          "The input edit did not finish saving",
        );
        await input.press("ControlOrMeta+f");
        const search = page
          .getByTestId("input-editor")
          .locator('.cm-search input[name="search"]');
        await search.fill("row_200");
        await search.press("Enter");
        await search.press("Escape");
        await input.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "row_200",
        );
        const scroller = page
          .getByTestId("input-editor")
          .locator(".cm-scroller");
        await poll(
          () => scroller.evaluate((element) => element.scrollTop),
          (value) => value > 1_000,
          "The input fixture did not scroll",
        );
        await openDiff(page);
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "diff",
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        assert.equal(await page.locator("main.workspace").isVisible(), false);
        assert.equal(
          await page.getByTestId("diff-full-file").getAttribute("aria-pressed"),
          "false",
        );
        assert.ok((await page.locator(".cm-collapsedLines").count()) > 0);
        assert.ok(
          (await page.getByTestId("diff-before").locator(".cm-line").count()) <=
            30,
          "Changes-only mode rendered too many unchanged lines",
        );
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: path.join(
            artifacts,
            "repair-diff-page-chinese-dark-context.png",
          ),
        });
        const collapsedHeight = await page
          .getByTestId("diff-before")
          .locator(".cm-scroller")
          .evaluate((element) => element.scrollHeight);
        await page.getByTestId("diff-full-file").click();
        await poll(
          () => page.locator(".cm-collapsedLines").count(),
          (value) => value === 0,
          "Full-file mode left unchanged ranges hidden",
        );
        await poll(
          () =>
            page
              .getByTestId("diff-before")
              .locator(".cm-scroller")
              .evaluate((element) => element.scrollHeight),
          (value) => value > collapsedHeight * 3,
          "Full-file mode did not expose the complete document",
        );
        assert.equal(await copyPane(page, "before"), edited);
        assert.equal(
          await copyPane(page, "after"),
          valid.replace("before", "after"),
        );
        await page.getByTestId("diff-full-file").click();
        await poll(
          () => page.locator(".cm-collapsedLines").count(),
          (value) => value > 0,
          "Returning to changes-only mode did not collapse context",
        );
        await page.getByTestId("diff-back").click();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
        assert.equal(
          await identity.evaluate(
            (element) =>
              element ===
              document.querySelector(
                '[data-testid="input-editor"] .cm-content',
              ),
          ),
          true,
        );
        await input.focus();
        assert.equal(
          await page.evaluate(() => getSelection()?.toString()),
          "row_200",
        );
        assert.ok(
          await scroller.evaluate((element) => element.scrollTop > 1_000),
        );
        await input.press("ControlOrMeta+z");
        await poll(
          savedRaw,
          (value) => value === raw,
          "Viewing a diff discarded input undo history",
        );
      },
    );

    const overview =
      "{\n" +
      Array.from(
        { length: 180 },
        (_, index) =>
          `  "row_${index}": "UNCHANGED_${index}"${index === 179 ? "" : ","}`,
      ).join("\n") +
      "\n}";
    const overviewStage = stage(
      "overview",
      overview,
      "$.payload.overview",
      [40, 140].map((index) => ({
        start: overview.indexOf(`UNCHANGED_${index}"`),
        before: `UNCHANGED_${index}`,
        after: index === 40 ? "FIRST_EDIT" : "SECOND_EDIT",
      })),
    );
    const insertBefore = '{"insert":1 "next":2}';
    const deleteBefore = '{"delete":true,}';
    const eofBefore = '{"eof":true}\n';
    const longBefore =
      '{"veryLong":"' + "中A_width_".repeat(12_000) + '_BEFORE_LONG_MARKER_"}';
    const contextBefore =
      "{\n" +
      Array.from(
        { length: 80 },
        (_, index) =>
          `  "context_${index}": "UNCHANGED_${index}"${index === 79 ? "" : ","}`,
      ).join("\n") +
      "\n}";
    const stages: RepairStage[] = [
      overviewStage,
      stage("insert", insertBefore, "$.payload[0]", [
        { start: insertBefore.indexOf(" "), before: "", after: "," },
      ]),
      stage("delete", deleteBefore, "$.payload[1]", [
        { start: deleteBefore.indexOf(","), before: ",", after: "" },
      ]),
      stage("eof", eofBefore, "$.payload[2]", [
        { start: eofBefore.length - 1, before: "\n", after: "" },
      ]),
      stage(
        "multiple-context",
        contextBefore,
        "$.context.multiple",
        [20, 60].map((index) => ({
          start: contextBefore.indexOf(`UNCHANGED_${index}"`),
          before: `UNCHANGED_${index}`,
          after: `CHANGED_${index}`,
        })),
      ),
      stage("single-context", contextBefore, "$.context.single", [
        {
          start: contextBefore.indexOf('UNCHANGED_2"'),
          before: "UNCHANGED_2",
          after: "CHANGED_2",
        },
      ]),
      {
        id: "long",
        path: "$.largePayload",
        layer: 1,
        before: longBefore,
        after: longBefore.replace(
          "_BEFORE_LONG_MARKER_",
          "_AFTER_LONG_MARKER_",
        ),
        changes: [],
        diffTruncated: true,
      },
    ];
    const fixtureRaw = '{"fixture":"diff navigation"}';
    const result: ProcessingResult = {
      success: true,
      output: '{\n  "fixture": "diff navigation"\n}',
      decodedLayers: 0,
      stages,
      changeCount: null,
    };

    await t.test(
      "navigates character changes across stages and handles insertion, deletion and EOF newlines",
      async () => {
        await page.evaluate(
          (fixture) => {
            const original = Worker.prototype.postMessage;
            const wrapper = {
              postMessage(this: Worker, ...args: unknown[]) {
                const request = args[0] as {
                  id: number;
                  kind: string;
                  raw: string;
                };
                if (request.kind === "format" && request.raw === fixture.raw) {
                  queueMicrotask(() =>
                    this.dispatchEvent(
                      new MessageEvent("message", {
                        data: {
                          id: request.id,
                          kind: request.kind,
                          result: fixture.result,
                        },
                      }),
                    ),
                  );
                  return;
                }
                return Reflect.apply(original, this, args);
              },
            };
            Worker.prototype.postMessage =
              wrapper.postMessage as typeof Worker.prototype.postMessage;
          },
          { raw: fixtureRaw, result },
        );
        await replaceInput(page, fixtureRaw);
        await page.getByTestId("repair-count").waitFor();
        await openDiff(page);
        await poll(
          () =>
            page
              .getByTestId("repair-diff-editor")
              .getAttribute("data-difference-count"),
          (value) => value === "2",
          "Known character repairs were collapsed into one navigation target",
        );
        assert.equal(
          await page.getByTestId("diff-position").getAttribute("data-kind"),
          "change",
        );
        assert.equal(
          await page.getByTestId("diff-previous").isDisabled(),
          true,
        );
        await page.getByTestId("diff-next").click();
        await poll(
          () =>
            page
              .getByTestId("repair-diff-editor")
              .getAttribute("data-active-difference"),
          (value) => value === "1",
          "Next did not reach the second character change",
        );
        const second = page
          .getByTestId("diff-after")
          .locator(".cm-line")
          .filter({ hasText: "SECOND_EDIT" });
        await poll(
          () =>
            second.evaluate((element) => {
              const line = element.getBoundingClientRect();
              const viewport = element
                .closest(".cm-mergeView")!
                .getBoundingClientRect();
              return line.bottom >= viewport.top && line.top <= viewport.bottom;
            }),
          Boolean,
          "The current change is outside its editor viewport",
        );
        assert.ok(
          (await page
            .getByTestId("diff-before")
            .locator(".cm-changedText")
            .count()) > 0,
        );
        assert.ok(
          (await page
            .getByTestId("diff-after")
            .locator(".cm-changedText")
            .count()) > 0,
        );
        for (let index = 1; index <= 3; index++) {
          await page.getByTestId("diff-next").click();
          await poll(
            () => page.locator("#diff-stage-select").innerText(),
            (value) => value.includes(stages[index].path!),
            "Next did not cross into the following repair stage",
          );
          await poll(
            () =>
              page
                .getByTestId("repair-diff-editor")
                .getAttribute("data-difference-count"),
            (value) => value === "1",
            "A single-sided repair was not navigable",
          );
          assert.equal(await copyPane(page, "before"), stages[index].before);
          assert.equal(await copyPane(page, "after"), stages[index].after);
          if (index < 3)
            assert.ok(
              (await page
                .getByTestId(index === 1 ? "diff-after" : "diff-before")
                .locator(".cm-changedText")
                .count()) > 0,
              "A single-sided repair has no character highlight",
            );
        }
        await page.getByTestId("diff-previous").click();
        await poll(
          () => page.locator("#diff-stage-select").innerText(),
          (value) => value.includes("$.payload[1]"),
          "Previous did not cross back into the prior stage",
        );
        await chooseStage(page, "$.payload[0]");
        assert.equal(
          await page
            .getByTestId("diff-before")
            .locator(".cm-content")
            .getAttribute("aria-readonly"),
          "true",
        );
        assert.equal(
          await page
            .getByTestId("diff-after")
            .locator(".cm-content")
            .getAttribute("aria-readonly"),
          "true",
        );
      },
    );

    await t.test(
      "links local expansion on either side to the toolbar without expanding unrelated ranges",
      async () => {
        await chooseStage(page, "$.context.multiple");
        await expectContextMode(page, false);
        const initial = await poll(
          () => collapsedCounts(page),
          (value) => value[0] === 3 && value[1] === 3,
          "The multiple-context fixture did not hide its three unchanged ranges",
        );
        const left = page
          .getByTestId("diff-before")
          .locator(".cm-collapsedLines");
        const right = page
          .getByTestId("diff-after")
          .locator(".cm-collapsedLines");
        await left.first().click();
        await expectContextMode(page, true);
        await poll(
          () => collapsedCounts(page),
          (value) =>
            value.every((count, index) => count === initial[index] - 1),
          "Expanding one range exposed unrelated unchanged content",
        );
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page.locator(".workspace-settings-back").click();
        await expectContextMode(page, true);
        assert.deepEqual(await collapsedCounts(page), [2, 2]);
        await chooseStage(page, "$.payload[0]");
        await expectContextMode(page, false);
        assert.deepEqual(await collapsedCounts(page), [0, 0]);
        await chooseStage(page, "$.context.multiple");
        await expectContextMode(page, false);
        await poll(
          () => collapsedCounts(page),
          (value) => value.every((count) => count === 3),
          "Returning to a stage did not restore its default context mode",
        );
        for (const key of ["Enter", "Space"]) {
          await poll(
            () => right.first().getAttribute("role"),
            (value) => value === "button",
            "The collapsed range did not finish enabling keyboard controls",
          );
          await right.first().focus();
          assert.equal(
            await right
              .first()
              .evaluate((element) => element === document.activeElement),
            true,
          );
          await right.first().press(key);
          await expectContextMode(page, true);
          await poll(
            () => collapsedCounts(page),
            (value) => value.every((count) => count === 2),
            `${key} expanded more than the selected unchanged range`,
          );
          await page.getByTestId("diff-full-file").click();
          await expectContextMode(page, false);
          await poll(
            () => collapsedCounts(page),
            (value) => value.every((count) => count === 3),
            "The toolbar did not collapse every manually expanded range",
          );
        }
        await page.getByTestId("diff-full-file").click();
        await expectContextMode(page, true);
        await poll(
          () => collapsedCounts(page),
          (value) => value.every((count) => count === 0),
          "Explicit full-file mode left a range collapsed",
        );
        await chooseStage(page, "$.payload[0]");
        await expectContextMode(page, false);
        await chooseStage(page, "$.context.multiple");
        await expectContextMode(page, true);
        assert.deepEqual(await collapsedCounts(page), [0, 0]);
        await page.getByTestId("diff-full-file").click();
        await expectContextMode(page, false);
        await chooseStage(page, "$.context.single");
        await expectContextMode(page, false);
        await poll(
          () => collapsedCounts(page),
          (value) => value.every((count) => count === 1),
          "The single-context fixture did not hide exactly one range",
        );
        await right.first().click();
        await expectContextMode(page, true);
        await poll(
          () => collapsedCounts(page),
          (value) => value.every((count) => count === 0),
          "Expanding the only hidden range did not show the complete file",
        );
        await page.getByTestId("diff-full-file").click();
        await expectContextMode(page, false);
        await poll(
          () => collapsedCounts(page),
          (value) => value.every((count) => count === 1),
          "The only unchanged range could not be collapsed again",
        );
      },
    );

    await t.test(
      "preserves the diff through settings and keeps search Escape, theme and narrow layouts usable",
      async () => {
        await chooseStage(page, "$.payload.overview");
        await page.getByTestId("diff-full-file").click();
        await page.getByTestId("diff-next").click();
        const after = page.getByTestId("diff-after").locator(".cm-content");
        await after.focus();
        await after.press("ControlOrMeta+f");
        const search = page
          .getByTestId("diff-after-panels")
          .locator('.cm-search input[name="search"]');
        await search.fill("SECOND_EDIT");
        assert.equal(await search.isVisible(), true);
        await expectSearchUsable(page);
        await page
          .getByTestId("diff-after-panels")
          .locator('button[name="next"]')
          .click();
        await expectSearchUsable(page);
        await page.screenshot({
          path: path.join(
            artifacts,
            "repair-diff-page-chinese-dark-deep-search.png",
          ),
        });
        await search.press("Escape");
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "diff",
        );
        assert.equal(
          await page
            .getByTestId("diff-after-panels")
            .locator(".cm-search")
            .count(),
          0,
        );
        await page.keyboard.press("Escape");
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Escape did not leave the diff page after closing search",
        );
        await openDiff(page);
        await chooseStage(page, "$.payload[0]");
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(780, 720),
        );
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: path.join(artifacts, "repair-diff-page-chinese-780-dark.png"),
        });
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .nth(1)
          .click();
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await page
          .locator(".workspace-settings-theme [role=combobox]")
          .first()
          .click();
        await page.getByRole("option", { name: "Light", exact: true }).click();
        await page.locator(".workspace-settings-back").click();
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "diff",
          "Settings did not return to the existing diff snapshot",
        );
        assert.ok(
          (await page.locator("#diff-stage-select").innerText()).includes(
            "$.payload[0]",
          ),
        );
        assert.equal(
          await page.getByTestId("diff-full-file").getAttribute("aria-pressed"),
          "false",
        );
        await poll(
          () =>
            page
              .getByTestId("diff-after")
              .locator(".cm-content")
              .evaluate((element) => element === document.activeElement),
          Boolean,
          "Returning from settings did not restore the diff editor focus",
        );
        await page.keyboard.press("ControlOrMeta+f");
        const returnedSearch = page
          .getByTestId("diff-after-panels")
          .locator('.cm-search input[name="search"]');
        await returnedSearch.waitFor();
        await expectSearchUsable(page);
        await returnedSearch.press("Escape");
        assert.equal(
          await page.locator(".application").getAttribute("data-page"),
          "diff",
        );
        const layout = await page
          .getByTestId("repair-diff-page")
          .evaluate((element) => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            controls: Array.from(
              element.querySelectorAll<HTMLElement>(
                "header button, .repair-diff-page-toolbar button",
              ),
            ).map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width };
            }),
          }));
        assert.ok(layout.scrollWidth <= layout.width + 1);
        for (const control of layout.controls)
          assert.ok(
            control.left >= 0 &&
              control.right <= layout.width + 1 &&
              control.width >= 24,
            JSON.stringify(control),
          );
        await page.screenshot({
          path: path.join(artifacts, "repair-diff-page-english-780-light.png"),
        });
      },
    );

    await t.test(
      "keeps large mixed-width single lines complete and exposes bounded-diff notices",
      async () => {
        await chooseStage(page, "$.largePayload");
        await page.getByTestId("diff-notice").waitFor();
        const large = stages[stages.length - 1];
        assert.ok(large.before.length > 100_000);
        assert.equal(await copyPane(page, "before"), large.before);
        assert.equal(await copyPane(page, "after"), large.after);
        await poll(
          () => page.getByTestId("diff-next").isDisabled(),
          Boolean,
          "The final change did not disable forward navigation",
        );
        await page
          .locator('.titlebar-navigation [aria-controls="workspace-sidebar"]')
          .click();
        await poll(
          () => page.locator(".application").getAttribute("data-page"),
          (value) => value === "workspace",
          "Expanding the sidebar did not leave the diff page",
        );
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          true,
        );
        const saved = await page.evaluate(async () => {
          const state = await window.desktop!.workspace.load();
          return state.activeId
            ? window.desktop!.workspace.read(state.activeId)
            : null;
        });
        assert.equal(saved?.raw, fixtureRaw);
      },
    );
    assert.deepEqual(errors, []);
  },
);
