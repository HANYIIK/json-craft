import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const deadline = Date.now() + 15_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

function rows(count: number) {
  return Array.from({ length: count }, (_, index) =>
    Object.fromEntries(
      Array.from({ length: 10 }, (_, field) => [
        `field${field}`,
        `before-${String(index).padStart(4, "0")}-${field}-中文😀-definition`,
      ]),
    ),
  );
}

async function importPair(page: Page, left: string, right: string) {
  await page.evaluate(
    ({ left, right }) => {
      const data = new DataTransfer();
      for (const [name, source] of [
        ["large-left.json", left],
        ["large-right.json", right],
      ])
        data.items.add(new File([source], name, { type: "application/json" }));
      document.querySelector(".application")!.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    },
    { left, right },
  );
  await poll(
    () => page.getByTestId("compare-json").isEnabled(),
    Boolean,
    "Imported large JSON did not finish formatting",
  );
}

async function compare(page: Page, count: number) {
  await page.getByTestId("compare-json").click();
  await page.getByTestId("comparison-result").waitFor();
  await poll(
    () =>
      page
        .getByTestId("repair-diff-editor")
        .getAttribute("data-difference-count"),
    (value) => value === String(count),
    "Large JSON comparison combined separate changes into coarse blocks",
  );
}

async function expectPreciseChanges(page: Page, count: number) {
  const host = page.getByTestId("repair-diff-editor");
  await poll(
    () => host.getAttribute("data-chunk-count"),
    (value) => value === String(count),
    "The comparison lost individual changed chunks",
  );
  assert.equal(await host.getAttribute("data-difference-count"), String(count));
  assert.equal(await host.getAttribute("data-added-lines"), String(count));
  assert.equal(await host.getAttribute("data-removed-lines"), String(count));
  assert.equal(await host.getAttribute("data-precise"), "true");
}

async function expectVisibleChange(page: Page, index: number) {
  const marker = `after-${String(index * 20).padStart(4, "0")}-5`;
  await poll(
    () =>
      page.getByTestId("diff-after").evaluate((pane, value) => {
        const scroller = pane.querySelector(".cm-scroller")!;
        const viewport = scroller.getBoundingClientRect();
        return [...pane.querySelectorAll(".cm-line")].some((line) => {
          if (!line.textContent?.includes(value)) return false;
          const bounds = line.getBoundingClientRect();
          return (
            bounds.bottom > viewport.top &&
            bounds.top < viewport.bottom &&
            [...line.querySelectorAll(".cm-changedText")].some((change) => {
              const color = getComputedStyle(change).backgroundColor;
              return (
                change.textContent?.includes("after") &&
                color !== "transparent" &&
                color !== "rgba(0, 0, 0, 0)"
              );
            })
          );
        });
      }, marker),
    Boolean,
    `Changed value ${marker} was not visible with character highlighting`,
  );
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

test(
  "Electron keeps separated large JSON changes precise through navigation, context and layout changes",
  { timeout: 150_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-comparison-large-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.settings.theme = "light";
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
    await page.getByTestId("open-comparison").waitFor();
    const resize = async (width: number) => {
      await application.evaluate(({ BrowserWindow, app }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setBackgroundThrottling(false);
        window.setContentSize(width, 950);
        window.show();
        app.focus({ steal: true });
        window.focus();
      }, width);
      await poll(
        () => page.evaluate(() => innerWidth),
        (value) => value === width,
        "The native comparison window did not reach the requested width",
      );
    };
    await resize(1_440);
    await page.getByTestId("open-comparison").click();
    const leftRows = rows(1_000);
    const rightRows = leftRows.map((row, index) => ({
      ...row,
      field5:
        index % 20 === 0 ? row.field5.replace("before", "after") : row.field5,
    }));
    const left = JSON.stringify(leftRows, null, 2);
    const right = JSON.stringify(rightRows, null, 2);
    assert.ok(left.split("\n").length >= 12_000);
    assert.ok(Math.max(...left.split("\n").map((line) => line.length)) < 100);
    await importPair(page, left, right);
    await compare(page, 50);
    const host = page.getByTestId("repair-diff-editor");
    const fullFile = page.getByTestId("comparison-full-file");
    await expectPreciseChanges(page, 50);
    await expectVisibleChange(page, 0);
    assert.equal(await fullFile.getAttribute("aria-pressed"), "false");
    assert.ok(await page.locator(".cm-collapsedLines").count());

    await page.getByTestId("comparison-next").click();
    await expectVisibleChange(page, 1);
    await page.getByTestId("comparison-previous").click();
    await expectVisibleChange(page, 0);
    for (let index = 1; index < 50; index++) {
      await page.getByTestId("comparison-next").click();
      await poll(
        () => host.getAttribute("data-active-difference"),
        (value) => value === String(index),
        "Next difference did not preserve the separate change index",
      );
    }
    await expectVisibleChange(page, 49);
    assert.equal(await page.getByTestId("comparison-next").isDisabled(), true);

    await fullFile.click();
    await poll(
      () => page.locator(".cm-collapsedLines").count(),
      (value) => value === 0,
      "Full-file mode left unchanged content collapsed",
    );
    await expectPreciseChanges(page, 50);
    assert.equal(await copyPane(page, "before"), left);
    assert.equal(await copyPane(page, "after"), right);
    await fullFile.click();
    await poll(
      () => page.locator(".cm-collapsedLines").count(),
      (value) => value > 0,
      "Changes-only mode did not restore collapsed context",
    );

    for (const width of [780, 1_440]) {
      await resize(width);
      await expectPreciseChanges(page, 50);
    }
    for (const enabled of [false, true]) {
      await page.getByTestId("comparison-back").click();
      const toggle = page
        .getByTestId("comparison-page")
        .getByRole("button", { name: "自动换行", exact: true });
      if ((await toggle.getAttribute("aria-pressed")) !== String(enabled))
        await toggle.click();
      await compare(page, 50);
      await expectPreciseChanges(page, 50);
      await expectVisibleChange(page, 0);
      assert.equal(await copyPane(page, "after"), right);
    }
    assert.deepEqual(errors, []);
  },
);
