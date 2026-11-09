import { Change, Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { RepairStage } from "../../../shared/types";
import type { DiffTextProjection } from "./diff-text-projection";

export interface RepairDiffChange {
  id: string;
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
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

export function mapProjectedChunks(
  chunks: readonly Chunk[],
  a: DiffTextProjection,
  b: DiffTextProjection,
): readonly Chunk[] {
  if (!a.active && !b.active) return chunks;
  return chunks.map((chunk) => {
    const fromA = a.toSource(chunk.fromA);
    const fromB = b.toSource(chunk.fromB);
    return new Chunk(
      chunk.changes.map(
        (change) =>
          new Change(
            a.toSource(chunk.fromA + change.fromA) - fromA,
            a.toSource(chunk.fromA + change.toA) - fromA,
            b.toSource(chunk.fromB + change.fromB) - fromB,
            b.toSource(chunk.fromB + change.toB) - fromB,
          ),
      ),
      fromA,
      chunk.fromA === chunk.toA ? fromA : a.toSource(chunk.endA) + 1,
      fromB,
      chunk.fromB === chunk.toB ? fromB : b.toSource(chunk.endB) + 1,
      chunk.precise,
    );
  });
}

export function repairChunkRange(chunk: Chunk) {
  const first = chunk.changes[0];
  const last = chunk.changes[chunk.changes.length - 1];
  return first
    ? {
        fromA: chunk.fromA + first.fromA,
        toA: chunk.fromA + last.toA,
        fromB: chunk.fromB + first.fromB,
        toB: chunk.fromB + last.toB,
      }
    : {
        fromA: chunk.fromA,
        toA: chunk.endA,
        fromB: chunk.fromB,
        toB: chunk.endB,
      };
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

export function alignedDiffRows(
  chunks: readonly Chunk[],
  before: Text,
  after: Text,
) {
  let rows = before.lines;
  for (const chunk of chunks)
    rows += Math.max(
      0,
      changedLineCount(after, chunk.fromB, chunk.toB) -
        changedLineCount(before, chunk.fromA, chunk.toA),
    );
  return rows;
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
