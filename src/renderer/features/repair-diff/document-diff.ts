import { Change } from "@codemirror/merge";
import { diffChars, diffLines, type ChangeObject } from "diff";

const TOTAL_BUDGET = 200;
const LINE_BUDGET = 150;
const DETAIL_BUDGET = 12;
const MAX_LINE_EDITS = 4_096;
const MAX_DETAIL_EDITS = 2_048;
const MAX_DETAIL_LENGTH = 32_768;

export interface DocumentDiff {
  changes: readonly Change[];
  precise: boolean;
}

export interface DocumentDiffOptions {
  timeout?: number;
}

function insidePair(text: string, position: number) {
  const previous = text.charCodeAt(position - 1);
  const current = text.charCodeAt(position);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function commonLength(a: string, b: string, range: Change, suffix = false) {
  let low = 0;
  let high = Math.min(range.toA - range.fromA, range.toB - range.fromB);
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const same = suffix
      ? a.slice(range.toA - length, range.toA) ===
        b.slice(range.toB - length, range.toB)
      : a.slice(range.fromA, range.fromA + length) ===
        b.slice(range.fromB, range.fromB + length);
    if (same) low = length;
    else high = length - 1;
  }
  const positionA = suffix ? range.toA - low : range.fromA + low;
  const positionB = suffix ? range.toB - low : range.fromB + low;
  return insidePair(a, positionA) || insidePair(b, positionB) ? low - 1 : low;
}

function trimChange(a: string, b: string, range: Change) {
  const prefix = commonLength(a, b, range);
  const trimmed = new Change(
    range.fromA + prefix,
    range.toA,
    range.fromB + prefix,
    range.toB,
  );
  const suffix = commonLength(a, b, trimmed, true);
  return new Change(
    trimmed.fromA,
    trimmed.toA - suffix,
    trimmed.fromB,
    trimmed.toB - suffix,
  );
}

function changedRanges(
  parts: readonly ChangeObject<string>[],
  fromA: number,
  fromB: number,
) {
  const changes: Change[] = [];
  let startA = fromA;
  let startB = fromB;
  let changed = false;
  const flush = () => {
    if (changed) changes.push(new Change(startA, fromA, startB, fromB));
    changed = false;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      flush();
      fromA += part.value.length;
      fromB += part.value.length;
    } else {
      if (!changed) {
        startA = fromA;
        startB = fromB;
        changed = true;
      }
      if (part.removed) fromA += part.value.length;
      if (part.added) fromB += part.value.length;
    }
  }
  flush();
  return changes;
}

function oneSided(range: Change) {
  return range.fromA === range.toA || range.fromB === range.toB;
}

function anchoredRanges(before: string, after: string, range: Change) {
  const tokenize = (source: string, from: number, to: number) => {
    const lines = source.slice(from, to).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const positions = [from];
    const unique = new Map<string, number>();
    for (const [index, line] of lines.entries()) {
      positions.push(positions[index] + line.length);
      unique.set(line, unique.has(line) ? -1 : index);
    }
    return { positions, unique };
  };
  const a = tokenize(before, range.fromA, range.toA);
  const b = tokenize(after, range.fromB, range.toB);
  const pairs: [number, number][] = [];
  for (const [line, indexA] of a.unique) {
    const indexB = b.unique.get(line);
    if (indexA >= 0 && indexB !== undefined && indexB >= 0)
      pairs.push([indexA, indexB]);
  }
  const previous = new Int32Array(pairs.length).fill(-1);
  const tails: number[] = [];
  for (let index = 0; index < pairs.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]][1] < pairs[index][1]) low = middle + 1;
      else high = middle;
    }
    if (low) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const anchors: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index])
    anchors.push(pairs[index]);
  const ranges: Change[] = [];
  let fromA = range.fromA;
  let fromB = range.fromB;
  for (const [indexA, indexB] of anchors.reverse()) {
    const toA = a.positions[indexA];
    const toB = b.positions[indexB];
    if (toA > fromA || toB > fromB)
      ranges.push(new Change(fromA, toA, fromB, toB));
    fromA = a.positions[indexA + 1];
    fromB = b.positions[indexB + 1];
  }
  if (fromA < range.toA || fromB < range.toB)
    ranges.push(new Change(fromA, range.toA, fromB, range.toB));
  return ranges;
}

export function computeDocumentDiff(
  before: string,
  after: string,
  options: DocumentDiffOptions = {},
): DocumentDiff {
  if (before === after) return { changes: [], precise: true };
  const deadline = Date.now() + (options.timeout ?? TOTAL_BUDGET);
  const range = trimChange(
    before,
    after,
    new Change(0, before.length, 0, after.length),
  );
  if (oneSided(range)) return { changes: [range], precise: true };
  const changes: Change[] = [];
  let precise = true;
  const refine = (local: Change) => {
    if (oneSided(local)) {
      changes.push(local);
      return;
    }
    const budget = deadline - Date.now();
    const detail =
      budget > 0 &&
      local.toA - local.fromA + local.toB - local.fromB <= MAX_DETAIL_LENGTH
        ? diffChars(
            before.slice(local.fromA, local.toA),
            after.slice(local.fromB, local.toB),
            {
              timeout: Math.min(DETAIL_BUDGET, budget),
              maxEditLength: MAX_DETAIL_EDITS,
            },
          )
        : undefined;
    if (detail)
      changes.push(...changedRanges(detail, local.fromA, local.fromB));
    else {
      changes.push(local);
      precise = false;
    }
  };
  for (const anchored of anchoredRanges(before, after, range)) {
    const local = trimChange(before, after, anchored);
    if (oneSided(local)) {
      if (local.fromA !== local.toA || local.fromB !== local.toB)
        changes.push(local);
      continue;
    }
    const remaining = deadline - Date.now();
    const lines =
      remaining > 0
        ? diffLines(
            before.slice(local.fromA, local.toA),
            after.slice(local.fromB, local.toB),
            {
              timeout: Math.min(LINE_BUDGET, remaining),
              maxEditLength: MAX_LINE_EDITS,
            },
          )
        : undefined;
    if (lines)
      for (const lineRange of changedRanges(lines, local.fromA, local.fromB))
        refine(trimChange(before, after, lineRange));
    else {
      changes.push(local);
      precise = false;
    }
  }
  return { changes, precise };
}
