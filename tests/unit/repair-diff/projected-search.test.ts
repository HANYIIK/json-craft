import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type TransactionSpec,
} from "@codemirror/state";
import {
  SearchCursor,
  SearchQuery,
  getSearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { showPanel, type EditorView } from "@codemirror/view";
import { DiffTextProjection } from "../../../src/renderer/features/repair-diff/diff-text-projection";
import {
  ProjectedSearchMatches,
  createProjectedSearchAdapter,
  projectedSearch,
} from "../../../src/renderer/features/repair-diff/projected-search";

function fixture(source: string, breaks: number[]) {
  const projection = new DiffTextProjection(source, breaks);
  const projected = createProjectedSearchAdapter(projection);
  let state = EditorState.create({
    doc: projection.doc,
    extensions: [search(), projectedSearch(projection)],
  });
  const transactions: ReturnType<EditorState["update"]>[] = [];
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      const transaction = state.update(spec);
      state = transaction.state;
      transactions.push(transaction);
    },
    plugin() {
      return null;
    },
  } as unknown as EditorView;
  return { ...projected, projection, view, transactions };
}

function collect(cursor: Iterator<{ from: number; to: number }>) {
  const matches = [];
  for (let match = cursor.next(); !match.done; match = cursor.next())
    matches.push({ ...match.value });
  return matches;
}

function nativeMatches(source: string, query: SearchQuery) {
  const cursor = query.getCursor(EditorState.create({ doc: source }));
  const result = [];
  for (;;) {
    const match =
      cursor instanceof SearchCursor ? cursor.nextOverlapping() : cursor.next();
    if (match.done) return result;
    result.push({ from: match.value.from, to: match.value.to });
  }
}

test("literal, regexp and whole-word searches retain source semantics across display breaks", () => {
  const source = "first ababa TARGETword TARGET 😀 é\\n\nsecond TARGET end\n";
  const f = fixture(source, [8, 18, 27, 43]);
  for (const options of [
    { search: "aba" },
    { search: "TARGET" },
    { search: "TARGET", wholeWord: true },
    { search: "TARGETword TARGET", caseSensitive: true },
    { search: "\\n", literal: true },
    { search: "\\n" },
    { search: "é" },
    { search: "e" },
    { search: "😀" },
    { search: "^first|^second|end$", regexp: true },
    { search: "first.*é", regexp: true },
    { search: "é\\\\n\\nsecond", regexp: true },
    { search: "^|$", regexp: true },
    { search: "(?<=ab)aba", regexp: true },
    { search: "(?=TARGET)", regexp: true },
  ]) {
    const query = new SearchQuery(options);
    const matches = collect(f.adapter.getCursor(f.view, query));
    assert.deepEqual(
      matches.map(({ from, to }) => ({
        from: f.projection.toSource(from),
        to: f.projection.toSource(to),
      })),
      nativeMatches(source, query),
      JSON.stringify(options),
    );
  }
});

