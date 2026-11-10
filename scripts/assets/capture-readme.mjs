import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright";
import sharp from "sharp";

const project = fileURLToPath(new URL("../../", import.meta.url));
const target = path.join(project, "resources", "screenshots");
const artifacts = path.join(project, "output", "playwright", "readme");
const viewport = { width: 1440, height: 950 };
const options = { indent: "2", autoUnescape: true, repair: true };
const { version } = JSON.parse(
  await readFile(path.join(project, "package.json"), "utf8"),
);

async function poll(read, valid, message) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (valid(value)) return value;
    await delay(40);
  }
  throw new Error(message);
}

async function text(page, id) {
  const editor = page.getByTestId(id).locator(".cm-content");
  await editor.focus();
  await editor.press("ControlOrMeta+a");
  const value = await editor.evaluate((element) => {
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
  await editor.press("ArrowLeft");
  return value;
}

async function paste(page, id, value) {
  const editor = page.getByTestId(id).locator(".cm-content");
  await editor.focus();
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, value);
}

async function ready(page) {
  await poll(
    () => page.getByTestId("processing-status").getAttribute("class"),
    (value) => /kind-(ok|repair)/.test(value ?? ""),
    "Formatting did not settle",
  );
  await poll(
    () => page.getByTestId("autosave-status").getAttribute("data-save-state"),
    (value) => value === "saved",
    "Demo file did not finish saving",
  );
}

async function screenshot(page, name, language) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.mouse.move(6, 6);
  await page.evaluate(() => document.fonts.ready);
  await delay(500);
  const image = await page.screenshot({ scale: "css", animations: "disabled" });
  const destination = path.join(target, `${name}-${language}.png`);
  await sharp(image)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(destination);
  const metadata = await sharp(destination).metadata();
  assert.equal(metadata.width, viewport.width);
  assert.equal(metadata.height, viewport.height);
  console.log(`${name}-${language}.png ${metadata.width}×${metadata.height}`);
}

