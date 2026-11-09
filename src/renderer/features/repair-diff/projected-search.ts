import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  Transaction,
  type Extension,
  type SelectionRange,
  type StateField,
  type TransactionSpec,
} from "@codemirror/state";
import {
  SearchCursor,
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  closeSearchPanel,
  gotoLine,
  openSearchPanel,
  search,
  searchPanelOpen,
  selectMatches,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  getPanel,
  showPanel,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { searchAdapter, type SearchAdapter } from "../editor/search-panel";
import type { DiffTextProjection } from "./diff-text-projection";

type Match = { from: number; to: number };

const sourceQueries = new WeakMap<SearchQuery, SearchQuery>();
const suppressDisplayMatches = () => false;
const refreshMatches = StateEffect.define<null>();
const matchMark = Decoration.mark({ class: "cm-searchMatch" });
const selectedMark = Decoration.mark({
  class: "cm-searchMatch cm-searchMatch-selected",
});

function sourceQuery(query: SearchQuery) {
  return sourceQueries.get(query) ?? query;
}

function guardedQuery(query: SearchQuery) {
  if (sourceQueries.has(query)) return query;
  const guarded = new SearchQuery({ ...query, test: suppressDisplayMatches });
  sourceQueries.set(guarded, query);
  return guarded;
}

function sameQuery(a: SearchQuery | undefined, b: SearchQuery) {
  return (
    a?.search === b.search &&
    a.caseSensitive === b.caseSensitive &&
    a.literal === b.literal &&
    a.regexp === b.regexp &&
    a.wholeWord === b.wholeWord &&
    a.test === b.test
  );
}

function displayRange(projection: DiffTextProjection, range: SelectionRange) {
  const from = projection.toDisplay(range.from, 1);
  const to = range.empty ? from : projection.toDisplay(range.to, -1);
  return range.anchor <= range.head
    ? EditorSelection.range(from, to)
    : EditorSelection.range(to, from);
}

export class ProjectedSearchMatches {
  private chunks: Uint32Array[] = [];
  private query?: SearchQuery;
  private cursor?: Iterator<Match>;
  private generation = 0;
  size = 0;
  complete = true;

  constructor(readonly projection: DiffTextProjection) {}

  reset(query: SearchQuery, state: EditorState | (() => EditorState)) {
    if (sameQuery(this.query, query)) return;
    this.query = query;
    this.generation++;
    this.chunks = [];
    this.size = 0;
    this.complete = !query.valid;
    this.cursor = query.valid
      ? query.getCursor(typeof state === "function" ? state() : state)
      : undefined;
  }

  at(index: number): Match {
    const chunk = this.chunks[Math.floor(index / 2048)];
    const offset = (index % 2048) * 2;
    return { from: chunk[offset], to: chunk[offset + 1] };
  }

  advance() {
    if (!this.cursor || this.complete) return false;
    const match =
      this.cursor instanceof SearchCursor
        ? this.cursor.nextOverlapping()
        : this.cursor.next();
    if (match.done) {
      this.complete = true;
      return false;
    }
    const offset = (this.size % 2048) * 2;
    if (!offset) this.chunks.push(new Uint32Array(4096));
    const chunk = this.chunks[this.chunks.length - 1];
    chunk[offset] = match.value.from;
    chunk[offset + 1] = match.value.to;
    this.size++;
    return true;
  }

  scan(milliseconds = 4) {
    const started = performance.now();
    do {
      for (let step = 0; step < 64; step++) if (!this.advance()) return;
    } while (performance.now() - started < milliseconds);
  }

  cursorForDisplay(): Iterator<Match> {
    const generation = this.generation;
    let position = 0;
    return {
      next: () => {
        if (
          generation !== this.generation ||
          (position === this.size && !this.advance())
        )
          return { done: true, value: undefined };
        const match = this.at(position++);
        const from = this.projection.toDisplay(match.from, 1);
        return {
          done: false,
          value: {
            from,
            to:
              match.to === match.from
                ? from
                : this.projection.toDisplay(match.to, -1),
          },
        };
      },
    };
  }

  intersecting(from: number, to: number) {
    let low = 0,
      high = this.size;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.at(middle).to <= from) low = middle + 1;
      else high = middle;
    }
    const matches: Match[] = [];
    for (let index = low; index < this.size; index++) {
      const match = this.at(index);
      if (match.from >= to) break;
      matches.push(match);
    }
    return matches;
  }

  ordinal(from: number, to: number) {
    let low = 0,
      high = this.size;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.at(middle).from < from) low = middle + 1;
      else high = middle;
    }
    if (low === this.size) return 0;
    const match = this.at(low);
    return match.from === from && match.to === to ? low + 1 : 0;
  }
}

