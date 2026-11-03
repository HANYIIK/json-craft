import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json } from "./json-language";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useResolvedTheme } from "../../theme/theme";
import { jsonSearch, searchPanelLanguage } from "./search-panel";
import { translate, useI18n } from "../../i18n/i18n";
import { getJsonAncestors, type JsonAncestor } from "./json-context";
import { completeJsonFolding } from "./json-folding";
import {
  jsonFoldPlaceholder,
  localizeFoldPlaceholder,
} from "./json-fold-placeholder";
import "./json-editor.css";

const searchPhraseKeys = {
  Find: "查找",
  Replace: "替换为",
  next: "下一项",
  previous: "上一项",
  all: "全选",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全词匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
  "replaced match on line $": "已替换第 $ 行的匹配项",
  "replaced $ matches": "已替换 $ 处匹配",
  "current match": "当前匹配项",
  "on line": "位于行",
  "Folded lines": "已折叠行",
  "Unfolded lines": "已展开行",
  to: "至",
  "folded code": "已折叠的代码",
  unfold: "展开代码",
  "Fold line": "折叠此行",
  "Unfold line": "展开此行",
  "Selection deleted": "已删除选中内容",
  "Control character": "控制字符",
};

const searchPhrases = EditorState.phrases.of(
  Object.defineProperties(
    {} as Record<string, string>,
    Object.fromEntries(
      Object.entries(searchPhraseKeys).map(([phrase, key]) => [
        phrase,
        { enumerable: true, get: () => translate(key) },
      ]),
    ),
  ),
);

function localizeNativeControls(view: EditorView) {
  for (const marker of view.dom.querySelectorAll<HTMLElement>(
    ".cm-foldGutter .cm-gutterElement > span",
  ))
    marker.title = view.state.phrase(
      marker.textContent === "⌄" ? "Fold line" : "Unfold line",
    );
  for (const placeholder of view.dom.querySelectorAll<HTMLElement>(
    ".cm-foldPlaceholder",
  )) {
    localizeFoldPlaceholder(placeholder, view);
  }
  for (const dialog of view.dom.querySelectorAll<HTMLElement>(
    ".cm-goto-line",
  )) {
    const label = dialog.querySelector("label");
    if (label?.firstChild?.nodeType === Node.TEXT_NODE)
      label.firstChild.nodeValue = `${view.state.phrase("Go to line")}: `;
    const submit = dialog.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (submit) submit.textContent = view.state.phrase("go");
    dialog
      .querySelector(".cm-dialog-close")
      ?.setAttribute("aria-label", view.state.phrase("close"));
  }
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    background: "var(--editor-bg)",
    color: "var(--editor-text)",
  },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", "PingFang SC", monospace',
    lineHeight: "1.9",
    overflow: "auto",
    overscrollBehaviorY: "contain",
    scrollbarWidth: "thin",
    scrollbarColor: "var(--scrollbar) transparent",
  },
  ".cm-content": {
    padding: "15px 0",
    minHeight: "100%",
    caretColor: "var(--editor-cursor)",
  },
  ".cm-line": { padding: "0 8px 0 3px" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-gutter)",
    border: "none",
    paddingLeft: "7px",
  },
  ".cm-gutterElement": { paddingLeft: "4px", minWidth: "24px" },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--editor-cursor) 7%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--editor-active-line)",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--editor-selection) !important" },
  ".cm-cursor": { borderLeftColor: "var(--editor-cursor)" },
  ".cm-foldPlaceholder": {
    background: "var(--editor-fold-bg)",
    color: "var(--editor-fold-text)",
    border: "1px solid var(--editor-fold-border)",
    borderRadius: "3px",
  },
  ".cm-foldPlaceholder[data-array-items]": {
    padding: "0 5px",
    whiteSpace: "nowrap",
  },
  ".cm-panels": {
    background: "var(--bg-subtle)",
    color: "var(--text-primary)",
  },
  ".cm-searchMatch": {
    background: "var(--search-match)",
    outline: "1px solid var(--search-match-border)",
  },
  ".cm-searchMatch-selected": { background: "var(--search-match-selected)" },
  ".cm-placeholder": { color: "var(--text-muted)" },
  ".cm-textfield, .cm-button": {
    background: "var(--bg-input)",
    backgroundImage: "none",
    color: "var(--text-primary)",
    borderColor: "var(--border-strong)",
  },
  ".cm-dialog": { color: "var(--text-primary)" },
});

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