test("native next, previous and all commands map selections and retain search navigation events", () => {
  const f = fixture("zero NEEDLE middle NEEDLE tail NEEDLE", [8, 12, 22, 31]);
  f.view.dispatch({
    effects: setSearchQuery.of(new SearchQuery({ search: "NEEDLE" })),
  });
  assert.equal(f.adapter.next(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 5);
  assert.equal(f.projection.toSource(f.view.state.selection.main.to), 11);
  assert.equal(f.transactions.at(-1)!.isUserEvent("select.search"), true);
  assert.equal(f.adapter.next(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 19);
  assert.equal(f.adapter.previous(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 5);
  assert.equal(f.adapter.previous(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 31);
  assert.equal(f.adapter.all(f.view), true);
  assert.deepEqual(
    f.view.state.selection.ranges.map((range) => ({
      from: f.projection.toSource(range.from),
      to: f.projection.toSource(range.to),
    })),
    [
      { from: 5, to: 11 },
      { from: 19, to: 25 },
      { from: 31, to: 37 },
    ],
  );
});

test("opening search uses the original selected text rather than inserted display newlines", () => {
  const f = fixture("start QUERY ACROSS end", [8, 14]);
  f.view.dispatch({
    selection: EditorSelection.single(
      f.projection.toDisplay(6),
      f.projection.toDisplay(18, -1),
    ),
  });
  f.adapter.open(f.view);
  assert.equal(
    f.adapter.query(getSearchQuery(f.view.state)).search,
    "QUERY ACROSS",
  );
  assert.equal(f.adapter.next(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 6);
  assert.equal(f.projection.toSource(f.view.state.selection.main.to), 18);
});

test("native display highlighting is suppressed while original filters and anchors still run on source", () => {
  const source = "start abc abc end\nstart abc tail";
  const f = fixture(source, [7, 11, 24]);
  const calls: string[] = [];
  const query = new SearchQuery({
    search: "^start|abc",
    regexp: true,
    test(match, state, from, to) {
      assert.equal(state.doc.toString(), source);
      assert.equal(state.sliceDoc(from, to), match);
      calls.push(match);
      return match !== "start";
    },
  });
  f.view.dispatch({ effects: setSearchQuery.of(query) });
  const guarded = getSearchQuery(f.view.state);
  assert.deepEqual(collect(guarded.getCursor(f.view.state)), []);
  assert.equal(f.adapter.query(guarded), query);
  const mapped = collect(f.adapter.getCursor(f.view, query));
  assert.equal(mapped.length, 3);
  assert.ok(calls.includes("start"));
  assert.equal(f.adapter.next(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 6);
});

test("opening an already focused search field keeps its regular expression query", () => {
  const f = fixture("start NEEDLE end", [8]);
  const query = new SearchQuery({ search: "N.*E", regexp: true });
  f.view.dispatch({ effects: setSearchQuery.of(query) });
  f.adapter.open(f.view);
  f.adapter.next(f.view);
  const input = {};
  Reflect.set(f.view, "root", { activeElement: input });
  Reflect.set(f.view, "plugin", () => ({
    specs: f.view.state.facet(showPanel),
    panels: [{ dom: { querySelector: () => input } }],
  }));
  f.adapter.open(f.view);
  assert.equal(f.adapter.query(getSearchQuery(f.view.state)).search, "N.*E");
  assert.equal(f.adapter.query(getSearchQuery(f.view.state)).regexp, true);
});

test("match cache is shared, resets literal semantics and cancels obsolete counting cursors", () => {
  const f = fixture("a\\na\na\\na", [2, 6]);
  const first = new SearchQuery({ search: "\\n", literal: true });
  const cursor = f.adapter.getCursor(f.view, first);
  assert.equal(cursor.next().done, false);
  assert.equal(f.matches.size, 1);
  const second = f.adapter.getCursor(f.view, first);
  assert.deepEqual(second.next().value, {
    from: f.projection.toDisplay(1),
    to: f.projection.toDisplay(3, -1),
  });
  assert.equal(f.matches.size, 1);
  const actualNewline = new SearchQuery({ search: "\\n", literal: false });
  assert.equal(collect(f.adapter.getCursor(f.view, actualNewline)).length, 1);
  assert.equal(cursor.next().done, true);
});

test("dense searches build a bounded typed index in separate time slices", async () => {
  const source = "ababa ".repeat(50_000);
  const projection = new DiffTextProjection(source, [1024, 2048]);
  const matches = new ProjectedSearchMatches(projection);
  const query = new SearchQuery({ search: "aba" });
  matches.reset(query, EditorState.create({ doc: projection.sourceDoc }));
  matches.scan(0);
  assert.equal(matches.size, 64);
  assert.equal(matches.complete, false);
  let turns = 0;
  while (!matches.complete) {
    await delay(0);
    matches.scan(1);
    turns++;
  }
  assert.ok(turns > 1);
  assert.equal(matches.size, 100_000);
  assert.deepEqual(matches.intersecting(5, 13), [
    { from: 6, to: 9 },
    { from: 8, to: 11 },
    { from: 12, to: 15 },
  ]);
  assert.deepEqual(matches.at(matches.size - 1), {
    from: source.length - 4,
    to: source.length - 1,
  });
});

test("shared progress keeps its index through selection and replacement-only transactions", () => {
  const f = fixture("ababa ".repeat(1_000), [1024, 2048]);
  const query = new SearchQuery({ search: "aba" });
  assert.deepEqual(f.adapter.progress!(f.view, query), {
    count: 0,
    ordinal: 0,
    complete: false,
  });
  f.matches.scan(0);
  f.view.dispatch({
    selection: EditorSelection.single(
      f.projection.toDisplay(8),
      f.projection.toDisplay(11, -1),
    ),
  });
  assert.deepEqual(f.adapter.progress!(f.view, query), {
    count: 64,
    ordinal: 4,
    complete: false,
  });
  const replaced = new SearchQuery({ ...query, replace: "replacement" });
  assert.equal(f.adapter.progress!(f.view, replaced).count, 64);
  f.matches.scan(0);
  assert.equal(f.adapter.progress!(f.view, query).count, 128);
});

test("source selection commands accept native Transactions and select across display breaks", () => {
  const f = fixture("zero NEEDLE middle NEEDLE tail NEEDLE", [8, 12, 22, 31]);
  f.view.dispatch({
    selection: EditorSelection.cursor(f.projection.toDisplay(7)),
  });
  assert.equal(f.adapter.nextOccurrence!(f.view), true);
  assert.equal(f.projection.toSource(f.view.state.selection.main.from), 5);
  assert.equal(f.projection.toSource(f.view.state.selection.main.to), 11);
  assert.equal(f.adapter.nextOccurrence!(f.view), true);
  assert.deepEqual(
    f.view.state.selection.ranges.map((range) =>
      f.projection.toSource(range.from),
    ),
    [5, 19],
  );
  assert.equal(f.transactions.at(-1)!.effects.length, 2);
  f.view.dispatch({
    selection: EditorSelection.single(
      f.projection.toDisplay(19),
      f.projection.toDisplay(25, -1),
    ),
  });
  assert.equal(f.adapter.selectionMatches!(f.view), true);
  assert.deepEqual(
    f.view.state.selection.ranges.map((range) =>
      f.projection.toSource(range.from),
    ),
    [5, 19, 31],
  );
  assert.equal(f.view.state.selection.mainIndex, 1);
  assert.equal(
    f.transactions.at(-1)!.isUserEvent("select.search.matches"),
    true,
  );
});

test("source state fields fall back to actual view fields without changing source document semantics", () => {
  const f = fixture("first line\nsecond line\nthird line", [3, 6, 15]);
  const extra = StateField.define({
    create: () => "actual dialog state",
    update: (value) => value,
  });
  const missing = StateField.define({
    create: () => 0,
    update: (value) => value,
  });
  f.view.dispatch({ effects: StateEffect.appendConfig.of(extra) });
  const state = f.stateFor(f.view, new SearchQuery({ search: "line" }));
  assert.equal(state.doc.toString(), f.projection.source);
  assert.equal(state.doc.lines, 3);
  assert.equal(state.field(extra), "actual dialog state");
  assert.equal(state.field(missing, false), undefined);
  assert.throws(() => state.field(missing));
});

test("go to line uses original lines, reuses its dialog and maps the submitted source position", async (t) => {
  interface DialogNode {
    nodeType: number;
    nodeName: string;
    className: string;
    name: string;
    value: string;
    type: string;
    children: DialogNode[];
    ownerDocument: { activeElement: DialogNode | null };
    listeners: Map<string, (event: Event) => void>;
    classList: {
      add(...names: string[]): void;
      contains(name: string): boolean;
    };
    appendChild(child: DialogNode): DialogNode;
    querySelector(selector: string): DialogNode | null;
    setAttribute(name: string, value: string): void;
    addEventListener(name: string, listener: (event: Event) => void): void;
    contains(node: unknown): boolean;
    select(): void;
    readonly elements: Record<string, DialogNode>;
  }
  let selections = 0;
  function node(tag: string): DialogNode {
    const current: DialogNode = {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      className: "",
      name: "",
      value: "",
      type: "",
      children: [],
      ownerDocument: document,
      listeners: new Map(),
      classList: {
        add(...names) {
          current.className += " " + names.join(" ");
        },
        contains(name) {
          return current.className.split(/\s+/).includes(name);
        },
      },
      appendChild(child) {
        current.children.push(child);
        return child;
      },
      querySelector(selector) {
        const tag = selector.split("[")[0].toUpperCase();
        for (const child of current.children) {
          if (child.nodeName === tag) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      },
      setAttribute(name, value) {
        Reflect.set(current, name === "class" ? "className" : name, value);
      },
      addEventListener(name, listener) {
        current.listeners.set(name, listener);
      },
      contains(value) {
        return (
          current === value ||
          current.children.some((child) => child.contains(value))
        );
      },
      select() {
        selections++;
      },
      get elements() {
        const result: Record<string, DialogNode> = {};
        const collect = (item: DialogNode) => {
          if (item.name) result[item.name] = item;
          item.children.forEach(collect);
        };
        collect(current);
        return result;
      },
    };
    return current;
  }
  const document = {
    activeElement: null as DialogNode | null,
    createElement: node,
    createTextNode(text: string) {
      const value = node("#text");
      value.nodeType = 3;
      value.value = text;
      return value;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Reflect.set(globalThis, "document", document);
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const source = "a".repeat(12_000) + "\nsecond line\nthird final";
  const f = fixture(source, [1_000, 2_000, 3_000, 4_000]);
  Reflect.set(f.view, "win", { queueMicrotask });
  f.view.dispatch({
    selection: EditorSelection.cursor(f.projection.toDisplay(12_005)),
  });
  assert.equal(f.adapter.goto!(f.view), true);
  const factories = f.view.state
    .facet(showPanel)
    .filter((value) => value !== null);
  assert.equal(factories.length, 1);
  const panel = factories[0]!(f.view);
  const dialog = panel.dom as unknown as DialogNode;
  const input = dialog.querySelector("input")!;
  assert.equal(input.value, "2");
  Reflect.set(f.view, "plugin", () => ({ specs: factories, panels: [panel] }));
  const transactions = f.transactions.length;
  assert.equal(f.adapter.goto!(f.view), true);
  assert.equal(f.transactions.length, transactions);
  assert.equal(selections, 1);
  input.value = "3:2";
  const form = dialog.querySelector("form")!;
  form.listeners.get("submit")!({ preventDefault() {} } as Event);
  await delay(0);
  assert.equal(
    f.projection.toSource(f.view.state.selection.main.head),
    f.projection.sourceDoc.line(3).from + 2,
  );
  assert.equal(f.view.state.facet(showPanel).filter(Boolean).length, 0);
});