export function createProjectedSearchAdapter(projection: DiffTextProjection) {
  const matches = new ProjectedSearchMatches(projection);
  const locale = new Compartment();
  let original: EditorState | undefined;
  let phrases: readonly Record<string, string>[] | undefined;
  const stateFor = (view: EditorView, query: SearchQuery) => {
    const currentPhrases = view.state.facet(EditorState.phrases);
    const extensions = currentPhrases.map((value) =>
      EditorState.phrases.of(value),
    );
    if (!original)
      original = EditorState.create({
        doc: projection.sourceDoc,
        extensions: [
          search({
            scrollToMatch: (range) =>
              EditorView.scrollIntoView(displayRange(projection, range)),
          }),
          EditorState.allowMultipleSelections.of(true),
          EditorState.readOnly.of(true),
          locale.of(extensions),
        ],
      });
    const selection = view.state.selection;
    original = original.update({
      selection: EditorSelection.create(
        selection.ranges.map((range) =>
          EditorSelection.range(
            projection.toSource(range.anchor),
            projection.toSource(range.head),
          ),
        ),
        selection.mainIndex,
      ),
      effects: [
        setSearchQuery.of(query),
        ...(phrases === currentPhrases ? [] : [locale.reconfigure(extensions)]),
      ],
    }).state;
    phrases = currentPhrases;
    return new Proxy(original, {
      get(target, property) {
        if (property === "field")
          return <T>(field: StateField<T>, require = true) => {
            const value = target.field(field, false);
            return value === undefined
              ? require
                ? view.state.field(field)
                : view.state.field(field, false)
              : value;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const queryFor = (view: EditorView) =>
    sourceQuery(getSearchQuery(view.state));
  const adapter: SearchAdapter = {
    query: sourceQuery,
    getCursor(view, query) {
      matches.reset(query, () => stateFor(view, query));
      return matches.cursorForDisplay();
    },
    progress(view, query) {
      matches.reset(query, () => stateFor(view, query));
      const selection = view.state.selection.main;
      return {
        count: matches.size,
        ordinal: matches.ordinal(
          projection.toSource(selection.from),
          projection.toSource(selection.to),
        ),
        complete: matches.complete,
      };
    },
    open(view) {
      const previous = queryFor(view);
      const selection = view.state.selection.main;
      const active = view.root?.activeElement;
      const alreadyFocused =
        active &&
        view.state
          .facet(showPanel)
          .some(
            (panel) =>
              panel &&
              getPanel(view, panel)?.dom.querySelector("[main-field]") ===
                active,
          );
      const from = projection.toSource(selection.from);
      const to = projection.toSource(selection.to);
      const selected = to > from && to - from <= 100;
      const text = selected ? projection.source.slice(from, to) : "";
      openSearchPanel(view);
      if (!selection.empty && !alreadyFocused) {
        const query = text
          ? new SearchQuery({
              ...previous,
              search: previous.literal ? text : text.replace(/\n/g, "\\n"),
            })
          : previous;
        view.dispatch({ effects: setSearchQuery.of(query) });
      }
      return true;
    },
    next: run(findNext),
    previous: run(findPrevious),
    all: run(selectMatches),
    nextOccurrence: run(selectNextOccurrence, false),
    selectionMatches: run(selectSelectionMatches, false),
    goto: (view) => {
      closeSearchPanel(view);
      return run(gotoLine, false)(view);
    },
  };
  function run(command: Command, needsQuery = true): Command {
    return (view) => {
      const query = queryFor(view);
      if (needsQuery && !query.valid) return adapter.open(view);
      const state = stateFor(view, query);
      const dispatch = (input: Transaction | TransactionSpec) => {
        const transaction =
          input instanceof Transaction ? input : state.update(input);
        const selected = transaction.newSelection;
        const selection = EditorSelection.create(
          selected.ranges.map((range) => displayRange(projection, range)),
          selected.mainIndex,
        );
        const reveal =
          command === selectNextOccurrence
            ? (selected.ranges.find(
                (range) =>
                  !state.selection.ranges.some((previous) =>
                    previous.eq(range),
                  ),
              ) ?? selected.main)
            : selected.main;
        view.dispatch({
          ...(input instanceof Transaction ? {} : input),
          selection,
          effects: [
            ...transaction.effects,
            EditorView.scrollIntoView(displayRange(projection, reveal)),
          ],
          userEvent: transaction.annotation(Transaction.userEvent),
        });
      };
      const proxy = new Proxy(view, {
        get(target, property) {
          if (property === "state") return state;
          if (property === "dispatch") return dispatch;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return command(proxy);
    };
  }
  return { adapter, matches, stateFor, queryFor };
}

export function projectedSearch(projection: DiffTextProjection): Extension {
  if (!projection.active) return [];
  const { adapter, matches, stateFor, queryFor } =
    createProjectedSearchAdapter(projection);
  const highlighter = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer?: ReturnType<typeof setTimeout>;
      private destroyed = false;

      constructor(private view: EditorView) {
        this.refresh();
      }

      private refresh() {
        clearTimeout(this.timer);
        const query = queryFor(this.view);
        if (!searchPanelOpen(this.view.state) || !query.valid) {
          this.decorations = Decoration.none;
          return;
        }
        matches.reset(query, () => stateFor(this.view, query));
        this.draw();
        if (!matches.complete) this.timer = setTimeout(() => this.scan(), 0);
      }

      private scan() {
        if (this.destroyed) return;
        matches.scan();
        this.view.dispatch({ effects: refreshMatches.of(null) });
        if (!matches.complete) this.timer = setTimeout(() => this.scan(), 0);
      }

      private draw() {
        if (!searchPanelOpen(this.view.state) || !queryFor(this.view).valid) {
          this.decorations = Decoration.none;
          return;
        }
        const ranges = [];
        const included = new Set<string>();
        for (const visible of this.view.visibleRanges) {
          const from = projection.toSource(visible.from);
          const to = projection.toSource(visible.to);
          for (const match of matches.intersecting(from, to)) {
            if (match.from === match.to) continue;
            const key = `${match.from}:${match.to}`;
            if (included.has(key)) continue;
            included.add(key);
            const start = projection.toDisplay(match.from, 1);
            const end = projection.toDisplay(match.to, -1);
            const selected = this.view.state.selection.ranges.some(
              (range) => range.from === start && range.to === end,
            );
            ranges.push(
              (selected ? selectedMark : matchMark).range(start, end),
            );
          }
        }
        this.decorations = Decoration.set(ranges, true);
      }

      update(update: ViewUpdate) {
        if (
          !sameQuery(
            sourceQuery(getSearchQuery(update.startState)),
            queryFor(this.view),
          )
        )
          this.refresh();
        else if (
          searchPanelOpen(update.startState) !== searchPanelOpen(update.state)
        )
          this.refresh();
        else if (
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(refreshMatches)),
          )
        )
          this.draw();
      }

      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
  return [
    searchAdapter.of(adapter),
    EditorState.allowMultipleSelections.of(true),
    EditorState.transactionExtender.of((transaction) => {
      let query: SearchQuery | undefined;
      for (const effect of transaction.effects)
        if (effect.is(setSearchQuery)) query = effect.value;
      return query && !sourceQueries.has(query)
        ? { effects: setSearchQuery.of(guardedQuery(query)) }
        : null;
    }),
    highlighter,
  ];
}
