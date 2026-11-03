import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { HistoryRecord } from "../../../src/shared/types";
import {
  formatThroughMenu,
  isolateWorkspace,
} from "../support/workspace-fixture";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  message: string,
) {
  const deadline = Date.now() + 5_000;
  let value: T | undefined;
  do {
    value = await read();
    if (valid(value)) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)?.slice(0, 400)}`);
}

async function expectOutput(page: Page, expected: string) {
  await poll(
    async () =>
      (
        await page
          .getByTestId("output-editor")
          .locator(".cm-line")
          .allTextContents()
      ).join("\n"),
    (value) => value === expected,
    "The saved extraction did not restore its original value",
  );
}

function query(page: Page) {
  return page.getByRole("textbox", { name: "提取 key 名称", exact: true });
}

test(
  "Electron restores extraction queries without overwriting user drafts",
  {
    timeout: 90_000,
  },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "json-craft-extraction-restore-"),
    );
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const records: HistoryRecord[] = [
      {
        id: "restore-duplicate",
        name: "restore-duplicate.json",
        raw: '{"payload":{"chosen":"root"},"envelope":{"payload":{"chosen":"first"},"payload":"{\\"chosen\\":\\"second\\",\\"nested\\":[1,2]}"},"tail":true}',
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        extraction: {
          key: "payload",
          path: "$.envelope.payload",
          occurrence: 2,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "restore-other",
        name: "restore-other.json",
        raw: '{"data":{"other":[false,null]},"payload":{"chosen":"different"}}',
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        extraction: { key: "data", path: "$.data", occurrence: 1 },
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "restore-draft-race",
        name: "restore-draft-race.json",
        raw: '{"payload":{"chosen":"draft race"},"untouched":true}',
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        extraction: { key: "payload", path: "$.payload", occurrence: 1 },
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "restore-empty-race",
        name: "restore-empty-race.json",
        raw: JSON.stringify({ context_json: '{"chosen":"empty race"}' }),
        source: "sample",
        options: { indent: "2", autoUnescape: true, repair: true },
        extraction: {
          key: "context_json",
          path: "$.context_json",
          occurrence: 1,
        },
        createdAt: "2026-01-04T00:00:00.000Z",
        updatedAt: "2026-01-04T00:00:00.000Z",
      },
    ];
    config.initialized = true;
    config.activeId = records[0].id;
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
      await running?.close();
    };
    const launch = async () => {
      application = await _electron.launch({
        args: [projectRoot, `--user-data-dir=${profile}`],
        cwd: projectRoot,
        env: environment,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await query(page).waitFor();
    };
    t.after(async () => {
      try {
        await close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    });
    await launch();
    const selected = { chosen: "second", nested: [1, 2] };

    await t.test(
      "fills the query on the first asynchronous restore and after restart",
      async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expectOutput(page, JSON.stringify(selected, null, 2));
          assert.equal(
            await page.locator(".key-current code").innerText(),
            "$.envelope.payload",
          );
          assert.match(
            await page.locator(".key-current .key-occurrence").innerText(),
            /2\s*\/\s*2/,
          );
          await poll(
            () => query(page).inputValue(),
            (value) => value === "payload",
            "The extraction path and second occurrence restored, but its key query stayed empty",
          );
          if (!attempt) {
            await close();
            await launch();
          }
        }
      },
    );

    await t.test(
      "keeps per-document query drafts while preserving the selected extraction path",
      async () => {
        await query(page).fill("draft_next_key");
        await formatThroughMenu(application!, page);
        await expectOutput(page, JSON.stringify(selected, null, 2));
        assert.equal(await query(page).inputValue(), "draft_next_key");
        await page
          .getByRole("combobox", { name: "JSON 缩进", exact: true })
          .click();
        await page.getByRole("option", { name: "4 空格", exact: true }).click();
        await expectOutput(page, JSON.stringify(selected, null, 4));
        assert.equal(await query(page).inputValue(), "draft_next_key");
        await page
          .locator('[data-history-id="restore-other"] .history-entry-select')
          .click();
        await expectOutput(
          page,
          JSON.stringify({ other: [false, null] }, null, 2),
        );
        await poll(
          () => query(page).inputValue(),
          (value) => value === "data",
          "The other document did not receive its saved query",
        );
        await page
          .locator(
            '[data-history-id="restore-duplicate"] .history-entry-select',
          )
          .click();
        await expectOutput(page, JSON.stringify(selected, null, 4));
        assert.equal(await query(page).inputValue(), "draft_next_key");
        assert.equal(
          await page.locator(".key-current code").innerText(),
          "$.envelope.payload",
        );
        assert.match(
          await page.locator(".key-current .key-occurrence").innerText(),
          /2\s*\/\s*2/,
        );
      },
    );

    await t.test(
      "keeps the query when returning to the complete JSON",
      async () => {
        await page
          .getByRole("button", { name: "返回完整 JSON", exact: true })
          .click();
        await poll(
          async () =>
            (
              await page
                .getByTestId("output-editor")
                .locator(".cm-line")
                .allTextContents()
            ).join("\n"),
          (value) => value.includes('"root"') && value.includes('"tail": true'),
          "Returning to complete JSON did not restore the source content",
        );
        assert.equal(await query(page).inputValue(), "draft_next_key");
        assert.equal(await page.locator(".key-current").count(), 0);
      },
    );

    for (const clear of [false, true]) {
      await t.test(
        `does not overwrite a ${clear ? "cleared" : "typed"} query while history extraction is loading`,
        async () => {
          const record = records[clear ? 3 : 2];
          await page.evaluate((raw) => {
            const original = Worker.prototype.postMessage;
            Reflect.set(window, "__restoreOriginalPostMessage", original);
            Reflect.set(window, "__restorePending", { raw, requests: [] });
            const wrapper = {
              postMessage(this: Worker, ...args: unknown[]) {
                const message = args[0] as { kind?: string; raw?: string };
                const pending = Reflect.get(window, "__restorePending");
                if (
                  message.kind === "find-key" &&
                  message.raw === pending.raw
                ) {
                  pending.requests.push({ worker: this, args });
                  return;
                }
                return Reflect.apply(original, this, args);
              },
            };
            Worker.prototype.postMessage =
              wrapper.postMessage as typeof Worker.prototype.postMessage;
          }, record.raw);
          try {
            await page
              .locator(`[data-history-id="${record.id}"] .history-entry-select`)
              .click();
            await poll(
              () =>
                page.evaluate(
                  () => Reflect.get(window, "__restorePending").requests.length,
                ),
              (value) => value > 0,
              "History restoration did not reach the delayed key search",
            );
            await query(page).fill("typed_before_restore");
            if (clear) await query(page).fill("");
            await page.evaluate(() => {
              const pending = Reflect.get(window, "__restorePending");
              pending.raw = undefined;
              for (const request of pending.requests.splice(0))
                Reflect.apply(
                  Reflect.get(window, "__restoreOriginalPostMessage"),
                  request.worker,
                  request.args,
                );
            });
            await expectOutput(
              page,
              JSON.stringify(
                { chosen: clear ? "empty race" : "draft race" },
                null,
                2,
              ),
            );
            assert.equal(
              await page.locator(".key-current code").innerText(),
              record.extraction!.path,
            );
            assert.equal(
              await query(page).inputValue(),
              clear ? "" : "typed_before_restore",
            );
          } finally {
            await page.evaluate(() => {
              Worker.prototype.postMessage = Reflect.get(
                window,
                "__restoreOriginalPostMessage",
              );
            });
          }
        },
      );
    }
    assert.deepEqual(errors, []);
  },
);
