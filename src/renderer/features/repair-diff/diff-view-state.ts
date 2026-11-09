import { EditorSelection } from "@codemirror/state";
import {
  getSearchQuery,
  searchPanelOpen,
  setSearchQuery,
  type SearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { jsonSearchCommands, searchAdapter } from "../editor/search-panel";
import type { DiffTextProjection } from "./diff-text-projection";

export interface DiffViewState {
  selection: EditorSelection;
  position: number;
  query: SearchQuery;
  searchOpen: boolean;
  visible: boolean;
  focus: "editor" | "search" | undefined;
}

export function captureDiffView(
  view: EditorView,
  projection: DiffTextProjection,
  panel: Element | null,
  viewport: DOMRect,
): DiffViewState {
  const content = view.contentDOM.getBoundingClientRect();
  const pane = view.dom.getBoundingClientRect();
  const position =
    view.posAtCoords(
      {
        x:
          (Math.max(content.left, pane.left, viewport.left) +
            Math.min(content.right, pane.right, viewport.right)) /
          2,
        y: (viewport.top + viewport.bottom) / 2,
      },
      false,
    ) ?? view.viewport.from;
  const query = getSearchQuery(view.state);
  return {
    selection: EditorSelection.create(
      view.state.selection.ranges.map((range) =>
        EditorSelection.range(
          projection.toSource(range.anchor),
          projection.toSource(range.head),
        ),
      ),
      view.state.selection.mainIndex,
    ),
    position: projection.toSource(position),
    query: view.state.facet(searchAdapter)?.query(query) ?? query,
    searchOpen: searchPanelOpen(view.state),
    visible: Array.from(view.contentDOM.querySelectorAll(".cm-line")).some(
      (line) => {
        const rect = line.getBoundingClientRect();
        return (
          Boolean(line.textContent) &&
          rect.top < viewport.bottom &&
          rect.bottom > viewport.top
        );
      },
    ),
    focus: panel?.contains(view.dom.ownerDocument.activeElement)
      ? "search"
      : view.hasFocus
        ? "editor"
        : undefined,
  };
}

export function restoreDiffView(
  view: EditorView,
  projection: DiffTextProjection,
  saved: DiffViewState,
) {
  view.dispatch({
    selection: EditorSelection.create(
      saved.selection.ranges.map((range) => {
        const from = projection.toDisplay(range.from);
        const to = range.empty ? from : projection.toDisplay(range.to, -1);
        return range.anchor <= range.head
          ? EditorSelection.range(from, to)
          : EditorSelection.range(to, from);
      }),
      saved.selection.mainIndex,
    ),
  });
  if (saved.searchOpen) jsonSearchCommands.open(view);
  view.dispatch({ effects: setSearchQuery.of(saved.query) });
  if (saved.focus === "editor") view.focus();
}
