import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { Compartment, EditorState, EditorSelection } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  panels,
  type ViewUpdate,
} from "@codemirror/view";
import { MergeView, diff, uncollapseUnchanged } from "@codemirror/merge";
import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { RepairStage } from "../../../shared/types";
import { json } from "../editor/json-language";
import { useResolvedTheme } from "../../theme/theme";
import { translate, useI18n } from "../../i18n/i18n";
import { jsonSearch, searchPanelLanguage } from "../editor/search-panel";
import { synchronizeDiffLines } from "./shared-diff-lines";
import {
  nativeRepairChanges,
  longJsonLines,
  precedingLongLine,
  unchangedDiffRange,
  repairChangeChunk,
  repairDifferenceIndex,
  repairDiffLineCounts,
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
  request?: RepairDiffEditorRequest;
  onStateChange?: (state: RepairDiffEditorState) => void;
}

const boundedDiff = { scanLimit: 2_000, timeout: 100 };
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
  exactChanges: RepairDiffChange[] | null;
  state: RepairDiffEditorState;
  themeA: Compartment;
  themeB: Compartment;
  wrapA: Compartment;
  wrapB: Compartment;
  ariaA: Compartment;
  ariaB: Compartment;
  localeA: Compartment;
  localeB: Compartment;
  scheduleControls(): void;
  navigate(fromA: number, fromB: number, source?: "a" | "b"): void;
}

function editorAttributes(side: "a" | "b") {
  return EditorView.contentAttributes.of({
    "aria-label": translate(
      side === "a" ? "修复前差异编辑器" : "修复后差异编辑器",
    ),
    "aria-readonly": "true",
    tabindex: "0",
  });
}

function selectRange(view: EditorView, from: number, to: number) {
  view.dispatch({
    selection: EditorSelection.range(
      Math.min(from, view.state.doc.length),
      Math.min(to, view.state.doc.length),
    ),
  });
}

function collapsedLongLine(view: EditorView, from: number, to: number) {
  for (const value of view.state.facet(EditorView.decorations)) {
    const decorations = typeof value === "function" ? value(view) : value;
    let collapsed = false;
    decorations.between(from, to, (start, end, decoration) => {
      if (end > start && start <= from && end >= to && decoration.spec.block)
        collapsed = true;
    });
    if (collapsed) return true;
  }
  return false;
}

function actualCaret(view: EditorView, position: number) {
  const { node, offset } = view.domAtPos(position);
  let text: Node | null = node;
  let at = offset;
  if (node.nodeType !== Node.TEXT_NODE) {
    const child = node.childNodes[offset] ?? node.childNodes[offset - 1];
    if (!child) return;
    const end = offset >= node.childNodes.length;
    const walker = view.dom.ownerDocument.createTreeWalker(
      child,
      NodeFilter.SHOW_TEXT,
    );
    text = child.nodeType === Node.TEXT_NODE ? child : walker.nextNode();
    if (end && child.nodeType !== Node.TEXT_NODE) {
      for (let next = walker.nextNode(); next; next = walker.nextNode())
        text = next;
    }
    at = end ? (text?.textContent?.length ?? 0) : 0;
  }
  if (
    !text?.textContent?.length ||
    text.parentElement?.closest(".cm-widgetBuffer, .cm-gap") ||
    view.posAtDOM(text, at) !== position
  )
    return;
  const line = text.parentElement?.closest(".cm-line");
  const logical = view.state.doc.lineAt(position);
  if (
    !line ||
    view.posAtDOM(line) !== logical.from ||
    view.posAtDOM(line, line.childNodes.length) !== logical.to
  )
    return;
  const lineHeight = parseFloat(getComputedStyle(view.contentDOM).lineHeight);
  const range = view.dom.ownerDocument.createRange();
  const read = () =>
    Array.from(range.getClientRects()).find(
      (rect) =>
        Number.isFinite(rect.top) &&
        Number.isFinite(rect.bottom) &&
        rect.height > 1 &&
        rect.height <= lineHeight * 1.5,
    );
  range.setStart(text, at);
  range.collapse(true);
  const caret = read();
  if (caret) return caret;
  const length = text.textContent.length;
  if (at < length) range.setEnd(text, at + 1);
  else if (at > 0) {
    range.setStart(text, at - 1);
    range.setEnd(text, at);
  }
  return read();
}

export const RepairDiffEditor = forwardRef<
  RepairDiffEditorHandle,
  RepairDiffEditorProps
