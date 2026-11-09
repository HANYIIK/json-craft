import { Text } from "@codemirror/state";
import { Change } from "@codemirror/merge";

const LONG_LINE = 8_192;
const SEGMENT = 1_024;

export interface DiffProjectionLayout {
  width: number;
  measure(text: string): number;
  maxDOMHeight?: number;
  preferWordBoundaries?: boolean;
}

function boundary(
  points: readonly number[],
  position: number,
  inclusive: boolean,
) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle] < position || (inclusive && points[middle] === position))
      low = middle + 1;
    else high = middle;
  }
  return low;
}

function bounded(position: number, length: number) {
  return Math.max(0, Math.min(length, Math.trunc(position) || 0));
}

function candidates(source: string, edges: ReadonlySet<number>) {
  const points: number[] = [];
  for (let from = 0; from < source.length;) {
    const next = source.indexOf("\n", from);
    const to = next < 0 ? source.length : next;
    if (to - from > SEGMENT) {
      let previousPoint = from;
      for (let position = from + SEGMENT; position < to; position += SEGMENT) {
        let point = Math.max(position, previousPoint);
        while (point < to) {
          const previous = source.charCodeAt(point - 1);
          const current = source.charCodeAt(point);
          if (
            !edges.has(point) &&
            !(
              previous >= 0xd800 &&
              previous <= 0xdbff &&
              current >= 0xdc00 &&
              current <= 0xdfff
            )
          )
            break;
          point++;
        }
        if (point < to && point > previousPoint) points.push(point);
        previousPoint = point;
      }
    }
    if (next < 0) break;
    from = next + 1;
  }
  return points;
}

function hasLongLine(source: string) {
  for (let from = 0; from < source.length;) {
    const next = source.indexOf("\n", from);
    if ((next < 0 ? source.length : next) - from >= LONG_LINE) return true;
    if (next < 0) break;
    from = next + 1;
  }
  return false;
}

function measuredWidths(layout: DiffProjectionLayout) {
  const ascii = new Float64Array(128).fill(-1);
  const unicode = new Map<number, number>();
  const fallback = layout.measure("M") || 1;
  return (code: number) => {
    const cached = code < 128 ? ascii[code] : unicode.get(code);
    if (cached !== undefined && cached >= 0) return cached;
    const value = layout.measure(String.fromCodePoint(code));
    const width = Number.isFinite(value) && value >= 0 ? value : fallback;
    if (code < 128) ascii[code] = width;
    else unicode.set(code, width);
    return width;
  };
}

function asciiWord(character: number) {
  return (
    (character >= 65 && character <= 90) ||
    (character >= 97 && character <= 122) ||
    (character >= 48 && character <= 57) ||
    character === 95 ||
    character === 36
  );
}

function visualCandidates(
  source: string,
  edges: ReadonlySet<number>,
  width: number,
  measure: (code: number) => number,
  preferWordBoundaries = false,
) {
  const points: number[] = [];
  for (let from = 0; from < source.length;) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? source.length : newline;
    let rowStart = from;
    let rowWidth = 0;
    let safe = from;
    let widthAtSafe = 0;
    let wordBoundary = from;
    let widthAtWordBoundary = 0;
    for (let position = from; position < to;) {
      const code = source.codePointAt(position)!;
      const size = code > 0xffff ? 2 : 1;
      const characterWidth = measure(code);
      const insideWord =
        preferWordBoundaries &&
        asciiWord(code) &&
        asciiWord(source.charCodeAt(position - 1));
      if (
        preferWordBoundaries &&
        !edges.has(position) &&
        asciiWord(code) !== asciiWord(source.charCodeAt(position - 1))
      ) {
        wordBoundary = position;
        widthAtWordBoundary = rowWidth;
      }
      if (
        position > rowStart &&
        (rowWidth + characterWidth > width ||
          position + size - rowStart > SEGMENT)
      ) {
        let point = !edges.has(position) ? position : safe;
        let consumed = point === position ? rowWidth : widthAtSafe;
        if (
          insideWord &&
          wordBoundary > rowStart &&
          wordBoundary <= point &&
          position - wordBoundary <= 96
        ) {
          point = wordBoundary;
          consumed = widthAtWordBoundary;
        }
        if (point > rowStart) {
          points.push(point);
          rowWidth -= consumed;
          widthAtSafe -= consumed;
          widthAtWordBoundary -= consumed;
          rowStart = point;
        }
      }
      rowWidth += characterWidth;
      position += size;
      if (position < to && !edges.has(position)) {
        safe = position;
        widthAtSafe = rowWidth;
        if (
          rowWidth > width ||
          (!preferWordBoundaries && position - rowStart >= SEGMENT)
        ) {
          points.push(position);
          rowStart = position;
          rowWidth = 0;
          widthAtSafe = 0;
        }
      }
    }
    if (newline < 0) break;
    from = newline + 1;
  }
  return points;
}

function displayDocument(source: string, points: readonly number[]) {
  const lines: string[] = [];
  let from = 0;
  let index = 0;
  for (;;) {
    const next = source.indexOf("\n", from);
    const to = next < 0 ? source.length : next;
    while (index < points.length && points[index] <= to) {
      const point = points[index++];
      lines.push(source.slice(from, point));
      from = point;
    }
    lines.push(source.slice(from, to));
    if (next < 0) break;
    from = next + 1;
  }
  return Text.of(lines);
}

export class DiffTextProjection {
  readonly source: string;
  readonly sourceDoc: Text;
  readonly doc: Text;
  readonly breaks: readonly number[];
  readonly active: boolean;

