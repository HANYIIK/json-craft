import { Change, type Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { RepairStage } from "../../../shared/types";

export interface RepairDiffChange {
  id: string;
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export function longJsonLines(doc: Text) {
  const lines: { from: number; to: number }[] = [];
  let from = 0;
  for (const line of doc.iterLines()) {
    if (line.length >= 10_000) lines.push({ from, to: from + line.length });
    from += line.length + 1;
  }
  return lines;
}

export function precedingLongLine(
  lines: ReturnType<typeof longJsonLines>,
  position: number,
) {
  let from = 0,
    to = lines.length;
  while (from < to) {
    const middle = (from + to) >>> 1;
    if (lines[middle].to <= position) from = middle + 1;
    else to = middle;
  }
  return from ? lines[from - 1] : undefined;
}

export interface SharedLineGap {
  from: number;
  to: number;
  size: number;
  displaySize: number;
}

export function intersectLineGaps(
  a: readonly SharedLineGap[],
  b: readonly SharedLineGap[],
) {
  const gaps: SharedLineGap[] = [];
  let right = 0;
  for (const left of a) {
    while (right < b.length && b[right].to <= left.from) right++;
    for (
      let index = right;
      index < b.length && b[index].from < left.to;
      index++
    ) {
      const from = Math.max(left.from, b[index].from);
      const to = Math.min(left.to, b[index].to);
      if (from < to) {
        const ratio = (to - from) / (left.to - left.from);
        gaps.push({
          from,
          to,
          size: left.size * ratio,
          displaySize: left.displaySize * ratio,
        });
      }
    }
  }
  return gaps;
}

export function matchedLongJsonLines(
  a: Text,
  b: Text,
  chunks: readonly Chunk[],
) {
  const pairs: { fromA: number; toA: number; fromB: number; toB: number }[] =
    [];
  let chunkIndex = 0,
    offset = 0;
  for (const line of longJsonLines(a)) {
    while (chunkIndex < chunks.length && chunks[chunkIndex].toA <= line.from) {
      const chunk = chunks[chunkIndex++];
      offset = chunk.toB - chunk.toA;
    }
    const next = chunks[chunkIndex];
    if (next && next.fromA < line.to && next.toA > line.from) continue;
    const position = line.from + offset;
    if (position < 0 || position > b.length) continue;
    const other = b.lineAt(position);
    if (
      other.from !== position ||
      other.length !== line.to - line.from ||
      a.sliceString(line.from, line.to) !== other.text
    )
      continue;
    pairs.push({
      fromA: line.from,
      toA: line.to,
      fromB: other.from,
      toB: other.to,
    });
  }
  return pairs;
}

export function validatedRepairChanges(
  stage: RepairStage,
): RepairDiffChange[] | null {
  if (stage.diffTruncated) return null;
  const changes: RepairDiffChange[] = [];
  const ids = new Set<string>();
  let cursorA = 0;
  let cursorB = 0;
  for (const change of stage.changes) {
    if (
      !Number.isInteger(change.start) ||
      !Number.isInteger(change.end) ||
      change.start < cursorA ||
      change.end < change.start ||
      change.end > stage.before.length ||
      change.end - change.start !== change.before.length ||
      change.before === change.after ||
      ids.has(change.id) ||
      !stage.before.startsWith(change.before, change.start)
    )
      return null;
    const gapLength = change.start - cursorA;
    const fromB = cursorB + gapLength;
    if (
      stage.before.slice(cursorA, change.start) !==
        stage.after.slice(cursorB, fromB) ||
      !stage.after.startsWith(change.after, fromB)
    )
      return null;
    const toB = fromB + change.after.length;
    changes.push({
      id: change.id,
      fromA: change.start,
      toA: change.end,
      fromB,
      toB,
    });
    ids.add(change.id);
    cursorA = change.end;
    cursorB = toB;
  }
  return stage.before.slice(cursorA) === stage.after.slice(cursorB)
    ? changes
    : null;
}

export function nativeRepairChanges(changes: readonly RepairDiffChange[]) {
  return changes.map(
    (change) => new Change(change.fromA, change.toA, change.fromB, change.toB),
  );
}

function changedLineCount(doc: Text, from: number, to: number) {
  if (from === to) return 0;
  const end =
    to > doc.length && doc.lines > 1 && doc.line(doc.lines).length === 0
      ? doc.length - 1
      : Math.min(to - 1, doc.length);
  return (
    doc.lineAt(Math.max(from, end)).number -
    doc.lineAt(Math.min(from, doc.length)).number +
    1
  );
}

export function repairDiffLineCounts(
  chunks: readonly Chunk[],
  before: Text,
  after: Text,
) {
  let addedLines = 0;
  let removedLines = 0;
  for (const chunk of chunks) {
    addedLines += changedLineCount(after, chunk.fromB, chunk.toB);
    removedLines += changedLineCount(before, chunk.fromA, chunk.toA);
  }
  return { addedLines, removedLines };
}

function distance(from: number, to: number, point: number) {
  return point < from ? from - point : point > to ? point - to : 0;
}

export function repairChangeChunk(
  chunks: readonly Chunk[],
  change: RepairDiffChange,
) {
  let nearest = -1;
  let best = Infinity;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const gap =
      distance(chunk.fromA, chunk.endA, change.fromA) +
      distance(chunk.fromB, chunk.endB, change.fromB);
    if (gap < best) {
      best = gap;
      nearest = index;
      if (!gap) break;
    }
  }
  return nearest;
}

export function repairDifferenceIndex(index: number, count: number) {
  if (!count) return -1;
  if (index === -1) return count - 1;
  return Math.max(0, Math.min(count - 1, Math.trunc(index) || 0));
}

export function pairedDiffPosition(
  chunks: readonly Chunk[],
  position: number,
  fromA: boolean,
) {
  let offset = 0;
  for (const chunk of chunks) {
    const from = fromA ? chunk.fromA : chunk.fromB;
    const to = fromA ? chunk.toA : chunk.toB;
    const otherFrom = fromA ? chunk.fromB : chunk.fromA;
    const otherTo = fromA ? chunk.toB : chunk.toA;
    if (position < from) break;
    if (position < to) return Math.min(otherTo, otherFrom + position - from);
    offset = otherTo - to;
  }
  return position + offset;
}

export function unchangedDiffRange(
  changes: readonly RepairDiffChange[],
  from: number,
  to: number,
  fromA: boolean,
) {
  if (from === to) return undefined;
  let offset = 0;
  for (const change of changes) {
    const start = fromA ? change.fromA : change.fromB;
    const end = fromA ? change.toA : change.toB;
    if (to <= start) break;
    if (from < end || (start === end && from < start && to > end))
      return undefined;
    offset = (fromA ? change.toB : change.toA) - end;
  }
  return { from: from + offset, to: to + offset };
}