>(function RepairDiffEditor(
  { stage, showFull = false, wrap = true, request, onStateChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<Instance | null>(null);
  const onState = useRef(onStateChange);
  onState.current = onStateChange;
  const theme = useResolvedTheme();
  const { language } = useI18n();
  const latest = useRef({ theme, showFull, wrap, language });
  latest.current = { theme, showFull, wrap, language };

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
      const { merge, exactChanges } = instance;
      const index = repairDifferenceIndex(
        requestedIndex,
        instance.state.differenceCount,
      );
      if (index < 0) return;
      const change = exactChanges?.[index];
      const chunkIndex =
        requestedChunk ??
        (change ? repairChangeChunk(merge.chunks, change) : index);
      const chunk = merge.chunks[chunkIndex];
      if (!chunk) return;
      const range = change ?? {
        fromA: chunk.fromA,
        toA: chunk.endA,
        fromB: chunk.fromB,
        toB: chunk.endB,
      };
      selectRange(merge.a, range.fromA, range.toA);
      selectRange(merge.b, range.fromB, range.toB);
      instance.navigate(range.fromA, range.fromB);
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
      const chunkIndex = repairDifferenceIndex(
        index,
        instance.merge.chunks.length,
      );
      const exactIndex = instance.exactChanges?.findIndex(
        (change) =>
          repairChangeChunk(instance.merge.chunks, change) === chunkIndex,
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
            repairChangeChunk(instance.merge.chunks, {
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
    if (!element) return;
    let animation = 0;
    let navigationFrame = 0;
    let navigationGeneration = 0;
    let navigationActive = false;
    let disposed = false;
    let merge: MergeView | undefined;
    let observer: MutationObserver | undefined;
    let resize: ResizeObserver | undefined;
    let stopSharing: (() => void) | undefined;
    const refreshControls = () => {
      animation = 0;
      if (disposed || !merge) return;
      for (const widget of element.querySelectorAll<HTMLElement>(
        ".cm-collapsedLines",
      )) {
        if (!widget.dataset.hiddenLines)
          widget.dataset.hiddenLines =
            widget.textContent?.match(/\d+/)?.[0] ?? "0";
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
            const view = widget.closest(".cm-merge-a") ? merge?.a : merge?.b;
            widget.click();
            view?.focus();
          });
        }
      }
    };
    const scheduleControls = () => {
      if (!animation && !disposed)
        animation = requestAnimationFrame(refreshControls);
    };
    try {
      const exactChanges = validatedRepairChanges(stage);
      const themeA = new Compartment();
      const themeB = new Compartment();
      const wrapA = new Compartment();
      const wrapB = new Compartment();
      const ariaA = new Compartment();
      const ariaB = new Compartment();
      const localeA = new Compartment();
      const localeB = new Compartment();
      const overlayA = document.createElement("div");
      const overlayB = document.createElement("div");
      overlayA.className = "repair-diff-panels repair-diff-panels-before";
      overlayB.className = "repair-diff-panels repair-diff-panels-after";
      const panelA = document.createElement("div");
      const panelB = document.createElement("div");
      panelA.className = "repair-diff-panel-container";
      panelB.className = "repair-diff-panel-container";
      panelA.dataset.testid = "diff-before-panels";
      panelB.dataset.testid = "diff-after-panels";
      overlayA.append(panelA);
      overlayB.append(panelB);
      element.append(overlayA, overlayB);
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
              const position = selection.main.head;
              const fromA = update.view === merge.a;
              const shared = current.current?.exactChanges;
              const mapped =
                shared &&
                update.view.state.doc.lineAt(position).length >= 10_000
                  ? unchangedDiffRange(
                      shared,
                      selection.main.from,
                      selection.main.to,
                      fromA,
                    )
                  : undefined;
              current.current?.navigate(
                fromA ? position : (mapped?.to ?? 0),
                fromA ? (mapped?.to ?? 0) : position,
                mapped ? undefined : fromA ? "a" : "b",
              );
            });
          }
        },
      );
      const common = [
        EditorState.readOnly.of(true),
        EditorState.lineSeparator.of("\n"),
        EditorView.editable.of(false),
        lineNumbers(),
        drawSelection(),
        keymap.of([
          ...searchKeymap,
          ...defaultKeymap.filter((binding) => binding.key !== "Escape"),
        ]),
        jsonSearch,
        highlight,
        json(),
        phrases,
        updateListener,
      ];
      merge = new MergeView({
        parent: element,
        a: {
          doc: stage.before,
          extensions: [
            ...common,
            themeA.of(colorModes[latest.current.theme]),
            wrapA.of(latest.current.wrap ? EditorView.lineWrapping : []),
            ariaA.of(editorAttributes("a")),
            localeA.of(searchPanelLanguage.of(latest.current.language)),
            panels({ topContainer: panelA }),
          ],
        },
        b: {
          doc: stage.after,
          extensions: [
            ...common,
            themeB.of(colorModes[latest.current.theme]),
            wrapB.of(latest.current.wrap ? EditorView.lineWrapping : []),
            ariaB.of(editorAttributes("b")),
            localeB.of(searchPanelLanguage.of(latest.current.language)),
            panels({ topContainer: panelB }),
          ],
        },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: latest.current.showFull
          ? undefined
          : collapseContext,
        diffConfig: exactChanges
          ? {
              ...boundedDiff,
              override: (a, b) =>
                a === stage.before && b === stage.after
                  ? nativeRepairChanges(exactChanges)
                  : diff(a, b, boundedDiff),
            }
          : boundedDiff,
      });
      merge.a.dom.parentElement!.dataset.testid = "diff-before";
      merge.b.dom.parentElement!.dataset.testid = "diff-after";
      const count = exactChanges?.length ?? merge.chunks.length;
      const linesA = longJsonLines(merge.a.state.doc);
      const linesB = longJsonLines(merge.b.state.doc);
      const targets = (fromA: number, fromB: number, source?: "a" | "b") => {
        if (!merge) return [];
        return (
          [
            [merge.a, fromA, "a"],
            [merge.b, fromB, "b"],
          ] as const
        ).filter((entry) => !source || entry[2] === source);
      };
      const scroll = (
        fromA: number,
        fromB: number,
        end = false,
        source?: "a" | "b",
      ) => {
        if (disposed) return;
        for (const [view, position] of targets(fromA, fromB, source))
          view.dispatch({
            effects: EditorView.scrollIntoView(
              Math.min(position, view.state.doc.length),
              { y: end ? "end" : "center", x: "nearest", yMargin: 48 },
            ),
          });
      };
      const navigate = (fromA: number, fromB: number, source?: "a" | "b") => {
        const generation = ++navigationGeneration;
        cancelAnimationFrame(navigationFrame);
        if (!merge) return;
        navigationActive = true;
        const selectionA = merge.a.state.selection;
        const selectionB = merge.b.state.selection;
        const valid = () =>
          !disposed &&
          generation === navigationGeneration &&
          Boolean(
            merge?.a.state.selection.eq(selectionA) &&
            merge.b.state.selection.eq(selectionB),
          );
        const reach = (
          a: number,
          b: number,
          end: boolean,
          stableFrames: number,
          done: () => void,
        ) => {
          let attempts = 0,
            stable = 0;
          const probe = () => {
            navigationFrame = 0;
            if (!valid() || !merge) {
              navigationActive = false;
              return;
            }
            const views = targets(a, b, source);
            for (const [view] of views) view.requestMeasure();
            const observed = views.map(([view, position]) => {
              const offset = Math.min(position, view.state.doc.length);
              const coordinates = actualCaret(view, offset);
              const bounds = element.getBoundingClientRect();
              const rendered = Boolean(coordinates);
              return {
                rendered,
                coordinates,
                visible:
                  rendered &&
                  Boolean(
                    coordinates &&
                    coordinates.top >= bounds.top - 1 &&
                    coordinates.bottom <= bounds.bottom + 1,
                  ),
              };
            });
            if (!valid()) {
              navigationActive = false;
              return;
            }
            const visible = observed.every((value) => value.visible);
            stable = visible ? stable + 1 : 0;
            if (stable >= stableFrames || ++attempts >= 20) {
              navigationFrame = requestAnimationFrame(() => {
                if (valid()) done();
              });
            } else {
              if (!visible) {
                const actual = observed
                  .filter(
                    (value) =>
                      value.rendered &&
                      value.coordinates &&
                      Number.isFinite(value.coordinates.top) &&
                      Number.isFinite(value.coordinates.bottom),
                  )
                  .sort(
                    (left, right) =>
                      left.coordinates!.top - right.coordinates!.top,
                  )[0]?.coordinates;
                let corrected = false;
                if (actual) {
                  const bounds = merge.dom.getBoundingClientRect();
                  const delta =
                    (actual.top + actual.bottom - bounds.top - bounds.bottom) /
                    2;
                  if (Math.abs(delta) > 2) {
                    const previous = merge.dom.scrollTop;
                    merge.dom.scrollTop += delta;
                    corrected = Math.abs(merge.dom.scrollTop - previous) > 0.5;
                    if (corrected) {
                      merge.a.requestMeasure();
                      merge.b.requestMeasure();
                    }
                  }
                }
                if (!corrected) scroll(a, b, end, source);
              }
              navigationFrame = requestAnimationFrame(probe);
            }
          };
          scroll(a, b, end, source);
          navigationFrame = requestAnimationFrame(probe);
        };
        const finish = () =>
          reach(fromA, fromB, false, 2, () => {
            navigationActive = false;
            merge?.a.requestMeasure();
            merge?.b.requestMeasure();
          });
        const a = precedingLongLine(linesA, fromA);
        const b = precedingLongLine(linesB, fromB);
        if (
          !source &&
          latest.current.wrap &&
          a &&
          b &&
          !collapsedLongLine(merge.a, a.from, a.to) &&
          !collapsedLongLine(merge.b, b.from, b.to) &&
          a.to - a.from === b.to - b.from &&
          merge.a.state.doc.sliceString(a.from, a.to) ===
            merge.b.state.doc.sliceString(b.from, b.to)
        )
          reach(a.to - 1, b.to - 1, true, 1, finish);
        else finish();
      };
      const interruptNavigation = () => {
        navigationGeneration++;
        cancelAnimationFrame(navigationFrame);
        navigationActive = false;
      };
      for (const event of ["wheel", "pointerdown", "keydown"])
        element.addEventListener(event, interruptNavigation, true);
      stopSharing = synchronizeDiffLines(
        merge,
        (fromA, fromB) => {
          if (navigationActive || disposed) return false;
          navigate(fromA, fromB);
          return true;
        },
        () => !navigationActive && !disposed,
      );
      const stopProvider = stopSharing;
      stopSharing = () => {
        stopProvider();
        for (const event of ["wheel", "pointerdown", "keydown"])
          element.removeEventListener(event, interruptNavigation, true);
      };
      const state: RepairDiffEditorState = {
        chunkCount: merge.chunks.length,
        activeChunk: -1,
        differenceCount: count,
        activeDifference: -1,
        contextExpanded: latest.current.showFull,
        navigationKind: exactChanges ? "change" : "chunk",
        precise:
          exactChanges !== null || merge.chunks.every((chunk) => chunk.precise),
        ...repairDiffLineCounts(
          merge.chunks,
          merge.a.state.doc,
          merge.b.state.doc,
        ),
      };
      current.current = {
        merge,
        exactChanges,
        state,
        themeA,
        themeB,
        wrapA,
        wrapB,
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
      if (count) selectDifference(0);
      else publish(state);
      scheduleControls();
    } catch (error) {
      stopSharing?.();
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
      disposed = true;
      cancelAnimationFrame(animation);
      cancelAnimationFrame(navigationFrame);
      navigationGeneration++;
      observer?.disconnect();
      resize?.disconnect();
      stopSharing?.();
      current.current = null;
      merge?.destroy();
      element.replaceChildren();
    };
  }, [stage, publish, selectDifference]);

  useLayoutEffect(() => {
    const instance = current.current;
    if (!instance) return;
    const {
      merge,
      themeA,
      themeB,
      wrapA,
      wrapB,
      ariaA,
      ariaB,
      localeA,
      localeB,
    } = instance;
    merge.a.dispatch({
      effects: [
        themeA.reconfigure(colorModes[theme]),
        wrapA.reconfigure(wrap ? EditorView.lineWrapping : []),
        ariaA.reconfigure(editorAttributes("a")),
        localeA.reconfigure(searchPanelLanguage.of(language)),
      ],
    });
    merge.b.dispatch({
      effects: [
        themeB.reconfigure(colorModes[theme]),
        wrapB.reconfigure(wrap ? EditorView.lineWrapping : []),
        ariaB.reconfigure(editorAttributes("b")),
        localeB.reconfigure(searchPanelLanguage.of(language)),
      ],
    });
    instance.scheduleControls();
  }, [theme, language, wrap, stage]);

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
    if (!request) return;
    if (request.changeId) selectChange(request.changeId);
    else if (request.index !== undefined) selectDifference(request.index);
  }, [request, stage, selectChange, selectDifference]);

  return (
    <div
      ref={host}
      className="repair-diff-editor json-editor"
      data-testid="repair-diff-editor"
    />
  );
});
