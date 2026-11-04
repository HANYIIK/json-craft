import { diffChars } from "diff";
import { jsonrepair } from "jsonrepair";
import {
  MAX_FILE_BYTES,
  type FormatOptions,
  type ProcessingError,
  type ProcessingResult,
  type RepairChange,
  type RepairStage,
} from "../../shared/types";

const MAX_DECODE_LAYERS = 8;
const MAX_DIFF_CHARACTERS = 500_000;
const MAX_DIFF_CHANGES = 1_000;
const MAX_OUTPUT_CHARACTERS = MAX_FILE_BYTES * 4;

function positionAt(text: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (text[index] === "\n") {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function syntaxOffset(text: string): number | undefined {
  const frames: { kind: "root" | "object" | "array"; state: string }[] = [
    { kind: "root", state: "value" },
  ];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let offset = 0;
  const string = (): number | undefined => {
    offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return undefined;
      if (char.charCodeAt(0) < 32) return offset - 1;
      if (char === "\\") {
        const escape = text[offset++];
        if (escape === "u") {
          for (let index = 0; index < 4; index++) {
            if (!/[\da-f]/i.test(text[offset] ?? "")) return offset;
            offset++;
          }
        } else if (!escape || !'"\\/bfnrt'.includes(escape))
          return Math.min(offset - 1, text.length);
      }
    }
    return text.length;
  };
  while (frames.length) {
    while (offset < text.length && " \t\r\n".includes(text[offset])) offset++;
    const frame = frames[frames.length - 1];
    const char = text[offset];
    if (frame.state === "end")
      return offset === text.length ? undefined : offset;
    if (frame.state === "keyOrEnd" && char === "}") {
      frames.pop();
      offset++;
      continue;
    }
    if (frame.state === "keyOrEnd" || frame.state === "key") {
      if (char !== '"') return offset;
      const error = string();
      if (error !== undefined) return error;
      frame.state = "colon";
      continue;
    }
    if (frame.state === "colon") {
      if (char !== ":") return offset;
      offset++;
      frame.state = "value";
      continue;
    }
    if (frame.state === "commaOrEnd") {
      if (char === (frame.kind === "array" ? "]" : "}")) {
        frames.pop();
        offset++;
      } else if (char === ",") {
        offset++;
        frame.state = frame.kind === "array" ? "value" : "key";
      } else return offset;
      continue;
    }
    if (frame.state === "valueOrEnd" && char === "]") {
      frames.pop();
      offset++;
      continue;
    }
    frame.state = frame.kind === "root" ? "end" : "commaOrEnd";
    if (char === '"') {
      const error = string();
      if (error !== undefined) return error;
    } else if (char === "{" || char === "[") {
      offset++;
      frames.push({
        kind: char === "{" ? "object" : "array",
        state: char === "{" ? "keyOrEnd" : "valueOrEnd",
      });
    } else {
      const literal = ["true", "false", "null"].find((value) =>
        text.startsWith(value, offset),
      );
      if (literal) offset += literal.length;
      else {
        number.lastIndex = offset;
        const match = number.exec(text);
        if (!match) return offset;
        offset += match[0].length;
      }
    }
  }
  return offset === text.length ? undefined : offset;
}

function processingError(
  error: unknown,
  text: string,
  layer: number,
  prefix: string,
): ProcessingError {
  const message = error instanceof Error ? error.message : String(error);
  const reported =
    typeof error === "object" && error !== null && "position" in error
      ? Number(error.position)
      : NaN;
  const matched = /(?:at position|position)\s+(\d+)/i.exec(message);
  const location = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  const offset = Number.isFinite(reported)
    ? reported
    : matched
      ? Number(matched[1])
      : /unexpected end/i.test(message)
        ? text.length
        : error instanceof SyntaxError
          ? syntaxOffset(text)
          : undefined;
  return {
    message: `${prefix}${message}`,
    layer,
    ...(offset !== undefined
      ? { offset, ...positionAt(text, offset) }
      : location
        ? { line: Number(location[1]), column: Number(location[2]) }
        : {}),
  };
}

function repairStage(
  before: string,
  after: string,
  layer: number,
  index: number,
): RepairStage {
  const id = `repair-${index + 1}`;
  const stage: RepairStage = {
    id,
    layer,
    before,
    after,
    changes: [],
    diffTruncated: false,
  };
  if (before.length + after.length > MAX_DIFF_CHARACTERS) {
    stage.diffTruncated = true;
    return stage;
  }
  const parts = diffChars(before, after, {
    timeout: 150,
    maxEditLength: 4_000,
  });
  if (!parts) {
    stage.diffTruncated = true;
    return stage;
  }
  let offset = 0;
  let line = 1;
  let column = 1;
  let pending:
    | {
        start: number;
        before: string;
        after: string;
        line: number;
        column: number;
      }
    | undefined;
  const advance = (value: string) => {
    offset += value.length;
    for (const char of value) {
      if (char === "\n") {
        line++;
        column = 1;
      } else column += char.length;
    }
  };
  const finish = () => {
    if (!pending) return;
    const label = !pending.before
      ? "插入字符"
      : !pending.after
        ? "删除字符"
        : "替换字符";
    const change: RepairChange = {
      id: `${id}-change-${stage.changes.length + 1}`,
      label,
      before: pending.before,
      after: pending.after,
      start: pending.start,
      end: pending.start + pending.before.length,
      line: pending.line,
      column: pending.column,
      layer,
      stageId: id,
    };
    stage.changes.push(change);
    pending = undefined;
  };
  for (const part of parts) {
    if (part.added || part.removed) {
      pending ??= { start: offset, before: "", after: "", line, column };
      if (part.removed) {
        pending.before += part.value;
        advance(part.value);
      } else {
        pending.after += part.value;
      }
    } else {
      finish();
      advance(part.value);
    }
    if (stage.changes.length > MAX_DIFF_CHANGES) {
      stage.changes = [];
      stage.diffTruncated = true;
      return stage;
    }
  }
  finish();
  if (stage.changes.length > MAX_DIFF_CHANGES) {
    stage.changes = [];
    stage.diffTruncated = true;
  }
  return stage;
}

function hasEscapedEnvelope(text: string): boolean {
  const trimmed = text.trimStart();
  if (!/^[{\[\\]/.test(trimmed)) return false;
  const quote = trimmed.indexOf('"');
  if (quote < 1) return false;
  let slashes = 0;
  for (let index = quote - 1; index >= 0 && trimmed[index] === "\\"; index--)
    slashes++;
  return slashes > 0;
}

function decodeEscapedEnvelope(text: string): string | undefined {
  if (!hasEscapedEnvelope(text)) return undefined;
  const quoted = text
    .replace(/(\\*)"/g, (match, slashes: string) =>
      slashes.length % 2 === 0 ? `${slashes}\\"` : match,
    )
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  try {
    const decoded: unknown = JSON.parse(`"${quoted}"`);
    return typeof decoded === "string" &&
      decoded !== text &&
      /^(?:[{\[]|\\|\")/.test(decoded.trimStart())
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function skipJsonTrivia(text: string, start: number): number {
  let offset = start;
  while (offset < text.length) {
    if (/\s/.test(text[offset])) offset++;
    else if (text.startsWith("//", offset)) {
      const end = text.indexOf("\n", offset + 2);
      offset = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", offset)) {
      const end = text.indexOf("*/", offset + 2);
      offset = end < 0 ? text.length : end + 2;
    } else break;
  }
  return offset;
}

function hasStructuredEnvelope(text: string): boolean {
  const frames: ("array" | "key" | "value")[] = [];
  const scalar =
    /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/iy;
  let quote = "";
  let unquoted = false;
  let structuredContent = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (char === "\\") {
      if (!quote) unquoted = true;
      offset++;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (/\s/.test(char)) continue;
    else if (!unquoted && (char === '"' || char === "'" || char === "`")) {
      structuredContent = true;
      quote = char;
    } else if (
      !unquoted &&
      ((text.startsWith("//", offset) && text.indexOf("\n", offset + 2) >= 0) ||
        (text.startsWith("/*", offset) && text.indexOf("*/", offset + 2) >= 0))
    ) {
      offset = skipJsonTrivia(text, offset) - 1;
    } else if (char === "{" || char === "[") {
      if (frames.length) structuredContent = true;
      frames.push(char === "{" ? "key" : "array");
      unquoted = false;
    } else if (char === "}" || char === "]") {
      if (!unquoted) structuredContent = true;
      frames.pop();
      unquoted = false;
      if (!frames.length) {
        if (!structuredContent) return false;
        let next = skipJsonTrivia(text, offset + 1);
        if (next === text.length) return true;
        if (text[next] === ",") {
          next = skipJsonTrivia(text, next + 1);
          return (
            next === text.length || text[next] === "{" || text[next] === "["
          );
        }
        return (
          (text[next] === "{" || text[next] === "[") &&
          text.slice(offset + 1, next).includes("\n")
        );
      }
    } else if (char === ",") {
      structuredContent = true;
      if (frames[frames.length - 1] === "value")
        frames[frames.length - 1] = "key";
      unquoted = false;
    } else if (char === ":" && frames[frames.length - 1] === "key") {
      structuredContent = true;
      frames[frames.length - 1] = "value";
      unquoted = false;
    } else if (!unquoted && frames[frames.length - 1] !== "key") {
      scalar.lastIndex = offset;
      const token = scalar.exec(text);
      const end = offset + (token?.[0].length ?? 0);
      if (
        token &&
        (end === text.length ||
          /[\s,\]}]/.test(text[end]) ||
          text.startsWith("//", end) ||
          text.startsWith("/*", end))
      ) {
        structuredContent = true;
        offset += token[0].length - 1;
      } else unquoted = true;
    } else unquoted = true;
  }
  return structuredContent || (!unquoted && frames.length > 0);
}

export function wrapsStructuredJson(value: string): boolean {
  let candidate = value;
  for (let count = 0; count <= MAX_DECODE_LAYERS; count++) {
    const trimmed = candidate.trimStart();
    const decoded = decodeEscapedEnvelope(candidate);
    if (decoded !== undefined) {
      candidate = decoded;
      continue;
    }
    if (/^[{\[]/.test(trimmed)) return hasStructuredEnvelope(trimmed);
    if (!trimmed.startsWith('"')) return false;
    try {
      const next: unknown = JSON.parse(candidate);
      if (typeof next !== "string") return false;
      candidate = next;
    } catch {
      return false;
    }
  }
  return true;
}

function formatTokens(text: string, options: FormatOptions): string {
  const indent =
    options.indent === "tab" ? "\t" : " ".repeat(Number(options.indent));
  const chunks: string[] = [];
  let parts: string[] = [];
  let chunkLength = 0;
  let depth = 0;
  let outputLength = 0;
  const indentation = [""];
  const indentAt = (level: number) => {
    if (level > 128) return indent.repeat(level);
    while (indentation.length <= level)
      indentation.push(indentation[indentation.length - 1] + indent);
    return indentation[level];
  };
  const whitespace = (code: number) =>
    code === 32 || code === 9 || code === 10 || code === 13;
  const append = (part: string) => {
    outputLength += part.length;
    if (outputLength > MAX_OUTPUT_CHARACTERS)
      throw new Error("格式化结果过大，请减少嵌套层级或拆分文件。");
    if (part.length >= 32_768) {
      if (parts.length) chunks.push(parts.join(""));
      parts = [];
      chunkLength = 0;
      chunks.push(part);
      return;
    }
    parts.push(part);
    chunkLength += part.length;
    if (chunkLength >= 32_768 || parts.length >= 1_024) {
      chunks.push(parts.join(""));
      parts = [];
      chunkLength = 0;
    }
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (whitespace(code)) continue;
    if (code === 34) {
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
        index++;
      }
      append(text.slice(start, index + 1));
    } else if (code === 123 || code === 91) {
      let next = index + 1;
      while (next < text.length && whitespace(text.charCodeAt(next))) next++;
      const close = code === 123 ? 125 : 93;
      if (text.charCodeAt(next) === close) {
        append(text[index] + text[next]);
        index = next;
      } else {
        depth++;
        append(`${text[index]}\n${indentAt(depth)}`);
      }
    } else if (code === 125 || code === 93) {
      depth--;
      append(`\n${indentAt(depth)}${text[index]}`);
    } else if (code === 44) {
      append(`,\n${indentAt(depth)}`);
    } else if (code === 58) {
      append(": ");
    } else {
      const start = index;
      while (index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (
          whitespace(next) ||
          next === 123 ||
          next === 125 ||
          next === 91 ||
          next === 93 ||
          next === 44 ||
          next === 58
        )
          break;
        index++;
      }
      append(text.slice(start, index + 1));
    }
  }
  if (parts.length) chunks.push(parts.join(""));
  return chunks.join("");
}

export function processJson(
  raw: string,
  options: FormatOptions,
): ProcessingResult {
  const stages: RepairStage[] = [];
  let decodedLayers = 0;
  const result = (
    success: boolean,
    output: string,
    error?: ProcessingError,
  ): ProcessingResult => ({
    success,
    output,
    decodedLayers,
    stages,
    changeCount: stages.some((stage) => stage.diffTruncated)
      ? null
      : stages.reduce((count, stage) => count + stage.changes.length, 0),
    ...(error ? { error } : {}),
  });
  if (
    raw.length > MAX_FILE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_FILE_BYTES
  ) {
    return result(false, "", { message: "文件超过 20 MiB，请拆分后重试。" });
  }
  if (!raw.trim())
    return result(false, "", {
      message: "请输入 JSON 内容。",
      line: 1,
      column: 1,
      offset: 0,
      layer: 0,
    });
  let text = raw;
  const decode = (next: string): ProcessingResult | undefined => {
    if (decodedLayers >= MAX_DECODE_LAYERS) {
      return result(false, "", {
        message: `JSON 转义超过 ${MAX_DECODE_LAYERS} 层，请手动移除外层包装后重试。`,
        layer: decodedLayers,
      });
    }
    decodedLayers++;
    text = next;
    return undefined;
  };
  while (true) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      const decoded = options.autoUnescape
        ? decodeEscapedEnvelope(text)
        : undefined;
      if (decoded !== undefined) {
        const error = decode(decoded);
        if (error) return error;
        continue;
      }
      if (!options.repair)
        return result(
          false,
          "",
          processingError(
            parseError,
            text,
            decodedLayers,
            "JSON 语法无效，已关闭自动修复：",
          ),
        );
      try {
        const repaired = jsonrepair(text);
        parsed = JSON.parse(repaired);
        if (repaired !== text)
          stages.push(
            repairStage(text, repaired, decodedLayers, stages.length),
          );
        text = repaired;
      } catch (repairError) {
        return result(
          false,
          "",
          processingError(
            repairError,
            text,
            decodedLayers,
            "无法修复此 JSON：",
          ),
        );
      }
    }
    if (
      options.autoUnescape &&
      typeof parsed === "string" &&
      wrapsStructuredJson(parsed)
    ) {
      const error = decode(parsed);
      if (error) return error;
      continue;
    }
    try {
      return result(true, formatTokens(text, options));
    } catch (formatError) {
      return result(
        false,
        "",
        processingError(formatError, text, decodedLayers, ""),
      );
    }
  }
}
