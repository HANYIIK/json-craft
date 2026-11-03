import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import {
  formatThroughMenu,
  isolateWorkspace,
} from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const probeKey = "__jsonCraftCopyFeedback";
interface Probe {
  mode: "normal" | "fail" | "hold";
  attempts: number;
  writes: string[];
  pending: (() => void)[];
}

async function poll<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await delay(25);
  }
  assert.fail("Copy feedback did not reach the expected state");
}

async function changeMode(
  application: ElectronApplication,
  mode: Probe["mode"],
) {
  await application.evaluate(
    (_electron, value) => {
      const probe = Reflect.get(globalThis, value.key) as Probe;
      probe.mode = value.mode;
      if (value.mode !== "hold")
        probe.pending.splice(0).forEach((finish) => finish());
    },
    { key: probeKey, mode },
  );
}

async function probeState(application: ElectronApplication) {
  return application.evaluate((_electron, key) => {
    const probe = Reflect.get(globalThis, key) as Probe;
    return {
      attempts: probe.attempts,
      writes: probe.writes.length,
      pending: probe.pending.length,
    };
  }, probeKey);
}

async function expectIcon(page: Page, success: boolean) {
  const button = page.getByRole("button", { name: "复制", exact: true });
  await poll(
    () => button.getAttribute("data-copied"),
    (value) => (success ? value === "true" : value === null),
  );
  assert.equal(
    await button
      .locator(success ? "svg.lucide-check" : "svg.lucide-copy")
      .count(),
    1,
  );
  if (success) {
    const colors = await button.locator("svg").evaluate((icon) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--success)";
      icon.parentElement!.append(probe);
      const colors = {
        actual: getComputedStyle(icon).color,
        expected: getComputedStyle(probe).color,
      };
      probe.remove();
      return colors;
    });
    assert.equal(colors.actual, colors.expected);
  }
}

test(
  "manual copy success feedback is timed and isolated without using the real clipboard",
  { timeout: 90_000 },
  async (t) => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "json-craft-copy-feedback-"),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.initialized = true;
    config.activeId = "copy-one";
    config.settings.autoCopy = false;
    const records = ["one", "two"].map((name) => ({
      id: `copy-${name}`,
      name: `copy-${name}.json`,
      raw: JSON.stringify({ copied: name }),
      source: "sample",
      options: { indent: "2", autoUnescape: true, repair: true },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
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
    const bootstrap = path.join(workspace, "capture-copy.cjs");
    await writeFile(
      bootstrap,
      `const { ipcMain } = require("electron");
const probe = { mode: "normal", attempts: 0, writes: [], pending: [] };
Reflect.set(globalThis, ${JSON.stringify(probeKey)}, probe);
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, channel === "json-craft:copy" ? async (_event, text) => {
  probe.attempts++;
  if (probe.mode === "fail") throw new Error("Mock clipboard permission failure");
  if (probe.mode === "hold") await new Promise(resolve => probe.pending.push(resolve));
  probe.writes.push(text);
} : listener);
require(${JSON.stringify(path.join(projectRoot, "electron", "main.cjs"))});
`,
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    let application: ElectronApplication | undefined;
    t.after(async () => {
      try {
        if (application) {
          await changeMode(application, "normal");
          await application.close();
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    application = await _electron.launch({
      args: [bootstrap, `--user-data-dir=${profile}`],
      cwd: projectRoot,
      env: environment,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const copy = page.getByRole("button", { name: "复制", exact: true });
    await poll(() => copy.isEnabled(), Boolean);
    await expectIcon(page, false);

    await t.test(
      "success shows a green check for two seconds from the latest successful click",
      async () => {
        await copy.click();
        await expectIcon(page, true);
        await delay(1_100);
        await copy.click();
        await poll(
          () => probeState(application!),
          (state) => state.writes === 2,
        );
        await delay(1_100);
        await expectIcon(page, true);
        await poll(
          () => copy.getAttribute("data-copied"),
          (value) => value === null,
        );
        await expectIcon(page, false);
      },
    );

    await t.test(
      "copy failures clear success instead of displaying a false positive",
      async () => {
        await copy.click();
        await expectIcon(page, true);
        const writes = (await probeState(application!)).writes;
        await changeMode(application!, "fail");
        await copy.click();
        await expectIcon(page, false);
        assert.equal((await probeState(application!)).writes, writes);
      },
    );

    await t.test(
      "a delayed success for another file cannot change the current button",
      async () => {
        await changeMode(application!, "hold");
        await copy.click();
        await poll(
          () => probeState(application!),
          (state) => state.pending === 1,
        );
        await page
          .locator('[data-history-id="copy-two"] .history-entry-select')
          .click();
        await poll(() => copy.isEnabled(), Boolean);
        await expectIcon(page, false);
        await changeMode(application!, "normal");
        await poll(
          () => probeState(application!),
          (state) => state.pending === 0,
        );
        await delay(100);
        await expectIcon(page, false);
        await copy.click();
        await expectIcon(page, true);
        await page
          .locator('[data-history-id="copy-one"] .history-entry-select')
          .click();
        await poll(() => copy.isEnabled(), Boolean);
        await expectIcon(page, false);
      },
    );

    await t.test(
      "automatic copying does not show manual copy feedback",
      async () => {
        await page
          .getByRole("checkbox", { name: "格式化后自动复制", exact: true })
          .setChecked(true);
        await poll(
          () =>
            page.evaluate(
              async () =>
                (await window.desktop!.workspace.load()).settings.autoCopy,
            ),
          Boolean,
        );
        const writes = (await probeState(application!)).writes;
        await formatThroughMenu(application!, page);
        await poll(
          () => probeState(application!),
          (state) => state.writes > writes,
        );
        await expectIcon(page, false);
      },
    );
    assert.deepEqual(errors, []);
  },
);
