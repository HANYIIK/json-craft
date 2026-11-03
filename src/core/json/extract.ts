import { visit, type JSONPath } from "jsonc-parser";
import { processJson } from "./json";
import type {
  FormatOptions,
  JsonValueType,
  KeyMatch,
  KeySearchResult,
} from "../../shared/types";

const MAX_MATCHES = 1_000;
const MAX_SEARCH_DEPTH = 512;
const PREVIEW_LENGTH = 100;

function pathLabel(path: JSONPath): string {
  return (
    "$" +
    path
      .map((segment) =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_$][\w$]*$/.test(segment)
            ? `.${segment}`
            : `[${JSON.stringify(segment)}]`,
      )
      .join("")
  );
}

function withinDepthLimit(text: string): boolean {
  let depth = 0;
  let insideString = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (insideString) {
      if (character === "\\") offset++;
      else if (character === '"') insideString = false;
    } else if (character === '"') insideString = true;
    else if (character === "{" || character === "[") {
      if (++depth > MAX_SEARCH_DEPTH) return false;
    } else if (character === "}" || character === "]") depth--;
  }
  return true;
}

function valuePreview(text: string, start: number, end: number): string {
  const prefixEnd = Math.min(end, start + PREVIEW_LENGTH * 2);
  let prefix = "";
  let insideString = false;
  for (let offset = start; offset < prefixEnd; offset++) {
    const character = text[offset];
    if (insideString) {
      prefix += character;
      if (character === "\\" && offset + 1 < prefixEnd)
        prefix += text[++offset];
      else if (character === '"') insideString = false;
    } else if (character === '"') {
      insideString = true;
      prefix += character;
    } else if (/\s/.test(character)) {
      if (!prefix.endsWith(" ")) prefix += " ";
    } else prefix += character;
  }
  prefix = prefix.trim();
  return prefix.length > PREVIEW_LENGTH || prefixEnd < end
    ? prefix.slice(0, PREVIEW_LENGTH - 1) + "…"
    : prefix;
}

export function findKeyValues(
  raw: string,
  key: string,
  options: FormatOptions,
): KeySearchResult {
  const preparation = processJson(raw, options);
  const result: KeySearchResult = {
    key,
    preparation,
    matches: [],
    truncated: false,
  };
  if (!preparation.success) return result;
  if (!key.length) return { ...result, error: "请输入要提取的 key 名称。" };
  const source = preparation.output;
  if (!withinDepthLimit(source))
    return {
      ...result,
      error: `JSON 嵌套超过 ${MAX_SEARCH_DEPTH} 层，请缩小检索范围后重试。`,
    };

  const counts = new Map<string, number>();
  const containers: (KeyMatch | undefined)[] = [];
  let pending = false;
  let parseError: string | undefined;

  function beginValue(
    type: JsonValueType,
    offset: number,
    length: number,
    line: number,
    column: number,
    path: () => JSONPath,
  ): KeyMatch | undefined {
    const matches = pending;
    pending = false;
    if (!matches) return undefined;
    const label = pathLabel(path());
    const occurrence = (counts.get(label) ?? 0) + 1;
    if (result.matches.length >= MAX_MATCHES) {
      result.truncated = true;
      if (counts.has(label)) counts.set(label, occurrence);
      return undefined;
    }
    counts.set(label, occurrence);
    const match: KeyMatch = {
      id: `key-value-${offset}`,
      path: label,
      type,
      preview: "",
      start: offset,
      end: offset + length,
      line: line + 1,
      column: column + 1,
      occurrence,
      occurrences: occurrence,
    };
    result.matches.push(match);
    return match;
  }

  function finishContainer(offset: number, length: number) {
    const match = containers.pop();
    if (!match) return;
    match.end = offset + length;
    match.preview = valuePreview(source, match.start, match.end);
  }

  try {
    visit(
      source,
      {
        onObjectProperty: (property) => {
          pending = property === key;
        },
        onObjectBegin: (offset, length, line, column, path) => {
          containers.push(
            beginValue("object", offset, length, line, column, path),
          );
        },
        onArrayBegin: (offset, length, line, column, path) => {
          containers.push(
            beginValue("array", offset, length, line, column, path),
          );
        },
        onObjectEnd: finishContainer,
        onArrayEnd: finishContainer,
        onLiteralValue: (
          value: unknown,
          offset,
          length,
          line,
          column,
          path,
        ) => {
          const type: JsonValueType =
            value === null
              ? "null"
              : typeof value === "string"
                ? "string"
                : typeof value === "number"
                  ? "number"
                  : "boolean";
          const match = beginValue(type, offset, length, line, column, path);
          if (match)
            match.preview = valuePreview(source, offset, offset + length);
        },
        onError: (_error, _offset, _length, line, column) => {
          parseError ??= `无法解析检索内容，第 ${line + 1} 行第 ${column + 1} 列。`;
        },
      },
      {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      },
    );
  } catch {
    return {
      ...result,
      matches: [],
      truncated: false,
      error: "无法完成 key 检索，请缩小输入范围后重试。",
    };
  }
  if (parseError)
    return { ...result, matches: [], truncated: false, error: parseError };
  for (const match of result.matches)
    match.occurrences = counts.get(match.path) ?? 1;
  return result;
}
