import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type Page } from "playwright";
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

async function copyEditor(page: Page, testId: string) {
  const content = page.getByTestId(testId).locator(".cm-content");
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

async function compare(page: Page) {
  const button = page.getByTestId("compare-json");
  await poll(
    () => button.isEnabled(),
    Boolean,
    "Two valid JSON inputs did not enable comparison",
  );
  await button.click();
  await page.getByTestId("comparison-result").waitFor();
  await poll(
    () =>
      page
        .getByTestId("repair-diff-editor")
        .getAttribute("data-difference-count"),
    (value) => value !== null,
    "The comparison editor did not finish computing differences",
  );
}

test(
  "Electron compares formatted JSON by reference key order without losing values or source options",
  { timeout: 150_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-comparison-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = null;
    config.settings.theme = "light";
    config.settings.recursiveUnescape = true;
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
    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 950);
      window.show();
      window.focus();
      ipcMain.removeHandler("json-craft:copy");
      ipcMain.handle("json-craft:copy", (_event, text: unknown) => {
        Reflect.set(globalThis, "__comparisonCopied", text);
      });
    });
    await page.getByTestId("open-comparison").click();
    await page.getByTestId("comparison-page").waitFor();
    assert.equal(await page.getByTestId("compare-json").isDisabled(), true);

    await t.test(
      "ignores only recursive object key order, including array members",
      async () => {
        const left =
          '{"name":"JSON Craft","nested":{"a":1,"b":2},"items":[{"id":1,"value":"one"},{"first":true,"last":false}],"large":900719925474099312345}';
        const right =
          '{"large":900719925474099312345,"items":[{"value":"one","id":1},{"last":false,"first":true}],"nested":{"b":2,"a":1},"name":"JSON Craft"}';
        await replaceInput(page, "left", left);
        await replaceInput(page, "right", right);
        await compare(page);
        await poll(
          () =>
            page
              .getByTestId("repair-diff-editor")
              .getAttribute("data-difference-count"),
          (value) => value === "0",
          "Key order alone still produces differences",
        );
        const before = await copyEditor(page, "diff-before");
        const after = await copyEditor(page, "diff-after");
        assert.equal(before, after);
        assert.ok(before.includes("900719925474099312345"));
        assert.ok(before.indexOf('"id"') < before.indexOf('"value"'));
        await page.getByTestId("comparison-back").click();
        assert.ok(
          (await copyEditor(page, "comparison-right")).indexOf('"large"') <
            (await copyEditor(page, "comparison-right")).indexOf('"items"'),
        );
      },
    );

    await t.test(
      "retains array order and real differences, with collapsed context navigation",
      async () => {
        const rows = Array.from({ length: 30 }, (_, index) => ({
          id: index,
          value: `item-${index}`,
        }));
        const left = { title: "before", rows, tail: true };
        const rightRows = rows.map(({ id, value }) => ({ value, id }));
        rightRows[25].value = "changed";
        const right = {
          tail: false,
          rows: rightRows,
          title: "after",
          added: true,
        };
        await replaceInput(page, "left", JSON.stringify(left));
        await replaceInput(page, "right", JSON.stringify(right));
        await poll(
          () => page.getByTestId("compare-json").isEnabled(),
          Boolean,
          "The screenshot inputs did not finish formatting",
        );
        for (const side of ["left", "right"] as const)
          await poll(
            () =>
              page
                .getByTestId(`comparison-${side}`)
                .locator(".cm-line")
                .count(),
            (count) => count > 3,
            "The automatically formatted input did not render multiple lines",
          );
        await mkdir(path.join(projectRoot, "output", "playwright"), {
          recursive: true,
        });
        await page.screenshot({
          path: path.join(
            projectRoot,
            "output",
            "playwright",
            "comparison-inputs.png",
          ),
        });
        await compare(page);
        const host = page.getByTestId("repair-diff-editor");
        await poll(
          () => host.getAttribute("data-difference-count"),
          (value) => Number(value) >= 3,
          "Value changes and the extra field were not identified",
        );
        assert.equal(
          await page
            .getByTestId("comparison-full-file")
            .getAttribute("aria-pressed"),
          "false",
        );
        assert.ok(
          await page
            .getByTestId("diff-after")
            .locator(".cm-collapsedLines")
            .count(),
        );
        await page.screenshot({
          path: path.join(
            projectRoot,
            "output",
            "playwright",
            "comparison-result.png",
          ),
        });
        const count = Number(await host.getAttribute("data-difference-count"));
        for (let index = 1; index < count; index++)
          await page.getByTestId("comparison-next").click();
        await poll(
          () => host.getAttribute("data-active-difference"),
          (value) => Number(value) === count - 1,
          "Difference navigation did not reach the final change",
        );
        await page.getByTestId("comparison-full-file").click();
        await poll(
          () =>
            page
              .getByTestId("comparison-full-file")
              .getAttribute("aria-pressed"),
          (value) => value === "true",
          "The full file toggle did not expand context",
        );
        const aligned = JSON.parse(await copyEditor(page, "diff-after"));
        assert.deepEqual(Object.keys(aligned), [
          "title",
          "rows",
          "tail",
          "added",
        ]);
        assert.deepEqual(
          aligned.rows.map((row: { id: number }) => row.id),
          rows.map((row) => row.id),
        );
        assert.equal(aligned.rows[25].value, "changed");
        await page.getByTestId("comparison-back").click();
      },
    );

    await t.test(
      "reformats the original source when recursive unescaping changes",
      async () => {
        const source = {
          payload: '{"b":2,"a":1}',
          link: "[view](https://example.com)",
          list: ['{"x":true}'],
        };
        await replaceInput(page, "left", JSON.stringify(source));
        await replaceInput(
          page,
          "right",
          JSON.stringify({
            payload: { a: 1, b: 2 },
            link: source.link,
            list: [{ x: true }],
          }),
        );
        await poll(
          async () =>
            JSON.parse(await copyEditor(page, "comparison-left")).payload,
          (value) => value !== null && typeof value === "object",
          "Nested JSON strings were not automatically decoded",
        );
        const recursive = page.getByRole("checkbox", {
          name: "递归去转义",
          exact: true,
        });
        await recursive.uncheck();
        await poll(
          async () =>
            JSON.parse(await copyEditor(page, "comparison-left")).payload,
          (value) => value === source.payload,
          "Disabling recursive unescaping did not restore the source string",
        );
        await recursive.check();
        await compare(page);
        assert.equal(
          await page
            .getByTestId("repair-diff-editor")
            .getAttribute("data-difference-count"),
          "0",
        );
        await page.getByTestId("comparison-back").click();
      },
    );

    await t.test(
      "blocks invalid JSON without repair and preserves drafts across modes",
      async () => {
        const repair = page.getByRole("checkbox", {
          name: "尝试修复",
          exact: true,
        });
        await repair.uncheck();
        await replaceInput(page, "left", '{"broken":');
        await delay(650);
        assert.equal(await page.getByTestId("compare-json").isDisabled(), true);
        await replaceInput(page, "left", '{"key":7}');
        await replaceInput(page, "right", '{"key":8}');
        await poll(
          () => page.getByTestId("compare-json").isEnabled(),
          Boolean,
          "Valid edited JSON did not recover",
        );
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        await page.getByTestId("input-editor").waitFor();
        await page.getByTestId("open-comparison").click();
        assert.deepEqual(
          JSON.parse(await copyEditor(page, "comparison-left")),
          { key: 7 },
        );
        assert.deepEqual(
          JSON.parse(await copyEditor(page, "comparison-right")),
          { key: 8 },
        );
      },
    );

    await t.test(
      "imports per pane and by root drop without creating history or managed files",
      async () => {
        const historyBefore = await page.evaluate(async () =>
          (await window.desktop!.workspace.load()).records
            .map((record) => record.id)
            .sort(),
        );
        const filesBefore = (await readdir(path.join(profile, "files"))).sort();
        const comparisonFile = page
          .getByTestId("comparison-page")
          .locator('input[type="file"]');
        await page
          .getByTestId("comparison-left")
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        await comparisonFile.setInputFiles({
          name: "left-import.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"name":"输入","id":1}'),
        });
        await poll(
          () => copyEditor(page, "comparison-left"),
          (value) => value.includes('"name": "输入"'),
          "The left file import did not decode UTF-8 JSON",
        );
        await page
          .getByTestId("comparison-right")
          .getByRole("button", { name: "导入文件", exact: true })
          .click();
        await comparisonFile.setInputFiles({
          name: "invalid-encoding.json",
          mimeType: "application/json",
          buffer: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
        });
        await poll(
          () => page.getByTestId("comparison-right-status").innerText(),
          (value) => value.includes("UTF-8"),
          "Invalid UTF-8 did not produce an actionable error",
        );
        assert.equal(await page.getByTestId("compare-json").isDisabled(), true);
        await page.evaluate(() => {
          const data = new DataTransfer();
          data.items.add(
            new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.json", {
              type: "application/json",
            }),
          );
          document.querySelector(".application")!.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
        });
        await poll(
          () => page.getByTestId("comparison-left-status").innerText(),
          (value) => value.includes("20 MiB"),
          "Files larger than 20 MiB were not rejected",
        );
        assert.equal(await page.getByTestId("compare-json").isDisabled(), true);
        await page.evaluate(() => {
          const data = new DataTransfer();
          data.items.add(
            new File(['{"key":7}'], "drop-left.json", {
              type: "application/json",
            }),
          );
          data.items.add(
            new File(['{"key":8}'], "drop-right.json", {
              type: "application/json",
            }),
          );
          document.querySelector(".application")!.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
        });
        await poll(
          () => page.getByTestId("compare-json").isEnabled(),
          Boolean,
          "Root dropping two files did not replace both comparison inputs",
        );
        assert.deepEqual(
          JSON.parse(await copyEditor(page, "comparison-left")),
          { key: 7 },
        );
        assert.deepEqual(
          JSON.parse(await copyEditor(page, "comparison-right")),
          { key: 8 },
        );
        const historyAfter = await page.evaluate(async () =>
          (await window.desktop!.workspace.load()).records
            .map((record) => record.id)
            .sort(),
        );
        assert.deepEqual(historyAfter, historyBefore);
        assert.deepEqual(
          (await readdir(path.join(profile, "files"))).sort(),
          filesBefore,
        );
      },
    );

    await t.test(
      "does not compare stale input or overwrite a newer edit during file reads",
      async () => {
        await page.evaluate(() => {
          const file = new File(['{"key":99}'], "delayed.json", {
            type: "application/json",
          });
          file.arrayBuffer = () =>
            new Promise<ArrayBuffer>((resolve) => {
              Reflect.set(window, "__releaseComparisonImport", () =>
                resolve(new TextEncoder().encode('{"key":99}').buffer),
              );
            });
          const data = new DataTransfer();
          data.items.add(file);
          document.querySelector(".application")!.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
        });
        await page.waitForFunction(
          () =>
            typeof Reflect.get(window, "__releaseComparisonImport") ===
            "function",
        );
        await poll(
          () => page.getByTestId("compare-json").isDisabled(),
          Boolean,
          "Comparison remained enabled while a replacement file was being read",
        );
        await replaceInput(page, "left", '{"key":7}');
        await page.evaluate(() =>
          Reflect.get(window, "__releaseComparisonImport")(),
        );
        await poll(
          () => page.getByTestId("compare-json").isEnabled(),
          Boolean,
          "Comparison did not recover after the interrupted import",
        );
        assert.deepEqual(
          JSON.parse(await copyEditor(page, "comparison-left")),
          { key: 7 },
        );
      },
    );

    await t.test(
      "copy feedback turns green and resets without touching the real clipboard",
      async () => {
        const button = page
          .getByTestId("comparison-left")
          .getByRole("button", { name: "复制", exact: true });
        await button.click();
        await poll(
          () => button.getAttribute("data-copied"),
          (value) => value === "true",
          "Copy success did not show a checkmark",
        );
        assert.equal(await button.locator("svg.lucide-check").count(), 1);
        const color = await button
          .locator("svg")
          .evaluate((icon) => getComputedStyle(icon).color);
        const channels = color.match(/\d+/g)!.map(Number);
        assert.ok(
          channels[1] > channels[0] && channels[1] > channels[2],
          `The copy checkmark is not green: ${color}`,
        );
        assert.deepEqual(
          JSON.parse(
            await application.evaluate(() =>
              Reflect.get(globalThis, "__comparisonCopied"),
            ),
          ),
          { key: 7 },
        );
        await poll(
          () => button.getAttribute("data-copied"),
          (value) => value === null,
          "Copy feedback did not reset after two seconds",
        );
        assert.equal(await button.locator("svg.lucide-copy").count(), 1);
      },
    );

    await t.test(
      "switches comparison UI language and theme through settings",
      async () => {
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "界面语言", exact: true })
          .click();
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Theme", exact: true })
          .click();
        await page.getByRole("option", { name: "Dark", exact: true }).click();
        await page.locator(".workspace-settings-back").click();
        await page.getByTestId("comparison-page").waitFor();
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "dark",
        );
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        assert.equal(
          await page.getByTestId("open-comparison").innerText(),
          "JSON Compare",
        );
        await compare(page);
        await mkdir(path.join(projectRoot, "output", "playwright"), {
          recursive: true,
        });
        await page.screenshot({
          path: path.join(
            projectRoot,
            "output",
            "playwright",
            "comparison-english-dark.png",
          ),
        });
        const result = page.getByTestId("comparison-result");
        assert.equal(
          /修复前|修复后|对比/.test(await result.innerText()),
          false,
        );
        assert.deepEqual(JSON.parse(await copyEditor(page, "diff-after")), {
          key: 8,
        });
      },
    );
    assert.deepEqual(errors, []);
  },
);
