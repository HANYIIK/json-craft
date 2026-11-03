const nativeEnglish = require("../src/locales/native.en.json");
const diagnosticsEnglish = require("../src/locales/diagnostics.en.json");

function resolveLanguage(locale) {
  return /^zh(?:[-_]|$)/i.test(locale || "") ? "zh-CN" : "en";
}

function interpolate(template, values = {}) {
  return template.replace(/\{\{(\w+)(?:,[^}]+)?\}\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

function messagePattern(template) {
  const names = [];
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

function createNativeI18n() {
  const english = { ...nativeEnglish, ...diagnosticsEnglish };
  const messages = Object.entries(english).flatMap(([key, value]) => [
    { key, text: key, ...messagePattern(key) },
    { key, text: value, ...messagePattern(value) },
  ]);
  const exactMessages = new Map(
    messages
      .filter(({ names }) => names.length === 0)
      .map(({ key, text }) => [text, key]),
  );
  const patterns = messages
    .filter(({ names, meaningful }) => names.length > 0 && meaningful)
    .sort((left, right) => right.specificity - left.specificity);
  let language = "en";
  const t = (key, values) =>
    interpolate(language === "en" ? (english[key] ?? key) : key, values);
  function localizeMessage(message, depth = 0) {
    const exact = exactMessages.get(message);
    if (exact !== undefined) return t(exact);
    for (const { key, pattern, names } of patterns) {
      const match = pattern.exec(message);
      if (
        match &&
        names.includes("count") &&
        (!match[names.indexOf("count") + 1].trim() ||
          !Number.isFinite(
            Number(match[names.indexOf("count") + 1].replaceAll(",", "")),
          ))
      )
        continue;
      if (match)
        return t(
          key,
          Object.fromEntries(
            names.map((name, index) => [
              name,
              depth < 4 && ["message", "detail", "error"].includes(name)
                ? localizeMessage(match[index + 1], depth + 1)
                : match[index + 1],
            ]),
          ),
        );
    }
    return message;
  }
  return {
    t,
    localizeMessage,
    setLanguage(preference, systemLocale) {
      language =
        preference === "system"
          ? resolveLanguage(systemLocale)
          : resolveLanguage(preference);
      return language;
    },
    getLanguage: () => language,
  };
}

module.exports = { createNativeI18n, resolveLanguage };