export interface EditorSelection {
  from: number;
  to: number;
  key: number;
}

interface Props {
  value: string;
  label: string;
  readOnly?: boolean;
  wrap: boolean;
  selection?: EditorSelection;
  onChange?: (value: string) => void;
}

export function JsonEditor({
  value,
  label,
  readOnly = false,
  wrap,
  selection,
  onChange,
}: Props) {
  const { t, language } = useI18n();
  const ref = useRef<ReactCodeMirrorRef>(null);
  const resolvedTheme = useResolvedTheme();
  const [editorReady, setEditorReady] = useState(false);
  const [ancestors, setAncestors] = useState<JsonAncestor[]>([
    { label: "$", path: "$", from: 0, to: 0 },
  ]);
  const breadcrumbRef = useRef<HTMLElement>(null);
  const contextDocument = useRef<EditorState["doc"] | null>(null);
  const viewportAnchor = useRef<{
    doc: EditorState["doc"];
    position: number;
  } | null>(null);
  const refreshContext = useRef<(() => void) | undefined>(undefined);
  const onEditorUpdate = useCallback((update: ViewUpdate) => {
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      syntaxTree(update.state) !== syntaxTree(update.startState)
    )
      refreshContext.current?.();
  }, []);
  const basicSetup = useMemo(
    () => ({
      highlightActiveLine: !readOnly,
      highlightActiveLineGutter: !readOnly,
      autocompletion: false,
      foldGutter: true,
    }),
    [readOnly],
  );
  const extensions = useMemo(
    () => [
      json(),
      completeJsonFolding,
      jsonFoldPlaceholder,
      jsonSearch,
      searchPhrases,
      searchPanelLanguage.of(language),
      colorModes[resolvedTheme],
      editorTheme,
      highlight,
      EditorView.contentAttributes.of({
        "aria-label": label,
        "aria-readonly": String(readOnly),
        ...(readOnly ? { tabindex: "0" } : {}),
        spellcheck: "false",
      }),
      ...(wrap ? [EditorView.lineWrapping] : []),
    ],
    [label, readOnly, wrap, resolvedTheme, language],
  );

  useEffect(() => {
    const view = ref.current?.view;
    if (view) localizeNativeControls(view);
  }, [language, editorReady]);

  const selectionFrom = selection?.from;
  const selectionTo = selection?.to;
  const selectionKey = selection?.key;
  useEffect(() => {
    const view = ref.current?.view;
    if (!view || selectionFrom === undefined || selectionTo === undefined)
      return;
    const from = Math.min(selectionFrom, view.state.doc.length);
    const to = Math.min(Math.max(from, selectionTo), view.state.doc.length);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }, [selectionFrom, selectionTo, selectionKey, editorReady]);

  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    let width = 0;
    let frame = 0;
    let pendingAnchor: typeof viewportAnchor.current = null;
    const measure = () => {
      pendingAnchor ??= viewportAnchor.current;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchor = pendingAnchor;
        pendingAnchor = null;
        const nextWidth = view.scrollDOM.clientWidth;
        if (!nextWidth || !view.scrollDOM.clientHeight) return;
        if (view.compositionStarted) return;
        if (
          width &&
          nextWidth !== width &&
          wrap &&
          anchor?.doc === view.state.doc
        )
          view.dispatch({
            effects: EditorView.scrollIntoView(anchor.position, {
              y: "start",
              yMargin: 0,
            }),
          });
        width = nextWidth;
        view.requestMeasure();
        refreshContext.current?.();
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(view.dom);
    view.dom.addEventListener("compositionend", measure);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      view.dom.removeEventListener("compositionend", measure);
    };
  }, [editorReady, wrap]);

  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    let alive = true;
    let frame = 0;
    const key = {};
    const schedule = () => {
      if (frame || !alive) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!alive) return;
        view.requestMeasure({
          key,
          read: () => {
            const bounds = view.scrollDOM.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return null;
            const content = view.contentDOM.getBoundingClientRect();
            const gutter = view.scrollDOM
              .querySelector(".cm-gutters")
              ?.getBoundingClientRect();
            const x = Math.min(
              bounds.right - 2,
              Math.max(
                bounds.left + 2,
                content.left + 2,
                gutter ? gutter.right + 2 : 0,
              ),
            );
            const position = view.posAtCoords(
              { x, y: bounds.top + Math.min(4, bounds.height / 2) },
              false,
            );
            return {
              doc: view.state.doc,
              position,
              ancestors: getJsonAncestors(view.state, position),
            };
          },
          write: (context) => {
            if (!alive || !context || context.doc !== view.state.doc) return;
            contextDocument.current = context.doc;
            viewportAnchor.current = {
              doc: context.doc,
              position: context.position,
            };
            setAncestors((previous) =>
              previous.length === context.ancestors.length &&
              previous.every((item, index) => {
                const next = context.ancestors[index];
                return (
                  item.path === next.path &&
                  item.label === next.label &&
                  item.from === next.from &&
                  item.to === next.to
                );
              })
                ? previous
                : context.ancestors,
            );
          },
        });
      });
    };
    refreshContext.current = schedule;
    view.scrollDOM.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener("scroll", schedule);
      if (refreshContext.current === schedule)
        refreshContext.current = undefined;
    };
  }, [editorReady]);

  useLayoutEffect(() => {
    const element = breadcrumbRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [ancestors]);

  const jumpToAncestor = (ancestor: JsonAncestor) => {
    const view = ref.current?.view;
    if (!view) return;
    if (contextDocument.current !== view.state.doc) {
      refreshContext.current?.();
      return;
    }
    view.dispatch({
      selection: { anchor: ancestor.from, head: ancestor.to },
      effects: EditorView.scrollIntoView(ancestor.from, {
        y: "start",
        yMargin: 8,
        x: "start",
        xMargin: 8,
      }),
      userEvent: "select.json-parent",
    });
    view.focus();
  };

  return (
    <div className="json-editor">
      <nav
        ref={breadcrumbRef}
        className="json-breadcrumbs"
        aria-label={t("{{label}} 父级路径", { label })}
      >
        {ancestors.map((ancestor, index) => (
          <span
            className="json-breadcrumb"
            key={`${ancestor.from}:${ancestor.path}`}
          >
            {index > 0 && (
              <span className="json-breadcrumb-separator" aria-hidden="true">
                ›
              </span>
            )}
            <button
              type="button"
              data-path={ancestor.path}
              aria-label={t("跳转到 {{path}}", { path: ancestor.path })}
              title={ancestor.path}
              onClick={() => jumpToAncestor(ancestor)}
            >
              {ancestor.label || '""'}
            </button>
          </span>
        ))}
      </nav>
      <CodeMirror
        ref={ref}
        className="json-editor-code"
        value={value}
        height="100%"
        theme="none"
        readOnly={readOnly}
        editable={!readOnly}
        extensions={extensions}
        basicSetup={basicSetup}
        onCreateEditor={() => setEditorReady(true)}
        onChange={onChange}
        onUpdate={onEditorUpdate}
        placeholder={t("粘贴压缩 JSON、转义字符串，或导入 .json 文件…")}
        indentWithTab={false}
      />
    </div>
  );
}
