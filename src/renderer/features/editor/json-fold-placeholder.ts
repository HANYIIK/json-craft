import {
  codeFolding,
  foldedRanges,
  syntaxTree,
  unfoldEffect,
} from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getFoldedArrayCount } from "./json-fold-summary";
import { translate } from "../../i18n/i18n";

function rangeAt(view: EditorView, element: HTMLElement) {
  const position = view.posAtDOM(element);
  let range: { from: number; to: number } | undefined;
  foldedRanges(view.state).between(position, position, (from, to) => {
    if (from === position) range = { from, to };
  });
  return range;
}

export function localizeFoldPlaceholder(
  element: HTMLElement,
  view: EditorView,
) {
  const count = element.dataset.arrayItems;
  const text =
    count === undefined
      ? "…"
      : translate("… {{count}} 项", { count: Number(count) });
  const title =
    count === undefined
      ? view.state.phrase("unfold")
      : translate("展开数组（{{count}} 项）", { count: Number(count) });
  const changed = element.textContent !== text;
  if (changed) element.textContent = text;
  element.title = title;
  element.setAttribute(
    "aria-label",
    count === undefined ? view.state.phrase("folded code") : title,
  );
  return changed;
}

function setCount(element: HTMLElement, count: number | undefined) {
  if (count === undefined) delete element.dataset.arrayItems;
  else element.dataset.arrayItems = String(count);
}

const labels = ViewPlugin.fromClass(
  class {
    private frame = 0;

    constructor(private view: EditorView) {
      this.schedule();
    }

    private schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        let changed = false;
        for (const element of this.view.dom.querySelectorAll<HTMLElement>(
          ".cm-foldPlaceholder",
        )) {
          const range = rangeAt(this.view, element);
          if (!range) continue;
          setCount(element, getFoldedArrayCount(this.view.state, range));
          changed = localizeFoldPlaceholder(element, this.view) || changed;
        }
        if (changed) this.view.requestMeasure();
      });
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        foldedRanges(update.state) !== foldedRanges(update.startState) ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.transactions.some((transaction) => transaction.reconfigured)
      )
        this.schedule();
    }

    destroy() {
      cancelAnimationFrame(this.frame);
    }
  },
);

export const jsonFoldPlaceholder = [
  codeFolding({
    preparePlaceholder: getFoldedArrayCount,
    placeholderDOM(view, onclick, count: number | undefined) {
      const element = document.createElement("span");
      element.className = "cm-foldPlaceholder";
      element.setAttribute("role", "button");
      element.tabIndex = 0;
      setCount(element, typeof count === "number" ? count : undefined);
      localizeFoldPlaceholder(element, view);
      const unfold = (event: Event) => {
        const range = rangeAt(view, element);
        if (range) {
          view.dispatch({ effects: unfoldEffect.of(range) });
          event.preventDefault();
        } else onclick(event);
      };
      element.onclick = unfold;
      element.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.stopPropagation();
        unfold(event);
        view.focus();
      };
      return element;
    },
  }),
  labels,
];