async function foldProperty(page, id, property) {
  const value = await text(page, id);
  const line =
    value.split("\n").findIndex((value) => value.includes(`"${property}": [`)) +
    1;
  assert.ok(line > 0, `Missing demo array ${property}`);
  const marker = await poll(
    () =>
      page.getByTestId(id).evaluate((element, number) => {
        const row = [
          ...element.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
        ].find(
          (node) =>
            node.textContent?.trim() === String(number) &&
            getComputedStyle(node).visibility !== "hidden",
        );
        if (!row) return null;
        const bounds = row.getBoundingClientRect();
        const gutter = [
          ...element.querySelectorAll(".cm-foldGutter .cm-gutterElement"),
        ].find(
          (node) =>
            Math.abs(node.getBoundingClientRect().top - bounds.top) <= 1,
        );
        const arrow = gutter?.querySelector("span[title]");
        if (!arrow) return null;
        const rect = arrow.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, line),
    Boolean,
    `Array ${property} did not expose a fold control`,
  );
  await page.mouse.click(marker.x, marker.y);
  await page
    .getByTestId(id)
    .locator(".cm-foldPlaceholder[data-array-items]")
    .waitFor();
}

async function hoverArtifact(page) {
  const tabs = page.getByTestId("log-result-tabs");
  await tabs.hover();
  await delay(250);
  const header = await page.locator(".log-results-header").boundingBox();
  const strip = await tabs.boundingBox();
  assert.ok(header && strip);
  await page.screenshot({
    path: path.join(artifacts, "log-tabs-hover.png"),
    scale: "css",
    clip: {
      x: header.x,
      y: header.y,
      width: header.width,
      height: strip.y + strip.height - header.y + 4,
    },
  });
}

async function capture(language) {
  const zh = language === "zh-CN";
  const label = (chinese, english) => (zh ? chinese : english);
  const root = await mkdtemp("/tmp/json-craft-demo-");
  const profile = path.join(root, "profile");
  const files = path.join(root, "Files");
  const history = path.join(root, "History");
  await Promise.all(
    [profile, files, history].map((directory) => mkdir(directory)),
  );
  const response = {
    requestId: "req-demo-1042",
    status: "ok",
    data: {
      customer: { id: 42, name: "Alex" },
      orders: [
        { id: "ORD-1001", total: 129.9, paid: true },
        { id: "ORD-1002", total: 49.5, paid: false },
      ],
      context: JSON.stringify({ region: "local", attempts: 1 }),
    },
    audit: [JSON.stringify({ event: "response", verified: true })],
  };
  const damaged =
    '{\n  "project": "JSON Craft"\n  "enabled": true,\n  "features": [\n    "format",\n    "repair",\n    "extract",\n    "compare",\n  ],\n  "storage": {\n    "mode": "local"\n    "autosave": true\n  }\n}';
  const features = [
    "format",
    "repair",
    "unescape",
    "extract",
    "compare",
    "history",
  ].map((name, index) => ({ id: index + 1, name, enabled: true }));
  const reference = {
    project: "JSON Craft",
    version: "1.0",
    features,
    storage: { mode: "local", autosave: true },
  };
  const changed = {
    storage: { autosave: true, mode: "local" },
    features: features.map(({ id, name, enabled }, index) => ({
      enabled: index === 3 ? false : enabled,
      name,
      id,
    })),
    version: "1.1",
    project: "JSON Craft",
    exportFormat: "json",
  };
  const time = new Date().toISOString();
  const samples = [
    {
      id: "demo-response",
      name: label("接口响应.json", "api-response.json"),
      raw: JSON.stringify(JSON.stringify(response)),
    },
    {
      id: "demo-repair",
      name: label("修复示例.json", "repair-example.json"),
      raw: damaged,
    },
    {
      id: "demo-config",
      name: label("应用配置.json", "app-config.json"),
      raw: JSON.stringify(reference),
    },
  ];
  for (const item of samples) {
    const managedPath = path.join(files, item.name);
    await writeFile(managedPath, item.raw);
    await writeFile(
      path.join(history, `history-${item.id}.json`),
      JSON.stringify({
        ...item,
        source: "scratch",
        managedPath,
        options,
        createdAt: time,
        updatedAt: time,
      }),
    );
  }
  await writeFile(
    path.join(profile, "workspace-settings.json"),
    JSON.stringify({
      version: 1,
      initialized: true,
      activeId: "demo-response",
      settings: {
        readDirectory: files,
        writeDirectory: files,
        historyDirectory: history,
        theme: "light",
        language,
        autoCopy: false,
        recursiveUnescape: true,
      },
    }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  let app;
  try {
    app = await _electron.launch({
      args: [project, `--user-data-dir=${profile}`],
      cwd: project,
      env,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1440, 950);
      window.show();
      window.focus();
    });
    await page.setViewportSize(viewport);
    await ready(page);
    for (const id of ["demo-repair", "demo-config", "demo-response"]) {
      await page
        .locator(`[data-history-id="${id}"] .history-entry-select`)
        .click();
      await ready(page);
    }
    await foldProperty(page, "output-editor", "orders");
    await screenshot(page, "overview", language);

    await page
      .getByRole("textbox", {
        name: label("提取 key 名称", "Key to extract"),
        exact: true,
      })
      .fill("orders");
    await page
      .getByRole("button", {
        name: label("查找并提取", "Find and extract"),
        exact: true,
      })
      .click();
    await poll(
      () => text(page, "output-editor"),
      (value) => value.startsWith("[") && value.includes("ORD-1001"),
      "Nested order extraction did not settle",
    );
    await ready(page);
    await screenshot(page, "extract", language);

    await page
      .locator('[data-history-id="demo-repair"] .history-entry-select')
      .click();
    await ready(page);
    await page.getByTestId("open-repair-diff").click();
    await poll(
      () =>
        page
          .getByTestId("repair-diff-editor")
          .getAttribute("data-difference-count"),
      (value) => Number(value) > 0,
      "Repair diff did not initialize",
    );
    await screenshot(page, "repair", language);

    await page.getByTestId("diff-back").click();
    await page.getByTestId("open-comparison").click();
    await paste(page, "comparison-left", JSON.stringify(reference));
    await paste(page, "comparison-right", JSON.stringify(changed));
    await poll(
      () => page.getByTestId("compare-json").isEnabled(),
      Boolean,
      "Comparison formatting did not settle",
    );
    await screenshot(page, "comparison-inputs", language);
    await page.getByTestId("compare-json").click();
    await page.getByTestId("comparison-result").waitFor();
    await poll(
      () =>
        page
          .getByTestId("repair-diff-editor")
          .getAttribute("data-difference-count"),
      (value) => Number(value) >= 3,
      "Aligned comparison did not finish",
    );
    await screenshot(page, "comparison-result", language);

    await page.getByTestId("open-log-extraction").click();
    const details = {
      status: 200,
      payload: JSON.stringify({
        customer: "Alex",
        orders: [
          { id: "ORD-1001", total: 129.9 },
          { id: "ORD-1002", total: 49.5 },
        ],
        total: 2,
      }),
      durationMs: 18,
    };
    const log = [
      "2026-11-10 10:24:00 [INFO] Starting request req-demo-1042",
      `2026-11-10 10:24:01 [DEBUG] request=${JSON.stringify({ requestId: "req-demo-1042", method: "GET", path: "/orders" })}`,
      `2026-11-10 10:24:02 [INFO] response=${JSON.stringify(JSON.stringify(details))}`,
      '2026-11-10 10:24:02 [DEBUG] health={"service":"demo","alive":true}',
      '2026-11-10 10:24:03 [INFO] items=[{"id":3,"ready":true},{"id":4,"ready":false}]',
      "2026-11-10 10:24:03 [WARN] recovered={ok:True,retries:1,}",
      '2026-11-10 10:24:04 [DEBUG] preferences={"theme":"system","language":"en"}',
      '2026-11-10 10:24:04 [INFO] timings={"parseMs":4,"formatMs":8}',
      '2026-11-10 10:24:05 [INFO] summary={"complete":true,"saved":false}',
      "2026-11-10 10:24:05 [INFO] Finished; [REDACTED] stays plain text",
    ].join("\n");
    await paste(page, "log-input-editor", log);
    await page.getByTestId("extract-log-json").click();
    await poll(
      () => page.getByRole("tab").count(),
      (count) => count === 8,
      "Log extraction did not return eight real results",
    );
    await poll(
      () => page.locator(".log-results-panel").getAttribute("aria-busy"),
      (value) => value === "false",
      "Log extraction is still pending",
    );
    const close = page.getByRole("button", {
      name: label("关闭 JSON 3", "Close JSON 3"),
      exact: true,
    });
    await close.locator("..").hover();
    await close.click();
    await page
      .getByRole("tab", {
        name: label("预览第 2 项 JSON", "Preview JSON item 2"),
        exact: true,
      })
      .click();
    await poll(
      () => text(page, "log-preview-editor"),
      (value) =>
        value.includes('"orders": [') && value.includes('"durationMs": 18'),
      "Selected log result did not recursively decode",
    );
    await foldProperty(page, "log-preview-editor", "orders");
    await screenshot(page, "log-extract", language);
    if (language === "en") await hoverArtifact(page);
    await page.getByTestId("log-preview-expand").click();
    await poll(
      () => page.locator(".application").getAttribute("data-sidebar-collapsed"),
      (value) => value === "true",
      "Log preview did not expand to the app content area",
    );
    await screenshot(page, "log-extract-expanded", language);
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(artifacts, `capture-${language}.json`),
      JSON.stringify(
        {
          version,
          language,
          viewport,
          count: 7,
          files: samples.map((item) => item.name),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const page = app && (await app.windows())[0];
    if (page)
      await page
        .screenshot({
          path: path.join(artifacts, `failure-${language}.png`),
          scale: "css",
        })
        .catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

await Promise.all(
  [target, artifacts].map((directory) => mkdir(directory, { recursive: true })),
);
for (const language of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["en", "zh-CN"]) {
  assert.ok(["en", "zh-CN"].includes(language), "Use en or zh-CN");
  await capture(language);
}
