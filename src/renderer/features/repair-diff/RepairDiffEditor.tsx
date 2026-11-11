import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  Compartment,
  EditorState,
  EditorSelection,
  Text,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  panels,
  runScopeHandlers,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Change,
  Chunk,
  MergeView,
  uncollapseUnchanged,
} from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { RepairStage } from "../../../shared/types";
import { json } from "../editor/json-language";
import { useResolvedTheme } from "../../theme/theme";
import { translate, useI18n } from "../../i18n/i18n";
import { jsonSearch, searchPanelLanguage } from "../editor/search-panel";
import {
  projectDiffTexts,
  type DiffTextProjection,
} from "./diff-text-projection";
import { computeDocumentDiff } from "./document-diff";
import { projectedJson } from "./projected-json";
import { projectedSearch } from "./projected-search";
import { useDiffLayout } from "./use-diff-layout";
import {
  captureDiffView,
  restoreDiffView,
  type DiffViewState,
} from "./diff-view-state";
import {
  nativeRepairChanges,
  unchangedDiffRange,
  repairChangeChunk,
  repairDifferenceIndex,
  repairDiffLineCounts,
  alignedDiffRows,
  mapProjectedChunks,
  repairChunkRange,
  validatedRepairChanges,
  type RepairDiffChange,
} from "./repair-diff-model";
import "./repair-diff-editor.css";
import "../editor/json-editor.css";

export interface RepairDiffEditorState {
  chunkCount: number;
  activeChunk: number;
  differenceCount: number;
  activeDifference: number;
  navigationKind: "change" | "chunk";
  precise: boolean;
  addedLines: number;
  removedLines: number;
  contextExpanded: boolean;
  wrapFallback?: boolean;
  error?: string;
}
export interface RepairDiffEditorRequest {
  index?: number;
  changeId?: string;
  key: number;
}
export interface RepairDiffEditorHandle {
  selectChunk(index: number): void;
  selectChange(changeId: string): void;
  showDifferences(): void;
  focus(): void;
}
export interface RepairDiffEditorProps {
  stage: RepairStage;
  showFull?: boolean;
  wrap?: boolean;
  labels?: { before: string; after: string };
  request?: RepairDiffEditorRequest;
  onStateChange?: (state: RepairDiffEditorState) => void;
}
function diffChunks(
  a: Text,
  b: Text,
  changes: readonly Change[],
  precise: boolean,
) {
  return Chunk.build(a, b, { override: () => changes }).map(
    (chunk) =>
      new Chunk(
        chunk.changes,
        chunk.fromA,
        chunk.toA,
        chunk.fromB,
        chunk.toB,
        precise,
      ),
  );
}
const collapseContext = { margin: 3, minSize: 4 };
const colorModes = {
  light: EditorView.theme({}, { dark: false }),
  dark: EditorView.theme({}, { dark: true }),
};
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--syntax-key)" },
    { tag: tags.string, color: "var(--syntax-string)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
    { tag: tags.punctuation, color: "var(--syntax-punctuation)" },
  ]),
);
const phraseKeys: Record<string, string> = {
  Find: "查找",
  next: "下一项",
  previous: "上一项",
  all: "全选",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全词匹配",
  close: "关闭",
  "current match": "当前匹配项",
  "on line": "位于行",
  "Go to line": "跳转到行",
  go: "跳转",
};
const phrases = EditorState.phrases.of(
  Object.defineProperties(
    {},
    Object.fromEntries([
      ["$ unchanged lines", { enumerable: true, get: () => "$" }],
      ...Object.entries(phraseKeys).map(([phrase, key]) => [
        phrase,
        { enumerable: true, get: () => translate(key) },
      ]),
    ]),
  ),
);
interface Instance {
  merge: MergeView;
  a: DiffTextProjection;
  b: DiffTextProjection;
  chunks: readonly Chunk[];
  exactChanges: RepairDiffChange[] | null;
  state: RepairDiffEditorState;
  readingSide: "a" | "b";
  themeA: Compartment;
  themeB: Compartment;
  ariaA: Compartment;
  ariaB: Compartment;
  localeA: Compartment;
  localeB: Compartment;
  scheduleControls(): void;
  navigate(
    fromA: number,
    fromB: number,
    source?: "a" | "b",
    toA?: number,
    toB?: number,
  ): void;
}
function editorAttributes(side: "a" | "b", label?: string) {
  return EditorView.contentAttributes.of({
    "aria-label":
      label ??
      translate(side === "a" ? "修复前差异编辑器" : "修复后差异编辑器"),
    "aria-readonly": "true",
    tabindex: "0",
  });
}
function selectRange(
  view: EditorView,
  projection: DiffTextProjection,
  from: number,
  to: number,
) {
  view.dispatch({
    selection: EditorSelection.range(
      projection.toDisplay(from),
      projection.toDisplay(to, from === to ? 1 : -1),
    ),
  });
}
function hiddenSourceLines(
  view: EditorView,
  projection: DiffTextProjection,
  widget: HTMLElement,
) {
  const position = view.posAtDOM(widget);
  let count = Number(widget.textContent?.match(/\d+/)?.[0] ?? 0);
  if (!projection.active) return count;
  for (const value of view.state.facet(EditorView.decorations)) {
    const decorations = typeof value === "function" ? value(view) : value;
    decorations.between(position, position, (from, to, decoration) => {
      if (
        from === position &&
        to > from &&
        decoration.spec.block &&
        decoration.spec.widget
      )
        count =
          projection.sourceDoc.lineAt(projection.toSource(to)).number -
          projection.sourceDoc.lineAt(projection.toSource(from)).number +
          1;
    });
  }
  return count;
}
export const RepairDiffEditor = forwardRef<
  RepairDiffEditorHandle,
  RepairDiffEditorProps
