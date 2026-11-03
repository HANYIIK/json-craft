import { processJson, wrapsStructuredJson } from "./json";
import {
  MAX_FILE_BYTES,
  type FormatOptions,
  type ProcessingResult,
  type RepairStage,
} from "../../shared/types";

const MAX_OUTPUT_CHARACTERS = MAX_FILE_BYTES * 4;
const MAX_WORK_CHARACTERS = MAX_FILE_BYTES * 16;
const MAX_REPAIR_TEXT_CHARACTERS = MAX_FILE_BYTES * 2;
const MAX_DECODE_DEPTH = 8;
const MAX_CONTAINER_DEPTH = 512;
const MAX_CANDIDATES = 100_000;
const MAX_REPAIR_ATTEMPTS = 128;
const MAX_WARNINGS = 64;
const MAX_PATH_CHARACTERS = 4_096;

interface Path {
  parent?: Path;
  segment: string | number;
}

interface Frame {
  kind: "root" | "array" | "object";
  path?: Path;
  index: number;
  key: string;
  expectingKey: boolean;
}

function pathLabel(path: Path | undefined): string {
  const segments: (string | number)[] = [];
  for (let current = path; current; current = current.parent)
    segments.push(current.segment);
  let label = "$";
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const bounded =
      typeof segment === "string" && segment.length > 1_024
        ? segment.slice(0, 768) + "…" + segment.slice(-128)
        : segment;
    label +=
      typeof bounded === "number"
        ? `[${bounded}]`
        : /^[A-Za-z_$][\w$]*$/.test(bounded)
          ? `.${bounded}`
          : `[${JSON.stringify(bounded)}]`;
    if (label.length > MAX_PATH_CHARACTERS)
      label = label.slice(0, 1_024) + "…" + label.slice(-2_048);
  }
  return label;
}

function stringEnd(text: string, offset: number): number {
  for (let index = offset + 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 92) index++;
    else if (code === 34) return index + 1;
  }
  return text.length;
}

function mayContainStructuredJson(
  text: string,
  start: number,
  end: number,
): boolean {
  for (let offset = start + 1; offset < end - 1; offset++) {
    const code = text.charCodeAt(offset);
    if (code === 32) continue;
    if (code === 92 || code === 123 || code === 91) return true;
    if (code > 127 && text[offset].trim().length === 0) continue;
    return false;
  }
  return false;
}

function containerEnd(text: string, offset: number): number {
  let depth = 0;
  for (let index = offset; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 34) index = stringEnd(text, index) - 1;
    else if (code === 123 || code === 91) depth++;
    else if ((code === 125 || code === 93) && --depth === 0) return index + 1;
  }
  return text.length;
}

