import type { MergeView } from "@codemirror/merge";
import type { EditorView } from "@codemirror/view";

const geometryKey = Symbol.for("json-craft.merge-geometry");

interface Match {
  fromB: number;
  length: number;
}

interface RenderedLine {
  to: number;
  rect: DOMRect;
}

function measure(view: EditorView) {
  const content = view.contentDOM.getBoundingClientRect();
  const padding = view.documentPadding;
  const lines = new Map<number, RenderedLine>();
  const spacers = new Map<number, DOMRect[]>();
  for (const element of view.contentDOM.querySelectorAll(".cm-line")) {
    const from = view.posAtDOM(element);
    const to = view.posAtDOM(element, element.childNodes.length);
    const logical = view.state.doc.lineAt(from);
    const rect = element.getBoundingClientRect();
    if (
      logical.from === from &&
      logical.to === to &&
      rect.height > 0 &&
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.bottom)
    )
      lines.set(from, { to, rect });
  }
  for (const element of view.contentDOM.querySelectorAll(".cm-mergeSpacer")) {
    const position = view.posAtDOM(element);
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.height) || rect.height < 0) continue;
    const previous = spacers.get(position);
    if (previous) previous.push(rect);
    else spacers.set(position, [rect]);
  }
  return { content, padding, lines, spacers };
}

export function attachDiffGeometry(
  merge: MergeView,
  longLines: ReadonlyMap<number, Match>,
) {
  const shared = new Map<string, boolean>();
  const provide = () => {
    try {
      const a = measure(merge.a);
      const b = measure(merge.b);
      return {
        line(posA: number, posB: number) {
          try {
            const lineA = merge.a.state.doc.lineAt(posA);
            const lineB = merge.b.state.doc.lineAt(posB);
            if (
              lineA.length !== lineB.length ||
              posA - lineA.from !== posB - lineB.from
            )
              return;
            const renderedA = a.lines.get(lineA.from);
            const renderedB = b.lines.get(lineB.from);
            if (!renderedA || !renderedB) return;
            const key = `${lineA.from}:${lineB.from}`;
            let exact = shared.get(key);
            if (exact === undefined) {
              const long = longLines.get(lineA.from);
              exact =
                (long?.fromB === lineB.from && long.length === lineA.length) ||
                (lineA.length <= 10_000 && lineA.text === lineB.text);
              if (shared.size >= 256)
                shared.delete(shared.keys().next().value!);
              shared.set(key, exact);
            }
            if (!exact) return;
            const topA =
              renderedA.rect.top -
              a.content.top -
              a.padding.top -
              (a.spacers.get(posA) ?? []).reduce(
                (height, rect) => height + rect.height,
                0,
              );
            const topB =
              renderedB.rect.top -
              b.content.top -
              b.padding.top -
              (b.spacers.get(posB) ?? []).reduce(
                (height, rect) => height + rect.height,
                0,
              );
            if (Number.isFinite(topA) && Number.isFinite(topB))
              return { a: topA, b: topB };
          } catch {
            return;
          }
        },
        end() {
          try {
            const endA = merge.a.state.doc.length;
            const endB = merge.b.state.doc.length;
            const lineA = a.lines.get(merge.a.state.doc.lineAt(endA).from);
            const lineB = b.lines.get(merge.b.state.doc.lineAt(endB).from);
            if (lineA?.to !== endA || lineB?.to !== endB) return;
            const heightA =
              lineA.rect.bottom -
              a.content.top +
              a.padding.bottom +
              (a.spacers.get(endA) ?? [])
                .filter((rect) => rect.top >= lineA.rect.bottom - 0.5)
                .reduce((height, rect) => height + rect.height, 0);
            const heightB =
              lineB.rect.bottom -
              b.content.top +
              b.padding.bottom +
              (b.spacers.get(endB) ?? [])
                .filter((rect) => rect.top >= lineB.rect.bottom - 0.5)
                .reduce((height, rect) => height + rect.height, 0);
            if (
              Number.isFinite(heightA) &&
              Number.isFinite(heightB) &&
              heightA > 0 &&
              heightB > 0
            )
              return { a: heightA, b: heightB };
          } catch {
            return;
          }
        },
      };
    } catch {
      return;
    }
  };
  Reflect.set(merge.a.dom, geometryKey, provide);
  return () => {
    if (Reflect.get(merge.a.dom, geometryKey) === provide)
      Reflect.deleteProperty(merge.a.dom, geometryKey);
    shared.clear();
  };
}
