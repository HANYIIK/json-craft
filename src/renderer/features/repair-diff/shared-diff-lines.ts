import type { MergeView } from "@codemirror/merge";
import type { EditorView } from "@codemirror/view";
import { attachDiffGeometry } from "./merge-diff-geometry";
import {
  intersectLineGaps,
  matchedLongJsonLines,
  pairedDiffPosition,
  type SharedLineGap,
} from "./repair-diff-model";

const providerKey = Symbol.for("json-craft.shared-line-gaps");

interface Request {
  from: number;
  to: number;
  gaps: readonly SharedLineGap[];
  width: number;
  charWidth: number;
  lineHeight: number;
  scaleX: number;
  scaleY: number;
  wrapping: boolean;
}

interface Pair {
  fromA: number;
  fromB: number;
  length: number;
  metrics: [string | undefined, string | undefined];
  charWidths: [number | undefined, number | undefined];
  lineHeights: [number | undefined, number | undefined];
  plans: [SharedLineGap[] | undefined, SharedLineGap[] | undefined];
  shared?: SharedLineGap[];
  recoveryScope?: string;
  recoveries?: number;
}

function samePlan(
  a: readonly SharedLineGap[] | undefined,
  b: readonly SharedLineGap[],
) {
  return (
    a?.length === b.length &&
    a.every((gap, index) => {
      const other = b[index];
      return (
        gap.from === other.from &&
        gap.to === other.to &&
        Math.abs(gap.size - other.size) < 0.5 &&
        Math.abs(gap.displaySize - other.displaySize) < 0.5
      );
    })
  );
}

