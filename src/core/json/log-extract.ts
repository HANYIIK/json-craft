import { processStructuredJson } from "./extracted-json";
import { wrapsStructuredJson } from "./json";
import {
  MAX_FILE_BYTES,
  type FormatOptions,
  type ProcessingResult,
} from "../../shared/types";

export const MAX_LOG_RESULTS = 200;
const MAX_STORED_CANDIDATES = 20_000;
const MAX_ATTEMPTS = 1_024;
const MAX_SCAN_DEPTH = 1_024;
const MAX_WORK_CHARACTERS = MAX_FILE_BYTES * 4;
const MAX_OUTPUT_CHARACTERS = MAX_FILE_BYTES * 4;

export interface LogJsonCandidate {
  id: string;
  raw: string;
  start: number;
  end: number;
  line: number;
  column: number;
  result: ProcessingResult;
}

export interface LogExtractionResult {
  items: LogJsonCandidate[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

interface Candidate {
  start: number;
  end: number;
  line: number;
  column: number;
  close: string;
  children: Candidate[];
  limited: boolean;
  depthLimited: boolean;
  ignored: boolean;
}

function plausibleString(text: string, start: number, end: number): boolean {
  let offset = start + 1;
  while (offset < end && /\s/.test(text[offset])) offset++;
  return '{[\\"'.includes(text[offset] ?? " ");
}

function plausibleArray(text: string, start: number): boolean {
  let offset = start + 1;
  const end = Math.min(text.length, offset + 256);
  while (offset < end && /\s/.test(text[offset])) offset++;
  if (offset === end) return true;
  const char = text[offset];
  return (
    "]{[\\\"'`-0123456789".includes(char) ||
    /^(?:true|false|null|True|False|None|NaN|Infinity)(?=[\s,\]]|$)/.test(
      text.slice(offset, offset + 16),
    ) ||
    text.startsWith("/*", offset) ||
    text.startsWith("//", offset)
  );
}

function beginsLogLine(text: string, offset: number): boolean {
  const prefix = text.slice(offset, offset + 128);
  return /^\s*(?:\[(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|NOTICE)\]|(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|NOTICE)\b|\d{4}-\d{2}-\d{2}[T ])/.test(
    prefix,
  );
}

function followsCode(text: string, offset: number): boolean {
  return /(?:=>|\bfunction(?:\s+[\w$]+)?\s*\([^()]*\)|\b(?:if|while|for|switch|catch)\s*\([^()]*\)|\b(?:class|interface)\s+[\w$]+|\b(?:try|else|finally))\s*$/.test(
    text.slice(Math.max(0, offset - 160), offset),
  );
}

export function extractJsonFromLog(
  raw: string,
  options: FormatOptions,
  recursiveUnescape = true,
): LogExtractionResult {
  const started = performance.now();
  const items: LogJsonCandidate[] = [];
  let truncated = false;
  const finish = (error?: string): LogExtractionResult => ({
    items,
    truncated,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    ...(error ? { error } : {}),
  });
  if (
    raw.length > MAX_FILE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_FILE_BYTES
  )
    return finish("日志超过 20 MiB，请拆分后重试。");
  if (!raw.trim()) return finish();

  const roots: Candidate[] = [];
  const stack: Candidate[] = [];
  let stored = 0;
  let line = 1;
  let lineStart = 0;
  let quote = "";
  let quoteEscape = 0;
  let quoteStart = 0;
  let quoteLine = 1;
  let quoteColumn = 1;
  let slashRun = 0;
  let comment: "" | "line" | "block" = "";
  let overflow = 0;
  let objectFrames = 0;
  let arrayFrames = 0;

  const append = (candidate: Candidate) => {
    const parent = stack[stack.length - 1];
    if (stored < MAX_STORED_CANDIDATES) {
      (parent ? parent.children : roots).push(candidate);
      stored++;
    } else if (parent) parent.limited = true;
    else truncated = true;
  };

  const endOpen = (end: number) => {
    while (stack.length) {
      const candidate = stack.pop()!;
      candidate.end = end;
      if (candidate.limited && stack.length)
        stack[stack.length - 1].limited = true;
      if (candidate.depthLimited && stack.length)
        stack[stack.length - 1].depthLimited = true;
    }
    quote = "";
    comment = "";
    overflow = 0;
    objectFrames = 0;
    arrayFrames = 0;
    slashRun = 0;
  };

  for (let offset = 0; offset < raw.length; offset++) {
    const char = raw[offset];
    if (char === "\n") {
      line++;
      lineStart = offset + 1;
      if (stack.length && beginsLogLine(raw, offset + 1)) endOpen(offset);
      if (comment === "line") comment = "";
    }
    if (comment) {
      if (comment === "block" && char === "*" && raw[offset + 1] === "/") {
        comment = "";
        offset++;
      }
      continue;
    }
    if (quote) {
      if (
        char === quote &&
        (quoteEscape ? slashRun === quoteEscape : slashRun % 2 === 0)
      ) {
        const end = offset + 1;
        if (
          quote === '"' &&
          plausibleString(raw, quoteStart, end) &&
          wrapsStructuredJson(raw.slice(quoteStart, end))
        )
          append({
            start: quoteStart,
            end,
            line: quoteLine,
            column: quoteColumn,
            close: '"',
            children: [],
            limited: false,
            depthLimited: false,
            ignored: false,
          });
        quote = "";
      }
      slashRun = char === "\\" ? slashRun + 1 : 0;
      continue;
    }
    if (stack.length && char === "/") {
      if (raw[offset + 1] === "/") {
        comment = "line";
        offset++;
        continue;
      }
      if (raw[offset + 1] === "*") {
        comment = "block";
        offset++;
        continue;
      }
    }
    if (char === '"' && !stack.length) {
      const escapedEnvelope = slashRun;
      const start = offset - escapedEnvelope;
      let end = offset + 1;
      let escaped = 0;
      for (; end < raw.length && raw[end] !== "\n"; end++) {
        const next = raw[end];
        if (
          next === '"' &&
          (escapedEnvelope ? escaped === escapedEnvelope : escaped % 2 === 0)
        ) {
          end++;
          break;
        }
        escaped = next === "\\" ? escaped + 1 : 0;
      }
      if (
        raw[end - 1] === '"' &&
        end > start + 1 &&
        plausibleString(raw, start, end) &&
        wrapsStructuredJson(raw.slice(start, end))
      )
        append({
          start,
          end,
          line,
          column: start - lineStart + 1,
          close: '"',
          children: [],
          limited: false,
          depthLimited: false,
          ignored: false,
        });
      offset = end - 1;
      slashRun = 0;
      continue;
    }
    if (stack.length && (char === '"' || char === "'" || char === "`")) {
      quote = char;
      quoteEscape = char === '"' ? slashRun : 0;
      quoteStart = offset - quoteEscape;
      quoteLine = line;
      quoteColumn = quoteStart - lineStart + 1;
      slashRun = 0;
      continue;
    }
    if (char === "{" || (char === "[" && plausibleArray(raw, offset))) {
      if (stack.length >= MAX_SCAN_DEPTH || overflow) {
        overflow++;
        stack[stack.length - 1].limited = true;
        stack[stack.length - 1].depthLimited = true;
      } else {
        const candidate: Candidate = {
          start: offset,
          end: raw.length,
          line,
          column: offset - lineStart + 1,
          close: char === "{" ? "}" : "]",
          children: [],
          limited: false,
          depthLimited: false,
          ignored: !stack.length && char === "{" && followsCode(raw, offset),
        };
        append(candidate);
        stack.push(candidate);
        if (candidate.close === "}") objectFrames++;
        else arrayFrames++;
      }
    } else if (char === "}" || char === "]") {
      if (overflow) overflow--;
      else if (char === "}" ? objectFrames > 0 : arrayFrames > 0) {
        let match = stack.length - 1;
        while (match >= 0 && stack[match].close !== char) match--;
        if (match >= 0) {
          while (stack.length > match) {
            const candidate = stack.pop()!;
            if (candidate.close === "}") objectFrames--;
            else arrayFrames--;
            candidate.end = offset + Number(candidate.close === char);
            if (candidate.limited && stack.length)
              stack[stack.length - 1].limited = true;
            if (candidate.depthLimited && stack.length)
              stack[stack.length - 1].depthLimited = true;
          }
        }
      }
    }
    slashRun = char === "\\" ? slashRun + 1 : 0;
  }
  endOpen(raw.length);

  const pending = [...roots].reverse();
  let attempts = 0;
  let work = 0;
  let output = 0;
  while (pending.length) {
    if (items.length >= MAX_LOG_RESULTS || attempts >= MAX_ATTEMPTS) {
      truncated = true;
      break;
    }
    const candidate = pending.pop()!;
    if (candidate.ignored) continue;
    if (candidate.close === "]" && raw[candidate.end] === "(") continue;
    if (candidate.depthLimited) {
      truncated = true;
      continue;
    }
    const length = candidate.end - candidate.start;
    if (work + length > MAX_WORK_CHARACTERS) {
      truncated = true;
      continue;
    }
    work += length;
    const source = raw.slice(candidate.start, candidate.end);
    let accepted = false;
    if (wrapsStructuredJson(source)) {
      attempts++;
      const result = processStructuredJson(source, options, recursiveUnescape);
      if (result.success) {
        if (output + result.output.length > MAX_OUTPUT_CHARACTERS) {
          truncated = true;
          break;
        }
        output += result.output.length;
        items.push({
          id: `log-json-${candidate.start}-${candidate.end}`,
          raw: source,
          start: candidate.start,
          end: candidate.end,
          line: candidate.line,
          column: candidate.column,
          result,
        });
        accepted = true;
      }
    }
    if (!accepted) {
      if (candidate.limited) truncated = true;
      for (let index = candidate.children.length - 1; index >= 0; index--)
        pending.push(candidate.children[index]);
    }
  }
  return finish();
}
