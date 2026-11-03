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

async function poll<T>(read: () => Promise<T>, valid: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  do {
    const value = await read();
    if (valid(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail("The sidebar transition did not settle");
}

async function settled(page: Page) {
  await poll(
    () => page.locator("html").getAttribute("data-json-sidebar-motion"),
    (value) => value === null,
  );
}

async function clickToggle(page: Page) {
  await page
    .locator('.titlebar-navigation [aria-controls="workspace-sidebar"]')
    .click();
  await settled(page);
}

test(
  "Electron sidebar motion preserves the editor and stays interruptible",
  {
    timeout: 90_000,
  },
  async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "json-craft-motion-"));
    await isolateWorkspace(profile);
    const configPath = path.join(profile, "workspace-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.settings.language = "zh-CN";
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
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 780);
      window.show();
      window.focus();
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByTestId("input-editor").locator(".cm-content").waitFor();
    await poll(
      () =>
        page.getByRole("button", { name: "新建输入", exact: true }).isEnabled(),
      Boolean,
    );
    await page.evaluate(() => {
      const original = document.startViewTransition.bind(document);
      const state = {
        started: 0,
        ready: 0,
        finished: 0,
        updates: 0,
        skipped: 0,
        pointerEvents: "",
      };
      Reflect.set(window, "__sidebarMotionState", state);
      Reflect.set(window, "__sidebarMotionNative", original);
      document.startViewTransition = ((update: () => void) => {
        state.started++;
        const transition = original(() => {
          state.updates++;
          update();
        });
        const skip = transition.skipTransition.bind(transition);
        transition.skipTransition = () => {
          state.skipped++;
          skip();
        };
        void transition.ready.then(
          () => {
            state.ready++;
            state.pointerEvents = getComputedStyle(
              document.documentElement,
              "::view-transition",
            ).pointerEvents;
          },
          () => {},
        );
        void transition.finished.then(
          () => {
            state.finished++;
          },
          () => {},
        );
        return transition;
      }) as typeof document.startViewTransition;
    });

    await t.test(
      "animates snapshots while committing editor width once",
      async () => {
        const content = await page
          .getByTestId("input-editor")
          .locator(".cm-content")
          .elementHandle();
        assert.ok(content);
        await page.evaluate(() => {
          const editor = document.querySelector(
            '[data-testid="input-editor"] .cm-editor',
          )!;
          const widths = new Set<number>();
          const sampler = {
            collect() {
              widths.add(editor.getBoundingClientRect().width);
              if (
                document.documentElement.hasAttribute(
                  "data-json-sidebar-motion",
                )
              )
                requestAnimationFrame(sampler.collect);
            },
          };
          widths.add(editor.getBoundingClientRect().width);
          Reflect.set(window, "__sidebarMotionWidths", widths);
          document
            .querySelector<HTMLButtonElement>(
              '.titlebar-navigation [aria-controls="workspace-sidebar"]',
            )!
            .click();
          requestAnimationFrame(sampler.collect);
        });
        await settled(page);
        const state = await page.evaluate(() => ({
          ...Reflect.get(window, "__sidebarMotionState"),
          widths: Array.from(Reflect.get(window, "__sidebarMotionWidths")),
        }));
        assert.equal(state.started, 1);
        assert.equal(state.ready, 1);
        assert.equal(state.finished, 1);
        assert.equal(state.updates, 1);
        assert.equal(state.pointerEvents, "none");
        assert.equal(
          state.widths.length,
          2,
          `Editor width was animated: ${JSON.stringify(state.widths)}`,
        );
        assert.equal(
          await content.evaluate(
            (element) =>
              element ===
              document.querySelector(
                '[data-testid="input-editor"] .cm-content',
              ),
          ),
          true,
        );
        await clickToggle(page);
      },
    );

    await t.test(
      "cancels capture and animation safely during rapid toggles",
      async () => {
        await page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '.titlebar-navigation [aria-controls="workspace-sidebar"]',
          )!;
          for (let index = 0; index < 6; index++) button.click();
        });
        await settled(page);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          true,
        );
        const state = await page.evaluate(() =>
          Reflect.get(window, "__sidebarMotionState"),
        );
        assert.equal(state.started, state.updates);
        assert.ok(state.skipped >= 5);
        await page
          .getByRole("button", { name: "新建输入", exact: true })
          .click();
        assert.match(
          await page.getByTestId("active-file-name").innerText(),
          /^untitled-\d+\.json$/,
        );
      },
    );

    await t.test(
      "uses the settings page snapshot without duplicate transition names",
      async () => {
        await page
          .getByRole("button", { name: "应用设置", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "应用设置", level: 1 })
          .waitFor();
        await clickToggle(page);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        await clickToggle(page);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          true,
        );
        await page
          .getByRole("button", { name: "关闭应用设置", exact: true })
          .click();
      },
    );

    await t.test(
      "switches immediately with reduced motion and cancels an active animation",
      async () => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const before = await page.evaluate(
          () => Reflect.get(window, "__sidebarMotionState").started,
        );
        await clickToggle(page);
        await clickToggle(page);
        assert.equal(
          await page.evaluate(
            () => Reflect.get(window, "__sidebarMotionState").started,
          ),
          before,
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() =>
          document
            .querySelector<HTMLButtonElement>(
              '.titlebar-navigation [aria-controls="workspace-sidebar"]',
            )!
            .click(),
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        await settled(page);
        assert.equal(
          await page.locator("#workspace-sidebar").isVisible(),
          false,
        );
        await clickToggle(page);
        await page.emulateMedia({ reducedMotion: "no-preference" });
      },
    );

    await t.test(
      "keeps the toggle functional when native transitions are unavailable",
      async () => {
        await page.evaluate(() => {
          Reflect.set(
            window,
            "__sidebarMotionWrapped",
            document.startViewTransition,
          );
          Reflect.set(document, "startViewTransition", undefined);
        });
        try {
          await clickToggle(page);
          assert.equal(
            await page.locator("#workspace-sidebar").isVisible(),
            false,
          );
          await clickToggle(page);
          assert.equal(
            await page.locator("#workspace-sidebar").isVisible(),
            true,
          );
        } finally {
          await page.evaluate(() =>
            Reflect.set(
              document,
              "startViewTransition",
              Reflect.get(window, "__sidebarMotionWrapped"),
            ),
          );
        }
      },
    );

    assert.deepEqual(errors, []);
  },
);