  constructor(source: string, breaks: readonly number[] = []) {
    this.source = source;
    this.sourceDoc = Text.of(source.split("\n"));
    this.breaks = breaks.slice();
    this.active = this.breaks.length > 0;
    this.doc = this.active
      ? displayDocument(source, this.breaks)
      : this.sourceDoc;
  }

  toDisplay(position: number, assoc: -1 | 1 = 1) {
    const at = bounded(position, this.source.length);
    return at + boundary(this.breaks, at, assoc > 0);
  }

  toSource(position: number) {
    const at = bounded(position, this.doc.length);
    let low = 0;
    let high = this.breaks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.breaks[middle] + middle < at) low = middle + 1;
      else high = middle;
    }
    return at - low;
  }

  lineNumber(displayLineNumber: number) {
    if (
      !Number.isInteger(displayLineNumber) ||
      displayLineNumber < 1 ||
      displayLineNumber > this.doc.lines
    )
      return String(this.sourceDoc.lines);
    const from = this.toSource(this.doc.line(displayLineNumber).from);
    const line = this.sourceDoc.lineAt(from);
    return from === line.from ? String(line.number) : "";
  }
}

export function projectDiffTexts(
  before: string,
  after: string,
  changes: readonly Change[],
  enabled = true,
  layout?: DiffProjectionLayout,
) {
  if (!enabled) {
    const a = new DiffTextProjection(before);
    return {
      a,
      b: before === after ? a : new DiffTextProjection(after),
      changes,
    };
  }
  const edgesA = new Set<number>();
  const edgesB = new Set<number>();
  for (const change of changes) {
    edgesA.add(change.fromA).add(change.toA);
    edgesB.add(change.fromB).add(change.toB);
  }
  const longLine = hasLongLine(before) || hasLongLine(after);
  const visual =
    layout && Number.isFinite(layout.width) && layout.width > 0 && longLine
      ? {
          width: layout.width,
          measure: measuredWidths(layout),
          preferWordBoundaries: layout.preferWordBoundaries,
        }
      : undefined;
  const originalA = visual
    ? visualCandidates(
        before,
        edgesA,
        visual.width,
        visual.measure,
        visual.preferWordBoundaries,
      )
    : longLine
      ? candidates(before, edgesA)
      : [];
  const originalB =
    before === after && !changes.length
      ? originalA
      : visual
        ? visualCandidates(
            after,
            edgesB,
            visual.width,
            visual.measure,
            visual.preferWordBoundaries,
          )
        : longLine
          ? candidates(after, edgesB)
          : [];
  if (!originalA.length && !originalB.length) {
    const a = new DiffTextProjection(before);
    return {
      a,
      b: before === after ? a : new DiffTextProjection(after),
      changes,
    };
  }
  const pointsA = new Set(originalA);
  const pointsB = new Set(originalB);
  let cursorA = 0;
  let cursorB = 0;
  let indexA = 0;
  let indexB = 0;
  const mirror = (toA: number, toB: number) => {
    while (indexA < originalA.length && originalA[indexA] <= cursorA) indexA++;
    const startA = indexA;
    while (indexA < originalA.length && originalA[indexA] < toA) indexA++;
    while (indexB < originalB.length && originalB[indexB] <= cursorB) indexB++;
    const startB = indexB;
    while (indexB < originalB.length && originalB[indexB] < toB) indexB++;
    const fromA = indexA - startA >= indexB - startB;
    const canonical = fromA ? originalA : originalB;
    const other = fromA ? originalB : originalA;
    const canonicalStart = fromA ? startA : startB;
    const canonicalEnd = fromA ? indexA : indexB;
    const otherStart = fromA ? startB : startA;
    const otherEnd = fromA ? indexB : indexA;
    const canonicalPoints = fromA ? pointsA : pointsB;
    const otherPoints = fromA ? pointsB : pointsA;
    const offset = fromA ? cursorB - cursorA : cursorA - cursorB;
    for (let index = otherStart; index < otherEnd; index++)
      otherPoints.delete(other[index]);
    for (let index = canonicalStart; index < canonicalEnd; index++)
      otherPoints.add(canonical[index] + offset);
    if (otherStart < otherEnd) {
      const add = (point: number) => {
        otherPoints.add(point);
        canonicalPoints.add(point - offset);
      };
      if (other[otherStart] < canonical[canonicalStart] + offset)
        add(other[otherStart]);
      add(other[otherEnd - 1]);
    }
  };
  for (const change of changes) {
    mirror(change.fromA, change.fromB);
    cursorA = change.toA;
    cursorB = change.toB;
  }
  mirror(before.length, after.length);
  const breaksA = [...pointsA]
    .filter((point) => point > 0 && point < before.length && !edgesA.has(point))
    .sort((left, right) => left - right);
  const breaksB = [...pointsB]
    .filter((point) => point > 0 && point < after.length && !edgesB.has(point))
    .sort((left, right) => left - right);
  const a = new DiffTextProjection(before, breaksA);
  const b =
    before === after &&
    breaksA.length === breaksB.length &&
    breaksA.every((point, index) => point === breaksB[index])
      ? a
      : new DiffTextProjection(after, breaksB);
  return {
    a,
    b,
    changes: changes.map(
      (change) =>
        new Change(
          a.toDisplay(change.fromA),
          a.toDisplay(change.toA),
          b.toDisplay(change.fromB),
          b.toDisplay(change.toB),
        ),
    ),
  };
}
