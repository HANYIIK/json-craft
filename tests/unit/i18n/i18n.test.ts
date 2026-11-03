import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  getLanguagePreference,
  localizeMessage,
  resolveLanguage,
  setLanguagePreference,
  translate,
} from "../../../src/renderer/i18n/i18n";

const catalogs = ["app", "controls", "native", "diagnostics"].map(
  (name) =>
    JSON.parse(
      readFileSync(
        new URL(`../../../src/locales/${name}.en.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>,
);

test("language selection, live diagnostics, and catalog integrity", async (suite) => {
  const previous = getLanguagePreference();
  try {
    await suite.test(
      "normalizes Chinese locales and falls back to English",
      () => {
        for (const locale of ["zh", "zh-CN", "zh-TW", "zh_Hans_CN", "ZH-hk"])
          assert.equal(resolveLanguage(locale), "zh-CN");
        for (const locale of [
          undefined,
          "",
          "en-US",
          "fr-FR",
          "ja-JP",
          "zhfoo",
        ])
          assert.equal(resolveLanguage(locale), "en");
      },
    );

    await suite.test(
      "switches immediately and handles English plural forms",
      () => {
        setLanguagePreference("en");
        assert.equal(translate("应用设置"), "Settings");
        assert.equal(translate("… {{count}} 项", { count: 1 }), "… 1 item");
        assert.equal(translate("… {{count}} 项", { count: 12 }), "… 12 items");
        assert.equal(
          translate("展开数组（{{count}} 项）", { count: 0 }),
          "Expand array (0 items)",
        );
        assert.equal(
          translate("已导入 {{count}} 个文件", { count: 1 }),
          "Imported 1 file",
        );
        assert.equal(
          translate("已导入 {{count}} 个文件", { count: 3 }),
          "Imported 3 files",
        );
        assert.equal(
          translate("{{total}} 行 · {{indent}}", {
            count: 1,
            total: "1",
            indent: "2 spaces",
          }),
          "1 line · 2 spaces",
        );
        assert.equal(
          translate("{{total}} 行 · {{indent}}", {
            count: 1000,
            total: "1,000",
            indent: "2 spaces",
          }),
          "1,000 lines · 2 spaces",
        );
        setLanguagePreference("zh-CN");
        assert.equal(translate("应用设置"), "应用设置");
        assert.equal(translate("… {{count}} 项", { count: 12 }), "… 12 项");
        assert.equal(
          translate("已导入 {{count}} 个文件", { count: 1 }),
          "已导入 1 个文件",
        );
      },
    );

    await suite.test(
      "relocalizes an existing message in either direction",
      () => {
        setLanguagePreference("en");
        assert.equal(localizeMessage("已导入 1 个文件"), "Imported 1 file");
        assert.equal(localizeMessage("已导入 3 个文件"), "Imported 3 files");
        const message = translate(
          "已创建 {{count}} 个输入，{{failed}} 个文件未能保存到存储目录，跳过 {{skipped}} 个非 JSON 文件",
          { count: 1, failed: 2, skipped: 3 },
        );
        setLanguagePreference("zh-CN");
        assert.equal(
          localizeMessage(message),
          "已创建 1 个输入，2 个文件未能保存到存储目录，跳过 3 个非 JSON 文件",
        );
        assert.equal(localizeMessage("Imported 3 files"), "已导入 3 个文件");
      },
    );

    await suite.test(
      "translates nested diagnostics while preserving user values",
      () => {
        setLanguagePreference("en");
        assert.equal(
          localizeMessage("自动保存失败：设置尚未保存。"),
          "Auto-save failed: Settings have not been saved yet.",
        );
        const name = "应用设置/复制 <tag> & {{count}}.json";
        assert.equal(
          translate("已重命名为 {{name}}", { name }),
          `Renamed to ${name}`,
        );
        assert.equal(
          localizeMessage(`已重命名为 ${name}`),
          `Renamed to ${name}`,
        );
        const technical = "EACCES: /Users/测试/原始输入.json";
        assert.equal(localizeMessage(technical), technical);
        setLanguagePreference("zh-CN");
        assert.equal(
          localizeMessage(`Renamed to ${name}`),
          `已重命名为 ${name}`,
        );
      },
    );

    await suite.test(
      "specific diagnostics take priority over general UI templates",
      () => {
        setLanguagePreference("en");
        assert.equal(
          localizeMessage("查找失败，请重试。"),
          translate("查找失败，请重试。"),
        );
        assert.equal(
          localizeMessage("无法读取源 JSON，请检查内容后重试。"),
          translate("无法读取源 JSON，请检查内容后重试。"),
        );
        const technical = "EACCES，/Users/测试/文件.json，operation rejected";
        assert.equal(localizeMessage(technical), technical);
        assert.equal(localizeMessage("invalid chars"), "invalid chars");
      },
    );

    await suite.test(
      "all literal UI keys have bundled English translations",
      () => {
        const catalog = Object.assign({}, ...catalogs) as Record<
          string,
          string
        >;
        for (const file of [
          "app/App.tsx",
          "features/settings/WorkspaceSettings.tsx",
          "features/history/HistoryEntry.tsx",
          "features/extraction/KeyExtractor.tsx",
          "features/editor/JsonEditor.tsx",
          "features/repair-diff/RepairDiffPage.tsx",
          "features/repair-diff/RepairDiffEditor.tsx",
          "components/Select.tsx",
          "features/editor/search-panel.ts",
        ]) {
          const source = readFileSync(
            new URL(`../../../src/renderer/${file}`, import.meta.url),
            "utf8",
          );
          for (const match of source.matchAll(/\bt\(\s*"([^"\n]+)"/g))
            assert.ok(
              catalog[match[1]] || catalog[match[1] + "_other"],
              `${file}: missing ${match[1]}`,
            );
        }
        for (const entries of catalogs) {
          for (const [key, value] of Object.entries(entries)) {
            assert.ok(value.trim(), `Empty translation for ${key}`);
            const parameters = (text: string) =>
              [...text.matchAll(/\{\{(\w+)(?:,[^}]+)?\}\}/g)]
                .map((match) => match[1])
                .sort();
            assert.deepEqual(
              parameters(value),
              parameters(key),
              `Placeholder mismatch for ${key}`,
            );
          }
        }
      },
    );
  } finally {
    setLanguagePreference(previous);
  }
});
