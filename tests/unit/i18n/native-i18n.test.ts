import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createNativeI18n, resolveLanguage } =
  require("../../../electron/i18n.cjs") as {
    createNativeI18n(): {
      t(key: string, values?: Record<string, unknown>): string;
      setLanguage(preference: string, systemLocale: string): string;
      getLanguage(): string;
      localizeMessage(message: string): string;
    };
    resolveLanguage(locale: string | undefined): string;
  };

test("native menu localization follows system language or the explicit preference", () => {
  const i18n = createNativeI18n();
  assert.equal(resolveLanguage("zh-Hant-TW"), "zh-CN");
  assert.equal(resolveLanguage("fr-FR"), "en");
  assert.equal(resolveLanguage(undefined), "en");
  i18n.setLanguage("system", "zh-Hans-CN");
  assert.equal(i18n.t("新建输入"), "新建输入");
  i18n.setLanguage("en", "zh-CN");
  assert.equal(i18n.t("新建输入"), "New input");
  assert.equal(i18n.t("导入 JSON 文件"), "Import JSON files");
  i18n.setLanguage("zh-CN", "en");
  assert.equal(i18n.getLanguage(), "zh-CN");
});

test("native exact diagnostics and specific nested templates translate in both directions", () => {
  const i18n = createNativeI18n();
  i18n.setLanguage("en", "en");
  assert.equal(
    i18n.localizeMessage("所选路径不是目录。"),
    "The selected path is not a folder.",
  );
  const localized =
    "The input is saved in workspace history, but the JSON file could not be autosaved: The selected path is not a folder.";
  assert.equal(
    i18n.localizeMessage(
      "原文已保存到应用历史，但 JSON 文件自动保存失败：所选路径不是目录。",
    ),
    localized,
  );
  i18n.setLanguage("zh-CN", "en");
  assert.equal(
    i18n.localizeMessage(localized),
    "原文已保存到应用历史，但 JSON 文件自动保存失败：所选路径不是目录。",
  );
  const path = "/tmp/数据，设置/file {{count}} <tag>.json";
  assert.equal(
    i18n.localizeMessage(
      `Unable to prepare folder ${path}: The selected path is not a folder.`,
    ),
    `无法准备目录 ${path}：所选路径不是目录。`,
  );
});

test("native unknown technical messages retain punctuation, paths, and user data", () => {
  const i18n = createNativeI18n();
  for (const language of ["en", "zh-CN"]) {
    i18n.setLanguage(language, "en");
    for (const message of [
      "EACCES: /tmp/原文.json, operation failed",
      "EACCES: /tmp/原文.json，操作失败",
      '{"name":"应用设置","value":"中文, English"}',
      "Unknown error at /tmp/数据 {{count}}.json",
    ])
      assert.equal(i18n.localizeMessage(message), message);
  }
});