export function synchronizeDiffLines(
  merge: MergeView,
  onRecover: (fromA: number, fromB: number) => boolean,
  canRecover: () => boolean,
) {
  let disposed = false;
  let interaction = 0;
  let selectionIntent = false;
  let recoveryQueued = false;
  const interrupt = (event: Event) => {
    interaction++;
    selectionIntent =
      event.type === "keydown" ||
      (event.type === "pointerdown" &&
        Boolean((event.target as Element)?.closest(".cm-content, .cm-search")));
  };
  const host = merge.dom.parentElement!;
  for (const event of ["wheel", "pointerdown", "keydown"])
    host.addEventListener(event, interrupt, true);
  const queued = new Set<EditorView>();
  const maps = [new Map<number, Pair>(), new Map<number, Pair>()];
  for (const line of matchedLongJsonLines(
    merge.a.state.doc,
    merge.b.state.doc,
    merge.chunks,
  )) {
    const pair: Pair = {
      fromA: line.fromA,
      fromB: line.fromB,
      length: line.toA - line.fromA,
      metrics: [undefined, undefined],
      charWidths: [undefined, undefined],
      lineHeights: [undefined, undefined],
      plans: [undefined, undefined],
    };
    maps[0].set(line.fromA, pair);
    maps[1].set(line.fromB, pair);
  }
  const detachGeometry = attachDiffGeometry(merge, maps[0]);
  const measure = (view: EditorView) => {
    if (queued.has(view)) return;
    queued.add(view);
    queueMicrotask(() => {
      queued.delete(view);
      if (!disposed) view.requestMeasure();
    });
  };
  const recover = (
    source: EditorView,
    peer: EditorView,
    pair: Pair,
    side: 0 | 1,
    request: Request,
  ) => {
    const peerFrom = side === 0 ? pair.fromB : pair.fromA;
    if (
      peer.visibleRanges.some(
        (range) => range.from < peerFrom + pair.length && range.to > peerFrom,
      )
    )
      return;
    const bounds = merge.dom.getBoundingClientRect();
    const threshold = request.lineHeight * 4;
    const blocked = Array.from(
      peer.dom.querySelectorAll(".cm-mergeSpacer"),
    ).some((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.height > threshold &&
        Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) >
          threshold
      );
    });
    if (!blocked) return;
    const dom = source.domAtPos(request.from).node;
    const line = (
      dom.nodeType === Node.ELEMENT_NODE ? (dom as Element) : dom.parentElement
    )?.closest(".cm-line");
    if (!line) return;
    const rect = line.getBoundingClientRect();
    const top = Math.max(rect.top, bounds.top),
      bottom = Math.min(rect.bottom, bounds.bottom);
    if (bottom - top < request.lineHeight) return;
    const sourceBounds = source.contentDOM.getBoundingClientRect();
    const position = source.posAtCoords({
      x: (sourceBounds.left + sourceBounds.right) / 2,
      y: (top + bottom) / 2,
    });
    if (position === null || position < request.from || position > request.to)
      return;
    let fromA = side === 0 ? position : pair.fromA + position - request.from;
    let fromB = side === 1 ? position : pair.fromB + position - request.from;
    if (selectionIntent) {
      const active = host.ownerDocument.activeElement;
      const selected =
        merge.a.hasFocus ||
        active?.closest('[data-testid="diff-before-panels"]')
          ? merge.a
          : merge.b.hasFocus ||
              active?.closest('[data-testid="diff-after-panels"]')
            ? merge.b
            : undefined;
      if (selected) {
        const head = selected.state.selection.main.head;
        if (selected === merge.a) {
          fromA = head;
          fromB = pairedDiffPosition(merge.chunks, head, true);
        } else {
          fromB = head;
          fromA = pairedDiffPosition(merge.chunks, head, false);
        }
      }
    }
    const aSelection = merge.a.state.selection.main,
      bSelection = merge.b.state.selection.main;
    const scope = `${interaction}:${pair.metrics[0]}:${pair.metrics[1]}:${bounds.height}:${aSelection.from}:${aSelection.to}:${bSelection.from}:${bSelection.to}`;
    if (pair.recoveryScope !== scope) {
      pair.recoveryScope = scope;
      pair.recoveries = 0;
    }
    if ((pair.recoveries ?? 0) >= 2) return;
    if (onRecover(fromA, fromB)) pair.recoveries = (pair.recoveries ?? 0) + 1;
  };
  const scheduleRecovery = (
    source: EditorView,
    peer: EditorView,
    pair: Pair,
    side: 0 | 1,
    request: Request,
  ) => {
    if (recoveryQueued || disposed || !canRecover()) return;
    const generation = interaction;
    const selectionA = merge.a.state.selection,
      selectionB = merge.b.state.selection;
    recoveryQueued = true;
    queueMicrotask(() => {
      try {
        if (
          disposed ||
          !canRecover() ||
          generation !== interaction ||
          !merge.a.state.selection.eq(selectionA) ||
          !merge.b.state.selection.eq(selectionB)
        )
          return;
        recover(source, peer, pair, side, request);
      } finally {
        recoveryQueued = false;
      }
    });
  };
  for (const side of [0, 1] as const) {
    const view = side === 0 ? merge.a : merge.b;
    const peer = side === 0 ? merge.b : merge.a;
    const provide = (request: Request) => {
      const pair = maps[side].get(request.from);
      if (!pair || disposed) return;
      if (
        !request.wrapping ||
        ![
          request.width,
          request.charWidth,
          request.lineHeight,
          request.scaleX,
          request.scaleY,
        ].every((value) => Number.isFinite(value) && value > 0)
      ) {
        pair.metrics[side] = undefined;
        pair.charWidths[side] = undefined;
        pair.lineHeights[side] = undefined;
        pair.plans[side] = undefined;
        pair.shared = undefined;
        return;
      }
      const style = getComputedStyle(view.contentDOM);
      const peerCharWidth = pair.charWidths[side === 0 ? 1 : 0];
      const charWidth =
        peerCharWidth !== undefined &&
        Math.abs(request.charWidth - peerCharWidth) < 0.1
          ? peerCharWidth
          : request.charWidth;
      pair.charWidths[side] = charWidth;
      const peerLineHeight = pair.lineHeights[side === 0 ? 1 : 0];
      const lineHeight =
        peerLineHeight !== undefined &&
        Math.abs(request.lineHeight - peerLineHeight) < 0.3
          ? peerLineHeight
          : request.lineHeight;
      pair.lineHeights[side] = lineHeight;
      const metrics =
        [request.width, charWidth, lineHeight, request.scaleX, request.scaleY]
          .map((value) => value.toFixed(3))
          .join(":") + `:${style.font}:${style.letterSpacing}`;
      if (pair.metrics[side] !== metrics) {
        pair.metrics[side] = metrics;
        pair.shared = undefined;
      }
      const nativePlan = request.gaps.map((gap) => ({
        from: gap.from - request.from,
        to: gap.to - request.from,
        size: gap.size,
        displaySize: gap.displaySize,
      }));
      const nativeChanged = !samePlan(pair.plans[side], nativePlan);
      pair.plans[side] = nativePlan;
      scheduleRecovery(view, peer, pair, side, request);
      if (
        pair.metrics[0] !== pair.metrics[1] ||
        !pair.plans[0] ||
        !pair.plans[1]
      ) {
        if (nativeChanged) measure(peer);
        return;
      }
      const shared = intersectLineGaps(pair.plans[0], pair.plans[1]);
      if (!samePlan(pair.shared, shared)) {
        pair.shared = shared;
        measure(peer);
      }
      return pair.shared!.map((gap) => ({
        ...gap,
        from: gap.from + request.from,
        to: gap.to + request.from,
      }));
    };
    Reflect.set(view.dom, providerKey, (request: Request) => {
      try {
        return provide(request);
      } catch {
        return;
      }
    });
  }
  merge.a.requestMeasure();
  merge.b.requestMeasure();
  return () => {
    disposed = true;
    detachGeometry();
    for (const event of ["wheel", "pointerdown", "keydown"])
      host.removeEventListener(event, interrupt, true);
    Reflect.deleteProperty(merge.a.dom, providerKey);
    Reflect.deleteProperty(merge.b.dom, providerKey);
    maps[0].clear();
    maps[1].clear();
    queued.clear();
  };
}
