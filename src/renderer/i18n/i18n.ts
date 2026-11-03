import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import type { AppLanguage, LanguagePreference } from "../../shared/types";
import appEnglish from "../../locales/app.en.json";
import controlsEnglish from "../../locales/controls.en.json";
import nativeEnglish from "../../locales/native.en.json";
import diagnosticsEnglish from "../../locales/diagnostics.en.json";

const cacheKey = "json-craft.language";
const english: Record<string, string> = {
  ...nativeEnglish,
  ...diagnosticsEnglish,
  ...appEnglish,
  ...controlsEnglish,
};
const chinese = Object.fromEntries(
  Object.keys(english).map((key) => [key, key.replace(/_(one|other)$/, "")]),
);

export function resolveLanguage(locale: string | undefined): AppLanguage {
  return /^zh(?:[-_]|$)/i.test(locale ?? "") ? "zh-CN" : "en";
}

function systemLanguage(): AppLanguage {
  if (typeof window !== "undefined" && window.desktop?.systemLocale)
    return window.desktop.systemLocale;
  return resolveLanguage(
    typeof navigator === "undefined"
      ? undefined
      : (navigator.languages?.[0] ?? navigator.language),
  );
}

function initialPreference(): LanguagePreference {
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached === "zh-CN" || cached === "en" || cached === "system")
      return cached;
    const workspace = JSON.parse(
      localStorage.getItem("json-craft-workspace-v1") ?? "null",
    );
    const preference = workspace?.settings?.language;
    if (preference === "zh-CN" || preference === "en") return preference;
  } catch {}
  return "system";
}

let preference = initialPreference();
const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: chinese },
    en: { translation: english },
  },
  lng: preference === "system" ? systemLanguage() : preference,
  fallbackLng: "en",
  supportedLngs: ["zh-CN", "en"],
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function updateDocumentLanguage() {
  if (typeof document !== "undefined")
    document.documentElement.lang = i18n.language;
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

export function setLanguagePreference(next: LanguagePreference): void {
  if (next !== "system" && next !== "zh-CN" && next !== "en") return;
  preference = next;
  try {
    localStorage.setItem(cacheKey, next);
  } catch {}
  const language = next === "system" ? systemLanguage() : next;
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

export function translate(key: string, vars?: Record<string, unknown>): string {
  return i18n.t(key, vars ?? {}) as string;
}

export function useI18n() {
  useTranslation(undefined, { i18n });
  return { t: translate, language: i18n.language as AppLanguage };
}

function messagePattern(template: string) {
  const names: string[] = [];
  let source = "";
  let from = 0;
  for (const match of template.matchAll(/\{\{(\w+)(?:,[^}]+)?\}\}/g)) {
    source += template
      .slice(from, match.index)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source += "([\\s\\S]*?)";
    names.push(match[1]);
    from = match.index + match[0].length;
  }
  source += template.slice(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fixed = template.replace(/\{\{\w+(?:,[^}]+)?\}\}/g, "");
  return {
    pattern: new RegExp("^" + source + "$"),
    names,
    specificity: fixed.length,
    meaningful: /[\p{L}\p{N}]/u.test(fixed),
  };
}

const messages = Object.entries(english).flatMap(([key, value]) => {
  const base = key.replace(/_(one|other)$/, "");
  const plural = base !== key;
  return [
    { key: base, text: base, plural, ...messagePattern(base) },
    { key: base, text: value, plural, ...messagePattern(value) },
  ];
});
const exactMessages = new Map(
  messages
    .filter(({ names }) => names.length === 0)
    .map(({ key, text }) => [text, key]),
);
const diagnostics = messages
  .filter(({ names, meaningful }) => names.length > 0 && meaningful)
  .sort((left, right) => right.specificity - left.specificity);
const nestedMessages = new Set([
  "message",
  "detail",
  "error",
  "failures",
  "skipped",
  "target",
  "status",
  "action",
]);

export function localizeMessage(message: string, depth = 0): string {
  const exact = exactMessages.get(message);
  if (exact !== undefined) return translate(exact);
  for (const { key, plural, pattern, names } of diagnostics) {
    const match = pattern.exec(message);
    if (!match) continue;
    const values: Record<string, unknown> = Object.fromEntries(
      names.map((name, index) => [
        name,
        depth < 4 && nestedMessages.has(name)
          ? localizeMessage(match[index + 1], depth + 1)
          : match[index + 1],
      ]),
    );
    if (plural || Object.hasOwn(values, "count")) {
      const numeric = String(values.count ?? values.total)
        .replaceAll(",", "")
        .trim();
      if (!numeric) continue;
      const count = Number(numeric);
      if (!Number.isFinite(count)) continue;
      values.count = count;
    }
    return translate(key, values);
  }
  return message;
}
