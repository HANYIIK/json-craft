import assert from "node:assert/strict";
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
import {
  _electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { chooseHistoryAction, openHistoryMenu } from "../support/history-menu";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = path.join(projectRoot, "output", "playwright");

async function poll<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 10_000;
  let value: T | undefined;
  do {
    value = await read();
    if (matches(value)) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

function entry(page: Page, id: string) {
  return page.locator(`[data-history-id="${id}"]`);
}

async function loadWorkspace(page: Page) {
  return page.evaluate(() => window.desktop!.workspace.load());
}

async function readHistory(page: Page, id: string) {
  return page.evaluate(
    (recordId) => window.desktop!.workspace.read(recordId),
    id,
  );
}

async function expectOrder(page: Page, ids: string[]) {
  await poll(
    () =>
      page
        .locator("[data-history-id]")
        .evaluateAll((entries) =>
          entries.map((row) => row.getAttribute("data-history-id")),
        ),
    (value) => JSON.stringify(value) === JSON.stringify(ids),
    "History did not put pinned entries before the latest edited entries",
  );
}

async function expectFocused(locator: Locator) {
  await poll(
    () => locator.evaluate((element) => document.activeElement === element),
    Boolean,
    "Keyboard focus did not move to the expected history control",
  );
}

async function opacity(locator: Locator) {
  return locator.evaluate((element) => {
    let value = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      value *= Number(style.opacity);
    }
    return value;
  });
}

async function timestamps(page: Page) {
  const state = await loadWorkspace(page);
  return Object.fromEntries(
    state.records.map((record) => [record.id, record.updatedAt]),
  );
}

async function displayedTimes(page: Page) {
  return page
    .locator("[data-history-id]")
    .evaluateAll((entries) =>
      Object.fromEntries(
        entries.map((row) => [
          row.getAttribute("data-history-id"),
          row.querySelector("time")?.getAttribute("datetime"),
        ]),
      ),
    );
}

async function setPinned(page: Page, record: HistoryRecord, pinned: boolean) {
  const english = (await page.locator("html").getAttribute("lang")) === "en";
  const label = english
    ? pinned
      ? "Pin"
      : "Unpin"
    : pinned
      ? "置顶"
      : "取消置顶";
  const menu = await openHistoryMenu(page, record.name);
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
  await menu.waitFor({ state: "detached" });
  await poll(
    () => entry(page, record.id).getAttribute("data-pinned"),
    (value) => value === String(pinned),
    "The history entry did not display its new pin state",
  );
  await poll(
    () => readHistory(page, record.id),
    (value) => Boolean(value.pinned) === pinned,
    "The history entry did not persist its new pin state",
  );
}

test(
  "Electron history actions support keyboard access and persist pinned ordering",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-history-pin-")),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const records: HistoryRecord[] = ["alpha", "beta", "gamma", "delta"].map(
      (name, index) => ({
        id: `pin-${name}`,
        name: `${name}.json`,
        raw: JSON.stringify({ document: name, value: index }),
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        updatedAt: `2026-01-0${index + 1}T12:34:00.000Z`,
      }),
    );
    const [alpha, beta, gamma, delta] = records;
    const initialTimes = Object.fromEntries(
      records.map((record) => [record.id, record.updatedAt]),
    );
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
    config.initialized = true;
    config.activeId = delta.id;
    config.settings.theme = "light";
    await writeFile(configPath, JSON.stringify(config));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] => item[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    let page: Page;
    const errors: string[] = [];
    const close = async () => {
      const running = application;
      application = undefined;
      if (running) await running.close();
    };
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
        timeout: 30_000,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page
        .getByRole("button", { name: "新建输入", exact: true })
        .waitFor();
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 780);
        window.show();
        window.focus();
      });
      await poll(
        () =>
          page.getByTestId("autosave-status").getAttribute("data-save-state"),
        (value) => value === "saved",
        "The isolated pin workspace did not finish loading",
      );
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    await launch();
    await mkdir(artifacts, { recursive: true });

    await t.test(
      "shows actions on hover or keyboard focus and dismisses the portal menu",
      async () => {
        await expectOrder(page, [delta.id, gamma.id, beta.id, alpha.id]);
        const row = entry(page, alpha.id);
        const trigger = row.getByRole("button", {
          name: `更多操作 ${alpha.name}`,
          exact: true,
        });
        await page.getByTestId("active-file-name").hover();
        await poll(
          () => opacity(trigger),
          (value) => value === 0,
          "The history actions should be hidden before hover or focus",
        );
        assert.equal(await trigger.getAttribute("aria-haspopup"), "menu");
        await row.hover();
        await poll(
          () => opacity(trigger),
          (value) => value > 0,
          "Hovering the history entry did not reveal its actions",
        );
        await page.getByTestId("active-file-name").hover();
        await row.locator(".history-entry-select").focus();
        await page.keyboard.press("Tab");
        await expectFocused(trigger);
        assert.ok(await opacity(trigger));
        await trigger.press("ArrowDown");
        const menu = page.getByRole("menu");
        await menu.waitFor();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
          "置顶",
          "修改名称",
          "删除",
        ]);
        assert.equal(
          await menu.evaluate(
            (element) =>
              document.body.contains(element) &&
              element.closest("[data-history-id]") === null,
          ),
          true,
        );
        await expectFocused(
          menu.getByRole("menuitem", { name: "置顶", exact: true }),
        );
        const bounds = await menu.boundingBox();
        const viewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0);
        assert.ok(bounds.x + bounds.width <= viewport.width);
        assert.ok(bounds.y + bounds.height <= viewport.height);
        await page.screenshot({
          path: path.join(artifacts, "history-actions-zh-light.png"),
        });
        await page.keyboard.press("ArrowDown");
        await expectFocused(
          menu.getByRole("menuitem", { name: "修改名称", exact: true }),
        );
        await page.keyboard.press("End");
        await expectFocused(
          menu.getByRole("menuitem", { name: "删除", exact: true }),
        );
        await page.keyboard.press("ArrowDown");
        await expectFocused(
          menu.getByRole("menuitem", { name: "置顶", exact: true }),
        );
        await page.keyboard.press("ArrowUp");
        await expectFocused(
          menu.getByRole("menuitem", { name: "删除", exact: true }),
        );
        await page.keyboard.press("Home");
        await expectFocused(
          menu.getByRole("menuitem", { name: "置顶", exact: true }),
        );
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        await expectFocused(trigger);
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        await openHistoryMenu(page, alpha.name);
        await page.getByTestId("active-file-name").click();
        await menu.waitFor({ state: "detached" });
        await trigger.focus();
        await trigger.press("Enter");
        await menu.waitFor();
        await expectFocused(
          menu.getByRole("menuitem", { name: "置顶", exact: true }),
        );
        await page.keyboard.press("Enter");
        await menu.waitFor({ state: "detached" });
        await poll(
          () => row.getAttribute("data-pinned"),
          (value) => value === "true",
          "Keyboard activation did not pin the history entry",
        );
        assert.equal((await loadWorkspace(page)).activeId, delta.id);
        await expectFocused(trigger);
        await setPinned(page, alpha, false);
        await expectOrder(page, [delta.id, gamma.id, beta.id, alpha.id]);
        assert.deepEqual(await timestamps(page), initialTimes);
      },
    );

    await t.test(
      "pins above newer entries, sorts the pinned group by edit time and restores on unpin",
      async () => {
        await setPinned(page, alpha, true);
        await expectOrder(page, [alpha.id, delta.id, gamma.id, beta.id]);
        assert.equal((await loadWorkspace(page)).activeId, delta.id);
        await setPinned(page, beta, true);
        await expectOrder(page, [beta.id, alpha.id, delta.id, gamma.id]);
        await setPinned(page, alpha, false);
        await expectOrder(page, [beta.id, delta.id, gamma.id, alpha.id]);
        await setPinned(page, beta, false);
        await expectOrder(page, [delta.id, gamma.id, beta.id, alpha.id]);
        assert.deepEqual(await timestamps(page), initialTimes);
        assert.deepEqual(await displayedTimes(page), initialTimes);
        await setPinned(page, alpha, true);
        await close();
        await launch();
        await expectOrder(page, [alpha.id, delta.id, gamma.id, beta.id]);
        assert.equal(
          await entry(page, alpha.id).getAttribute("data-pinned"),
          "true",
        );
        assert.equal(Boolean((await readHistory(page, alpha.id)).pinned), true);
        assert.deepEqual(await timestamps(page), initialTimes);
        assert.deepEqual(await displayedTimes(page), initialTimes);
      },
    );

    await t.test(
      "keeps an edited unpinned entry below pinned entries after restarting",
      async () => {
        await entry(page, beta.id).locator(".history-entry-select").click();
        await poll(
          () => page.getByTestId("active-file-name").innerText(),
          (value) => value.trim() === beta.name,
          "The unpinned entry did not become active",
        );
        const raw = '{"document":"beta","edited":true}';
        await page.getByTestId("input-editor").locator(".cm-content").fill(raw);
        const edited = await poll(
          () => readHistory(page, beta.id),
          (value) => value.raw === raw && value.updatedAt !== beta.updatedAt,
          "Editing the unpinned entry did not save its source and edit time",
        );
        await expectOrder(page, [alpha.id, beta.id, delta.id, gamma.id]);
        assert.equal(
          await entry(page, beta.id).getAttribute("data-pinned"),
          "false",
        );
        assert.equal(
          (await readHistory(page, alpha.id)).updatedAt,
          alpha.updatedAt,
        );
        await close();
        await launch();
        await expectOrder(page, [alpha.id, beta.id, delta.id, gamma.id]);
        assert.equal((await readHistory(page, beta.id)).raw, raw);
        assert.equal(
          (await readHistory(page, beta.id)).updatedAt,
          edited.updatedAt,
        );
        await setPinned(page, alpha, false);
        await expectOrder(page, [beta.id, delta.id, gamma.id, alpha.id]);
        await close();
        await launch();
        await expectOrder(page, [beta.id, delta.id, gamma.id, alpha.id]);
        assert.equal(
          Boolean((await readHistory(page, alpha.id)).pinned),
          false,
        );
      },
    );

    await t.test(
      "renames through the menu and preserves a pinned record when deletion is cancelled",
      async () => {
        await setPinned(page, alpha, true);
        await chooseHistoryAction(page, alpha.name, "rename");
        const filename = page.getByRole("textbox", {
          name: "文件名",
          exact: true,
        });
        await expectFocused(filename);
        await filename.fill("cancelled-rename.json");
        await filename.press("Escape");
        assert.equal((await readHistory(page, alpha.id)).name, alpha.name);
        await chooseHistoryAction(page, alpha.name, "rename");
        const renamed = "pinned-renamed.json";
        await filename.fill(renamed);
        await filename.press("Enter");
        await poll(
          () => readHistory(page, alpha.id),
          (value) => value.name === renamed && Boolean(value.pinned),
          "Renaming the pinned entry lost its name or pin state",
        );
        await expectOrder(page, [alpha.id, beta.id, delta.id, gamma.id]);
        const times = await timestamps(page);
        await chooseHistoryAction(page, renamed, "delete");
        const dialog = page.getByTestId("delete-confirmation");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal((await readHistory(page, alpha.id)).name, renamed);
        assert.equal(Boolean((await readHistory(page, alpha.id)).pinned), true);
        assert.deepEqual(await timestamps(page), times);
        await expectOrder(page, [alpha.id, beta.id, delta.id, gamma.id]);
        await chooseHistoryAction(page, renamed, "delete");
        await dialog.waitFor();
        await dialog
          .getByRole("button", { name: "删除记录", exact: true })
          .click();
        await dialog.waitFor({ state: "detached" });
        await expectOrder(page, [beta.id, delta.id, gamma.id]);
        await close();
        await launch();
        assert.equal(await entry(page, alpha.id).count(), 0);
      },
    );

    await t.test("localizes all history menu actions in English", async () => {
      await page.getByRole("button", { name: "应用设置", exact: true }).click();
      await page
        .locator(".workspace-settings-theme [role=combobox]")
        .nth(1)
        .click();
      await page.getByRole("option", { name: "English", exact: true }).click();
      await poll(
        () => page.locator("html").getAttribute("lang"),
        (value) => value === "en",
        "The history menu language did not change to English",
      );
      await page
        .locator(".workspace-settings-theme [role=combobox]")
        .first()
        .click();
      await page.getByRole("option", { name: "Dark", exact: true }).click();
      await page.locator(".workspace-settings-back").click();
      const menu = await openHistoryMenu(page, gamma.name);
      assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
        "Pin",
        "Rename",
        "Delete",
      ]);
      await page.screenshot({
        path: path.join(artifacts, "history-actions-en-dark.png"),
      });
      await page.keyboard.press("Escape");
      await setPinned(page, gamma, true);
      await openHistoryMenu(page, gamma.name);
      await menu
        .getByRole("menuitem", { name: "Unpin", exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await setPinned(page, gamma, false);
      assert.deepEqual(errors, []);
    });
  },
);
