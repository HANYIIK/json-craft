import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";

export async function formatThroughMenu(
  application: ElectronApplication,
  page: Page,
) {
  await page.waitForFunction(() =>
    /kind-(ok|repair|error)/.test(
      document.querySelector('[data-testid="processing-status"]')?.className ??
        "",
    ),
  );
  const previous = await page.evaluate(() => {
    let probe = Reflect.get(window, "__menuFormatProbe") as
      { requests: number } | undefined;
    if (!probe) {
      probe = { requests: 0 };
      Reflect.set(window, "__menuFormatProbe", probe);
      const original = Worker.prototype.postMessage;
      const recorder = {
        postMessage(this: Worker, ...args: unknown[]) {
          if ((args[0] as { kind?: string }).kind === "format")
            Reflect.get(window, "__menuFormatProbe").requests++;
          return Reflect.apply(original, this, args);
        },
      };
      Worker.prototype.postMessage =
        recorder.postMessage as typeof Worker.prototype.postMessage;
    }
    return probe.requests;
  });
  await application.evaluate(({ Menu, BrowserWindow }) => {
    const menu = Menu.getApplicationMenu()!.items.find(
      (item) => item.label === "JSON",
    )!.submenu!;
    const format = menu.items.find(
      (item) => item.accelerator === "CmdOrCtrl+Enter",
    );
    if (!format) throw new Error("The native format command is missing");
    Reflect.apply(format.click, format, [
      format,
      BrowserWindow.getAllWindows()[0],
      {},
    ]);
  });
  await page.waitForFunction(
    (count) => Reflect.get(window, "__menuFormatProbe").requests > count,
    previous,
  );
  await page.waitForFunction(() =>
    /kind-(ok|repair|error)/.test(
      document.querySelector('[data-testid="processing-status"]')?.className ??
        "",
    ),
  );
}

export async function isolateWorkspace(profile: string) {
  const configPath = path.join(profile, "workspace-settings.json");
  try {
    await access(configPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files = path.join(profile, "files");
  const history = path.join(profile, "history");
  await Promise.all(
    [files, history].map((directory) => mkdir(directory, { recursive: true })),
  );
  const [fileDirectory, historyDirectory] = await Promise.all([
    realpath(files),
    realpath(history),
  ]);
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        initialized: false,
        activeId: null,
        settings: {
          readDirectory: fileDirectory,
          writeDirectory: fileDirectory,
          historyDirectory,
          theme: "system",
          autoCopy: false,
          language: "zh-CN",
        },
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