>(function RepairDiffEditor(
  { stage, showFull = false, wrap = true, request, onStateChange, labels },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<Instance | null>(null);
  const remembered = useRef<
    | {
        stage: RepairStage;
        state: RepairDiffEditorState;
        a: DiffViewState;
        b: DiffViewState;
        side: "a" | "b";
        active?: RepairDiffChange;
      }
    | undefined
  >(undefined);
  const onState = useRef(onStateChange);
  onState.current = onStateChange;
  const theme = useResolvedTheme();
  const { language } = useI18n();
  const latest = useRef({ theme, showFull, language, labels, request });
  latest.current = { theme, showFull, language, labels, request };
  const model = useMemo(() => {
    const exactChanges = validatedRepairChanges(stage);
    const a = Text.of(stage.before.split("\n")),
      b = Text.of(stage.after.split("\n"));
    const computed = exactChanges
      ? { changes: nativeRepairChanges(exactChanges), precise: true }
      : computeDocumentDiff(stage.before, stage.after);
    const chunks = diffChunks(a, b, computed.changes, computed.precise);
    const changes = chunks.flatMap((chunk) =>
      chunk.changes.map(
        (change) =>
          new Change(
            chunk.fromA + change.fromA,
            chunk.fromA + change.toA,
            chunk.fromB + change.fromB,
            chunk.fromB + change.toB,
          ),
      ),
    );
    return { exactChanges, chunks, changes, a, b, precise: computed.precise };
  }, [stage]);
  const layout = useDiffLayout(host, Math.max(model.a.lines, model.b.lines));
  const projection = useMemo(() => {
    let projected = projectDiffTexts(
      stage.before,
      stage.after,
      model.changes,
      wrap && Boolean(layout),
      layout,
    );
    let chunks =
      projected.a.active || projected.b.active
        ? diffChunks(
            projected.a.doc,
            projected.b.doc,
            projected.changes,
            model.precise,
          )
        : model.chunks;
    let wrapFallback = false;
    if (layout?.maxDOMHeight && (projected.a.active || projected.b.active)) {
      if (
        alignedDiffRows(chunks, projected.a.doc, projected.b.doc) * 24 + 2_000 >
        layout.maxDOMHeight
      ) {
        projected = projectDiffTexts(
          stage.before,
          stage.after,
          model.changes,
          true,
          {
            width: 1_024,
            measure: () => 1,
            preferWordBoundaries: true,
          },
        );
        chunks = diffChunks(
          projected.a.doc,
          projected.b.doc,
          projected.changes,
          model.precise,
        );
        wrapFallback = true;
      }
    }
    return {
      ...projected,
      wrapFallback,
      navigationChunks: model.exactChanges
        ? model.chunks
        : mapProjectedChunks(chunks, projected.a, projected.b),
    };
  }, [stage.before, stage.after, model, wrap, layout]);
  const publish = useCallback((state: RepairDiffEditorState) => {
    if (host.current) {
      if (!state.error) delete host.current.dataset.error;
      for (const [key, value] of Object.entries(state))
        host.current.dataset[key] = String(value);
    }
    onState.current?.({ ...state });
  }, []);
  const selectDifference = useCallback(
    (requestedIndex: number, requestedChunk?: number) => {
      const instance = current.current;
      if (!instance) return;
      const index = repairDifferenceIndex(
        requestedIndex,
        instance.state.differenceCount,
      );
      if (index < 0) return;
      const change = instance.exactChanges?.[index];
      const chunkIndex =
        requestedChunk ??
        (change ? repairChangeChunk(instance.chunks, change) : index);
      const chunk = instance.chunks[chunkIndex];
      if (!chunk) return;
      const range = change ?? repairChunkRange(chunk);
      selectRange(instance.merge.a, instance.a, range.fromA, range.toA);
      selectRange(instance.merge.b, instance.b, range.fromB, range.toB);
      instance.navigate(
        range.fromA,
        range.fromB,
        undefined,
        range.toA,
        range.toB,
      );
      instance.state = {
        ...instance.state,
        activeChunk: chunkIndex,
        activeDifference: index,
      };
      publish(instance.state);
      instance.scheduleControls();
    },
    [publish],
  );
  const selectChunk = useCallback(
    (index: number) => {
      const instance = current.current;
      if (!instance) return;
      const chunkIndex = repairDifferenceIndex(index, instance.chunks.length);
      const exactIndex = instance.exactChanges?.findIndex(
        (change) => repairChangeChunk(instance.chunks, change) === chunkIndex,
      );
      selectDifference(
        exactIndex !== undefined && exactIndex >= 0 ? exactIndex : chunkIndex,
        chunkIndex,
      );
    },
    [selectDifference],
  );
  const selectChange = useCallback(
    (id: string) => {
      const instance = current.current;
      if (!instance) return;
      const index = instance.exactChanges?.findIndex(
        (change) => change.id === id,
      );
      if (index !== undefined && index >= 0) selectDifference(index);
      else {
        const recorded = stage.changes.find((change) => change.id === id);
        if (recorded)
          selectChunk(
            repairChangeChunk(instance.chunks, {
              id,
              fromA: recorded.start,
              toA: recorded.end,
              fromB: recorded.start,
              toB: recorded.start,
            }),
          );
      }
    },
    [stage.changes, selectDifference, selectChunk],
  );
  const showDifferences = useCallback(() => {
    const instance = current.current;
    if (!instance) return;
    instance.merge.reconfigure({ collapseUnchanged: collapseContext });
    instance.state = { ...instance.state, contextExpanded: false };
    if (instance.state.activeDifference >= 0)
      selectDifference(instance.state.activeDifference);
    else publish(instance.state);
    instance.scheduleControls();
  }, [publish, selectDifference]);
  useImperativeHandle(
    ref,
    () => ({
      selectChunk,
      selectChange,
      showDifferences,
      focus: () => current.current?.merge.b.focus(),
    }),
    [selectChunk, selectChange, showDifferences],
  );

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !layout) return;
    let animation = 0,
      navigationFrame = 0,
      disposed = false;
    let merge: MergeView | undefined;
    let observer: MutationObserver | undefined,
      resize: ResizeObserver | undefined;
    const refreshControls = () => {
      animation = 0;
      if (disposed || !merge) return;
      for (const widget of element.querySelectorAll<HTMLElement>(
        ".cm-collapsedLines",
      )) {
        const before = Boolean(widget.closest(".cm-merge-a"));
        const view = before ? merge.a : merge.b;
        if (!widget.dataset.hiddenLines)
          widget.dataset.hiddenLines = String(
            hiddenSourceLines(
              view,
              before ? projection.a : projection.b,
              widget,
            ),
          );
        const label = translate("展开 {{count}} 行未变更内容", {
          count: Number(widget.dataset.hiddenLines),
        });
        if (widget.textContent !== label) widget.textContent = label;
        if (widget.getAttribute("aria-label") !== label)
          widget.setAttribute("aria-label", label);
        if (!widget.hasAttribute("role")) {
          widget.setAttribute("role", "button");
          widget.tabIndex = 0;
          widget.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            widget.click();
            view.focus();
          });
        }
      }
    };
    const scheduleControls = () => {
      if (!animation && !disposed)
        animation = requestAnimationFrame(refreshControls);
    };
    const interruptNavigation = (event: Event) => {
      cancelAnimationFrame(navigationFrame);
      const target = event.target as Element;
      const instance = current.current;
      if (!instance || typeof target.closest !== "function") return;
      if (target.closest('.cm-merge-a, [data-testid="diff-before-panels"]'))
        instance.readingSide = "a";
      else if (target.closest('.cm-merge-b, [data-testid="diff-after-panels"]'))
        instance.readingSide = "b";
    };
    try {
      const themeA = new Compartment(),
        themeB = new Compartment(),
        ariaA = new Compartment(),
        ariaB = new Compartment(),
        localeA = new Compartment(),
        localeB = new Compartment();
      const panel = (side: "before" | "after") => {
        const overlay = document.createElement("div"),
          container = document.createElement("div");
        overlay.className = `repair-diff-panels repair-diff-panels-${side}`;
        container.className = "repair-diff-panel-container";
        container.dataset.testid = `diff-${side}-panels`;
        overlay.append(container);
        element.append(overlay);
        container.addEventListener("keydown", (event) => {
          if (
            event.defaultPrevented ||
            !(event.target as Element).closest(".cm-goto-line")
          )
            return;
          const view = side === "before" ? merge?.a : merge?.b;
          if (view && runScopeHandlers(view, event, "editor"))
            event.preventDefault();
        });
        return panels({ topContainer: container, bottomContainer: container });
      };
      const updateListener = EditorView.updateListener.of(
        (update: ViewUpdate) => {
          const instance = current.current;
          if (
            instance &&
            !instance.state.contextExpanded &&
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) =>
                effect.is(uncollapseUnchanged),
              ),
            )
          ) {
            instance.state = { ...instance.state, contextExpanded: true };
            publish(instance.state);
          }
          if (update.viewportChanged || update.geometryChanged)
            scheduleControls();
          if (
            merge &&
            update.transactions.some((transaction) =>
              transaction.isUserEvent("select.search"),
            )
          ) {
            const selection = update.state.selection;
            queueMicrotask(() => {
              if (
                disposed ||
                !merge ||
                !update.view.state.selection.eq(selection)
              )
                return;
              const fromA = update.view === merge.a,
                projected = fromA ? projection.a : projection.b;
              const start = projected.toSource(selection.main.from),
                end = projected.toSource(selection.main.to);
              const changes =
                model.exactChanges ??
                model.changes.map((change, index) => ({
                  ...change,
                  id: String(index),
                }));
              const mapped = unchangedDiffRange(changes, start, end, fromA);
              current.current?.navigate(
                fromA ? start : (mapped?.from ?? 0),
                fromA ? (mapped?.from ?? 0) : start,
                mapped ? undefined : fromA ? "a" : "b",
                fromA ? end : mapped?.to,
                fromA ? mapped?.to : end,
              );
            });
          }
        },
      );
      const common = [
        EditorState.readOnly.of(true),
        EditorState.allowMultipleSelections.of(true),
        EditorView.editorAttributes.of({
          "data-json-craft-dom-height": String(
            layout.maxDOMHeight ?? 7_000_000,
          ),
        }),
        EditorState.lineSeparator.of("\n"),
        EditorView.editable.of(false),
        drawSelection(),
        keymap.of([
          ...searchKeymap,
          ...defaultKeymap.filter((binding) => binding.key !== "Escape"),
        ]),
        jsonSearch,
        phrases,
        updateListener,
        ...(wrap && !projection.a.active && !projection.b.active
          ? [EditorView.lineWrapping]
          : []),
      ];
      const syntax = (value: DiffTextProjection) =>
        value.active
          ? [projectedJson(value), projectedSearch(value)]
          : [highlight, json()];
      element.dataset.projected = String(
        projection.a.active || projection.b.active,
      );
      merge = new MergeView({
        parent: element,
        a: {
          doc: projection.a.doc,
          extensions: [
            ...common,
            ...syntax(projection.a),
            lineNumbers({
              formatNumber: (number) => projection.a.lineNumber(number),
            }),
            themeA.of(colorModes[latest.current.theme]),
            ariaA.of(editorAttributes("a", latest.current.labels?.before)),
            localeA.of(searchPanelLanguage.of(latest.current.language)),
            panel("before"),
          ],
        },
        b: {
          doc: projection.b.doc,
          extensions: [
            ...common,
            ...syntax(projection.b),
            lineNumbers({
              formatNumber: (number) => projection.b.lineNumber(number),
            }),
            themeB.of(colorModes[latest.current.theme]),
            ariaB.of(editorAttributes("b", latest.current.labels?.after)),
            localeB.of(searchPanelLanguage.of(latest.current.language)),
            panel("after"),
          ],
        },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: latest.current.showFull
          ? undefined
          : collapseContext,
        diffConfig: { override: () => projection.changes },
      });
      merge.a.dom.parentElement!.dataset.testid = "diff-before";
      merge.b.dom.parentElement!.dataset.testid = "diff-after";
      const navigate = (
        fromA: number,
        fromB: number,
        source?: "a" | "b",
        toA = fromA,
        toB = fromB,
      ) => {
        cancelAnimationFrame(navigationFrame);
        const scroll = () => {
          if (disposed || !merge) return;
          if (source !== "b")
            merge.a.dispatch({
              effects: EditorView.scrollIntoView(
                EditorSelection.range(
                  projection.a.toDisplay(fromA),
                  projection.a.toDisplay(toA, fromA === toA ? 1 : -1),
                ),
                { y: "center", x: "nearest", yMargin: 48 },
              ),
            });
          if (source !== "a")
            merge.b.dispatch({
              effects: EditorView.scrollIntoView(
                EditorSelection.range(
                  projection.b.toDisplay(fromB),
                  projection.b.toDisplay(toB, fromB === toB ? 1 : -1),
                ),
                { y: "center", x: "nearest", yMargin: 48 },
              ),
            });
        };
        scroll();
        navigationFrame = requestAnimationFrame(() => {
          navigationFrame = 0;
          scroll();
        });
      };
      for (const event of ["wheel", "pointerdown", "keydown"])
        element.addEventListener(event, interruptNavigation, true);
      const saved =
        remembered.current?.stage === stage ? remembered.current : undefined;
      remembered.current = undefined;
      const chunks = projection.navigationChunks;
      const state: RepairDiffEditorState = {
        chunkCount: chunks.length,
        activeChunk: -1,
        differenceCount: model.exactChanges?.length ?? chunks.length,
        activeDifference: -1,
        contextExpanded: latest.current.showFull,
        navigationKind: model.exactChanges ? "change" : "chunk",
        precise: model.precise,
        ...repairDiffLineCounts(model.chunks, model.a, model.b),
      };
      if (saved) {
        state.activeChunk = saved.active
          ? repairChangeChunk(chunks, saved.active)
          : -1;
        state.activeDifference = model.exactChanges
          ? saved.state.activeDifference
          : state.activeChunk;
        state.contextExpanded = saved.state.contextExpanded;
      }
      state.wrapFallback = projection.wrapFallback;
      current.current = {
        merge,
        a: projection.a,
        b: projection.b,
        chunks,
        exactChanges: model.exactChanges,
        state,
        readingSide: saved?.side ?? "b",
        themeA,
        themeB,
        ariaA,
        ariaB,
        localeA,
        localeB,
        scheduleControls,
        navigate,
      };
      observer = new MutationObserver(scheduleControls);
      observer.observe(element, { childList: true, subtree: true });
      resize = new ResizeObserver(() => {
        merge?.a.requestMeasure();
        merge?.b.requestMeasure();
      });
      resize.observe(element);
      if (saved) {
        const focused = document.activeElement;
        if (saved.state.contextExpanded)
          merge.reconfigure({ collapseUnchanged: undefined });
        restoreDiffView(merge.a, projection.a, saved.a);
        restoreDiffView(merge.b, projection.b, saved.b);
        if (saved.a.focus === "editor") merge.a.focus();
        else if (saved.b.focus === "editor") merge.b.focus();
        else if (
          !saved.a.focus &&
          !saved.b.focus &&
          focused instanceof HTMLElement
        )
          focused.focus({ preventScroll: true });
        if (saved.a.focus === "search")
          element
            .querySelector<HTMLInputElement>(
              '[data-testid="diff-before-panels"] input[name="search"]',
            )
            ?.focus();
        const side = saved[saved.side].visible
          ? saved.side
          : saved.a.visible
            ? "a"
            : "b";
        navigate(saved.a.position, saved.b.position, side);
        publish(state);
      } else if (latest.current.request?.changeId)
        selectChange(latest.current.request.changeId);
      else if (state.differenceCount)
        selectDifference(latest.current.request?.index ?? 0);
      else publish(state);
      scheduleControls();
    } catch (error) {
      merge?.destroy();
      merge = undefined;
      element.replaceChildren();
      current.current = null;
      publish({
        chunkCount: 0,
        activeChunk: -1,
        differenceCount: 0,
        activeDifference: -1,
        navigationKind: "chunk",
        precise: false,
        addedLines: 0,
        removedLines: 0,
        contextExpanded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return () => {
      if (merge && current.current) {
        const viewport = merge.dom.getBoundingClientRect();
        remembered.current = {
          stage,
          state: { ...current.current.state },
          side: current.current.readingSide,
          active: current.current.chunks[current.current.state.activeChunk]
            ? {
                id: "active",
                ...repairChunkRange(
                  current.current.chunks[current.current.state.activeChunk],
                ),
              }
            : undefined,
          a: captureDiffView(
            merge.a,
            projection.a,
            element.querySelector('[data-testid="diff-before-panels"]'),
            viewport,
          ),
          b: captureDiffView(
            merge.b,
            projection.b,
            element.querySelector('[data-testid="diff-after-panels"]'),
            viewport,
          ),
        };
      }
      disposed = true;
      cancelAnimationFrame(animation);
      cancelAnimationFrame(navigationFrame);
      observer?.disconnect();
      resize?.disconnect();
      for (const event of ["wheel", "pointerdown", "keydown"])
        element.removeEventListener(event, interruptNavigation, true);
      current.current = null;
      merge?.destroy();
      element.replaceChildren();
    };
  }, [
    stage,
    model,
    projection,
    layout,
    wrap,
    publish,
    selectDifference,
    selectChange,
  ]);

  useLayoutEffect(() => {
    const instance = current.current;
    if (!instance) return;
    instance.merge.a.dispatch({
      effects: [
        instance.themeA.reconfigure(colorModes[theme]),
        instance.ariaA.reconfigure(editorAttributes("a", labels?.before)),
        instance.localeA.reconfigure(searchPanelLanguage.of(language)),
      ],
    });
    instance.merge.b.dispatch({
      effects: [
        instance.themeB.reconfigure(colorModes[theme]),
        instance.ariaB.reconfigure(editorAttributes("b", labels?.after)),
        instance.localeB.reconfigure(searchPanelLanguage.of(language)),
      ],
    });
    instance.scheduleControls();
  }, [theme, language, projection, labels?.before, labels?.after]);
  useLayoutEffect(() => {
    const instance = current.current;
    if (!instance) return;
    if (!showFull) {
      showDifferences();
      return;
    }
    instance.merge.reconfigure({ collapseUnchanged: undefined });
    instance.state = { ...instance.state, contextExpanded: true };
    if (instance.state.activeDifference >= 0)
      selectDifference(instance.state.activeDifference);
    else publish(instance.state);
    instance.scheduleControls();
  }, [showFull, stage, selectDifference, showDifferences, publish]);
  useLayoutEffect(() => {
    if (request?.changeId) selectChange(request.changeId);
    else if (request?.index !== undefined) selectDifference(request.index);
  }, [request, stage, selectChange, selectDifference]);
  return (
    <div
      ref={host}
      className="repair-diff-editor json-editor"
      data-testid="repair-diff-editor"
    />
  );
});