export function processStructuredJson(
  raw: string,
  options: FormatOptions,
  recursiveUnescape = true,
): ProcessingResult {
  const prepared = processJson(raw, options);
  if (
    !prepared.success ||
    !options.autoUnescape ||
    !recursiveUnescape ||
    !/^[{\[]/.test(prepared.output.trimStart())
  )
    return prepared;

  const metadata = {
    decodedItems: 0,
    failedItems: 0,
    warnings: [] as { path: string; message: string }[],
    warningsTruncated: false,
  };
  const stages: RepairStage[] = [...prepared.stages];
  const indent = options.indent === "tab" ? "\t" : " ".repeat(+options.indent);
  let work = 0;
  let candidates = 0;
  let repairs = 0;
  let repairMilliseconds = 0;
  let repairText = prepared.stages.reduce(
    (total, stage) => total + stage.before.length + stage.after.length,
    0,
  );
  let diffText = repairText;
  let diffChanges = prepared.stages.reduce(
    (total, stage) => total + stage.changes.length,
    0,
  );
  let stageSequence = 0;

  const warn = (path: Path | undefined, message: string) => {
    metadata.failedItems++;
    if (metadata.warnings.length < MAX_WARNINGS)
      metadata.warnings.push({ path: pathLabel(path), message });
    else metadata.warningsTruncated = true;
  };

  const appendStages = (source: RepairStage[], path: Path, depth: number) => {
    const label = pathLabel(path);
    for (const stage of source) {
      const id = `array-repair-${++stageSequence}`;
      const characters = stage.before.length + stage.after.length;
      const truncated =
        stage.diffTruncated ||
        diffText + characters > 500_000 ||
        diffChanges + stage.changes.length > 1_000;
      const layer = Math.max(1, depth + stage.layer);
      const changes = truncated
        ? []
        : stage.changes.map((change, index) => ({
            ...change,
            id: `${id}-change-${index + 1}`,
            stageId: id,
            path: label,
            layer,
          }));
      stages.push({
        ...stage,
        id,
        path: label,
        layer,
        changes,
        diffTruncated: truncated,
      });
      repairText += characters;
      diffText += characters;
      diffChanges += changes.length;
    }
  };

  const transform = (
    text: string,
    basePath: Path | undefined,
    decodeDepth: number,
  ): string => {
    if (work + text.length > MAX_WORK_CHARACTERS) {
      warn(basePath, "JSON 递归处理预算已用尽，已保留原内容。");
      return text;
    }
    work += text.length;
    const frames: Frame[] = [
      { kind: "root", path: basePath, index: 0, key: "", expectingKey: false },
    ];
    const chunks: string[] = [];
    let copied = 0;
    let outputLength = text.length;
    const valuePath = (frame: Frame): Path | undefined => {
      if (frame.kind === "root") return frame.path;
      return {
        parent: frame.path,
        segment: frame.kind === "array" ? frame.index++ : frame.key,
      };
    };

    for (let offset = 0; offset < text.length;) {
      const code = text.charCodeAt(offset);
      const frame = frames[frames.length - 1];
      if (
        code === 32 ||
        code === 9 ||
        code === 10 ||
        code === 13 ||
        code === 58
      ) {
        offset++;
      } else if (code === 44) {
        frame.expectingKey = frame.kind === "object";
        offset++;
      } else if (code === 125 || code === 93) {
        frames.pop();
        offset++;
      } else if (code === 123 || code === 91) {
        const path = valuePath(frame);
        if (frames.length > MAX_CONTAINER_DEPTH) {
          warn(path, "JSON 嵌套过深，已保留原内容。");
          offset = containerEnd(text, offset);
          continue;
        }
        frames.push({
          kind: code === 123 ? "object" : "array",
          path,
          index: 0,
          key: "",
          expectingKey: code === 123,
        });
        offset++;
      } else if (code === 34) {
        const end = stringEnd(text, offset);
        if (frame.kind === "object" && frame.expectingKey) {
          frame.key = JSON.parse(text.slice(offset, end)) as string;
          frame.expectingKey = false;
          offset = end;
          continue;
        }
        const path = valuePath(frame);
        if (!mayContainStructuredJson(text, offset, end)) {
          offset = end;
          continue;
        }
        const literal = text.slice(offset, end);
        const value = JSON.parse(literal) as string;
        if (!wrapsStructuredJson(value)) {
          offset = end;
          continue;
        }
        candidates++;
        if (
          candidates > MAX_CANDIDATES ||
          work + literal.length * 9 > MAX_WORK_CHARACTERS
        ) {
          warn(path, "JSON 字符串处理预算已用尽，已保留原字符串。");
          offset = end;
          continue;
        }
        if (decodeDepth >= MAX_DECODE_DEPTH) {
          warn(path, "JSON 字符串解码层级超过 8 层，已保留原字符串。");
          offset = end;
          continue;
        }
        work += literal.length;
        let child = processJson(literal, { ...options, repair: false });
        if (
          !child.success &&
          options.repair &&
          child.error?.message.startsWith("JSON 语法无效，已关闭自动修复：")
        ) {
          if (repairs >= MAX_REPAIR_ATTEMPTS || repairMilliseconds >= 250) {
            warn(path, "JSON 字符串修复预算已用尽，已保留原字符串。");
            offset = end;
            continue;
          }
          const repairStarted = performance.now();
          child = processJson(literal, options);
          repairMilliseconds += performance.now() - repairStarted;
          repairs += Math.max(1, child.stages.length);
        }
        work += literal.length * child.decodedLayers;
        if (!child.success) {
          warn(
            path,
            child.error?.message ??
              "JSON 字符串不是可解析的对象或数组，已保留原字符串。",
          );
          offset = end;
          continue;
        }
        if (!/^[{\[]/.test(child.output.trimStart())) {
          warn(path, "JSON 字符串不是可解析的对象或数组，已保留原字符串。");
          offset = end;
          continue;
        }
        if (decodeDepth + child.decodedLayers > MAX_DECODE_DEPTH) {
          warn(path, "JSON 字符串解码层级超过 8 层，已保留原字符串。");
          offset = end;
          continue;
        }
        const childRepairText = child.stages.reduce(
          (total, stage) => total + stage.before.length + stage.after.length,
          0,
        );
        if (
          childRepairText > 0 &&
          repairText + childRepairText > MAX_REPAIR_TEXT_CHARACTERS
        ) {
          warn(path, "JSON 字符串修复差异过大，已保留原字符串。");
          offset = end;
          continue;
        }
        const snapshot = {
          decodedItems: metadata.decodedItems,
          failedItems: metadata.failedItems,
          warnings: metadata.warnings.length,
          warningsTruncated: metadata.warningsTruncated,
          stages: stages.length,
          repairText,
          diffText,
          diffChanges,
        };
        appendStages(child.stages, path!, decodeDepth);
        const transformed = transform(
          child.output,
          path,
          decodeDepth + child.decodedLayers,
        );
        let newlines = 0;
        for (let index = 0; index < transformed.length; index++)
          if (transformed.charCodeAt(index) === 10) newlines++;
        const paddingLength = indent.length * (frames.length - 1);
        const replacementLength = transformed.length + newlines * paddingLength;
        const nextLength = outputLength - literal.length + replacementLength;
        if (nextLength > MAX_OUTPUT_CHARACTERS) {
          metadata.decodedItems = snapshot.decodedItems;
          metadata.failedItems = snapshot.failedItems;
          metadata.warnings.length = snapshot.warnings;
          metadata.warningsTruncated = snapshot.warningsTruncated;
          stages.length = snapshot.stages;
          repairText = snapshot.repairText;
          diffText = snapshot.diffText;
          diffChanges = snapshot.diffChanges;
          warn(path, "JSON 字符串格式化后超出输出大小限制，已保留原字符串。");
          offset = end;
          continue;
        }
        const padding = indent.repeat(frames.length - 1);
        const replacement = padding
          ? transformed.replaceAll("\n", "\n" + padding)
          : transformed;
        chunks.push(text.slice(copied, offset), replacement);
        copied = end;
        outputLength = nextLength;
        metadata.decodedItems++;
        offset = end;
      } else {
        valuePath(frame);
        do {
          offset++;
        } while (offset < text.length && !" \t\r\n,]}".includes(text[offset]));
      }
    }
    if (!chunks.length) return text;
    chunks.push(text.slice(copied));
    return chunks.join("");
  };

  const output = transform(prepared.output, undefined, prepared.decodedLayers);
  return {
    ...prepared,
    output,
    stages,
    changeCount: stages.some((stage) => stage.diffTruncated)
      ? null
      : stages.reduce((total, stage) => total + stage.changes.length, 0),
    ...(metadata.decodedItems || metadata.failedItems
      ? { arrayDecoding: metadata }
      : {}),
  };
}

export const processExtractedJson = processStructuredJson;
