import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import { isolateWorkspace } from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

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
    await delay(35);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function settled(page: Page) {
  await poll(
    () => page.getByTestId("processing-status").getAttribute("class"),
    (value) => Boolean(value?.includes("kind-ok")),
    "The selected JSON did not finish formatting",
  );
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (value) => value === "saved",
    "The selected JSON did not finish saving",
  );
  await delay(500);
}

async function selectRecord(page: Page, record: HistoryRecord) {
  await page
    .locator(`[data-history-id="${record.id}"] .history-entry-select`)
    .click();
  await poll(
    () => page.getByTestId("active-file-name").innerText(),
    (name) => name.trim() === record.name,
    "The selected history entry did not become active",
  );
  await settled(page);
}

async function timestamps(page: Page) {
  return page.evaluate(async () => {
    const state = await window.desktop!.workspace.load();
    return Object.fromEntries(
      state.records.map((record) => [record.id, record.updatedAt]),
    );
  });
}

async function displayedTimes(page: Page) {
  return page
    .locator("[data-history-id]")
    .evaluateAll((entries) =>
      Object.fromEntries(
        entries.map((entry) => [
          entry.getAttribute("data-history-id"),
          entry.querySelector("time")?.getAttribute("datetime"),
        ]),
      ),
    );
}

async function expectOrder(page: Page, ids: string[]) {
  await poll(
    () =>
      page
        .locator("[data-history-id]")
        .evaluateAll((entries) =>
          entries.map((entry) => entry.getAttribute("data-history-id")),
        ),
    (value) => JSON.stringify(value) === JSON.stringify(ids),
    "History was not ordered by its latest edit times",
  );
}

test(
  "Electron history preserves edit times and orders the latest edited file first",
  { timeout: 120_000 },
  async (t) => {
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "json-craft-timestamps-")),
    );
    const profile = path.join(workspace, "profile");
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const records: HistoryRecord[] = ["alpha", "beta", "gamma"].map(
      (name, index) => ({
        id: `timestamp-${name}`,
        name: `${name}.json`,
        raw: JSON.stringify({ document: name, value: index }),
        source: "scratch",
        managedPath: path.join(config.settings.writeDirectory, `${name}.json`),
        options: { indent: "2", autoUnescape: true, repair: true },
        createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        updatedAt: `2026-01-0${index + 1}T12:34:00.000Z`,
      }),
    );
    const initialTimes = Object.fromEntries(
      records.map((record) => [record.id, record.updatedAt]),
    );
    for (const record of records) {
      await writeFile(record.managedPath!, record.raw);
      await writeFile(
        path.join(
          config.settings.historyDirectory,
          `history-${record.id}.json`,
        ),
        JSON.stringify(record),
      );
    }
    config.initialized = true;
    config.activeId = records[2].id;
    await writeFile(configPath, JSON.stringify(config));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
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
      await poll(
        () =>
          page
            .getByRole("button", { name: "新建输入", exact: true })
            .isEnabled(),
        Boolean,
        "The isolated timestamp workspace did not load",
      );
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1440, 780);
        window.show();
        window.focus();
      });
      await settled(page);
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    await launch();

    await t.test(
      "loading and switching history preserve each edit time",
      async () => {
        assert.deepEqual(await timestamps(page), initialTimes);
        assert.deepEqual(await displayedTimes(page), initialTimes);
        await expectOrder(
          page,
          [...records].reverse().map((record) => record.id),
        );
        for (const record of records) await selectRecord(page, record);
        assert.deepEqual(await timestamps(page), initialTimes);
        assert.deepEqual(await displayedTimes(page), initialTimes);
      },
    );

    await t.test(
      "formatting options do not count as editing the source",
      async () => {
        await page
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        await poll(
          () =>
            page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              records[2].id,
            ),
          (record) => record.options.indent === "4",
          "The new indentation was not persisted",
        );
        await settled(page);
        assert.deepEqual(await timestamps(page), initialTimes);
        assert.deepEqual(await displayedTimes(page), initialTimes);
      },
    );

    let imported: HistoryRecord;
    await t.test(
      "importing and refreshing summaries leave existing edit times intact",
      async () => {
        const importedPath = path.join(workspace, "timestamp-import.json");
        const raw = '{"document":"imported"}';
        await writeFile(importedPath, raw);
        await application!.evaluate(({ dialog }, filePath) => {
          Reflect.set(
            globalThis,
            "__timestampOpenDialog",
            dialog.showOpenDialog,
          );
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [filePath],
          })) as typeof dialog.showOpenDialog;
        }, importedPath);
        try {
          await page
            .getByRole("button", { name: "导入文件", exact: true })
            .click();
          imported = await poll(
            () =>
              page.evaluate(async (name) => {
                const state = await window.desktop!.workspace.load();
                const found = state.records.find(
                  (record) => record.name === name,
                );
                return found ? window.desktop!.workspace.read(found.id) : null;
              }, "timestamp-import.json"),
            (record) => record?.raw === raw && Boolean(record.managedPath),
            "The imported JSON was not saved",
          ).then((record) => record!);
          await settled(page);
          const expected = {
            ...initialTimes,
            [imported.id]: imported.updatedAt,
          };
          assert.deepEqual(await timestamps(page), expected);
          assert.deepEqual(await displayedTimes(page), expected);
          await expectOrder(page, [
            imported.id,
            ...[...records].reverse().map((record) => record.id),
          ]);
        } finally {
          await application!.evaluate(({ dialog }) => {
            dialog.showOpenDialog = Reflect.get(
              globalThis,
              "__timestampOpenDialog",
            );
            Reflect.deleteProperty(globalThis, "__timestampOpenDialog");
          });
        }
      },
    );

    await t.test(
      "editing an older file moves it first and keeps the order after restarting",
      async () => {
        const oldest = records[0];
        await selectRecord(page, oldest);
        const raw = '{"document":"alpha","value":"edited"}';
        const started = Date.now();
        const content = page.getByTestId("input-editor").locator(".cm-content");
        await content.focus();
        await content.press("ControlOrMeta+a");
        await content.evaluate((element, text) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: data,
            }),
          );
        }, raw);
        const edited = await poll(
          () =>
            page.evaluate(
              (id) => window.desktop!.workspace.read(id),
              oldest.id,
            ),
          (record) =>
            record.raw === raw && record.updatedAt !== oldest.updatedAt,
          "The edit did not update only the source file's modification time",
        );
        assert.ok(new Date(edited.updatedAt).getTime() >= started);
        assert.ok(new Date(edited.updatedAt).getTime() <= Date.now());
        assert.equal(edited.createdAt, oldest.createdAt);
        await settled(page);
        const expected = {
          ...initialTimes,
          [imported.id]: imported.updatedAt,
          [oldest.id]: edited.updatedAt,
        };
        const order = [oldest.id, imported.id, records[2].id, records[1].id];
        assert.deepEqual(await timestamps(page), expected);
        assert.deepEqual(await displayedTimes(page), expected);
        await expectOrder(page, order);
        await close();
        await launch();
        assert.deepEqual(await timestamps(page), expected);
        assert.deepEqual(await displayedTimes(page), expected);
        await expectOrder(page, order);
        assert.deepEqual(errors, []);
      },
    );
  },
);
