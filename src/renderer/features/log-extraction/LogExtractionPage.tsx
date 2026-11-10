import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  Eraser,
  FileJson2,
  ListFilter,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoveRight,
  TextSearch,
  TextWrap,
  X,
} from "lucide-react";
import type {
  LogExtractionResult,
  LogJsonCandidate,
} from "../../../core/json/log-extract";
import {
  defaultOptions,
  MAX_FILE_BYTES,
  type FormatOptions,
} from "../../../shared/types";
import { CopyButton } from "../../components/CopyButton";
import { Select } from "../../components/Select";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import { FormatClient } from "../../services/format-client";
import { JsonEditor, type EditorSelection } from "../editor/JsonEditor";
import "./log-extraction-page.css";

export interface LogExtractionPageHandle {
  extract(): void;
  collapsePreview(): void;
}

interface Props {
  hidden: boolean;
  recursiveUnescape: boolean;
  onRecursiveChange: (enabled: boolean) => void;
  wrap: boolean;
  onWrapChange: () => void;
  onClose: () => void;
  onPreviewExpandedChange: (expanded: boolean) => void;
  onMigrate: (
    items: LogJsonCandidate[],
    options: FormatOptions,
  ) => Promise<void>;
}

interface CompletedExtraction {
  source: string;
  signature: string;
  version: number;
  result: LogExtractionResult;
}

export const LogExtractionPage = forwardRef<LogExtractionPageHandle, Props>(
  function LogExtractionPage(
    {
      hidden,
      recursiveUnescape,
      onRecursiveChange,
      wrap,
      onWrapChange,
      onClose,
      onPreviewExpandedChange,
      onMigrate,
    },
    ref,
  ) {
    const { t, language } = useI18n();
    const number = useMemo(() => new Intl.NumberFormat(language), [language]);
    const client = useMemo(() => new FormatClient(), []);
    const tabId = useId();
    const [source, setSource] = useState("");
    const [options, setOptions] = useState<FormatOptions>(defaultOptions);
    const [requested, setRequested] = useState(false);
    const [version, setVersion] = useState(0);
    const [completed, setCompleted] = useState<CompletedExtraction>();
    const [activeId, setActiveId] = useState<string>();
    const [closed, setClosed] = useState<
      Map<string, { start: number; end: number }>
    >(new Map());
    const [migrated, setMigrated] = useState<Set<string>>(new Set());
    const [pending, setPending] = useState(false);
    const [migrating, setMigrating] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [error, setError] = useState("");
    const [noticeCount, setNoticeCount] = useState(0);
    const [selection, setSelection] = useState<EditorSelection>();
    const operation = useRef(0);
    const selectionSequence = useRef(0);
    const migrationPending = useRef(false);
    const resultTabs = useRef<HTMLDivElement>(null);
    const extractButton = useRef<HTMLButtonElement>(null);
    const previewExpandButton = useRef<HTMLButtonElement>(null);
    const previewBackButton = useRef<HTMLButtonElement>(null);
    const wasExpanded = useRef(false);
    const completedRef = useRef(completed);
    completedRef.current = completed;
    const signature = `${options.indent}:${options.autoUnescape}:${options.repair}:${recursiveUnescape}`;
    const fresh =
      completed?.source === source &&
      completed.signature === signature &&
      completed.version === version;
    const items = completed?.result.items ?? [];
    const closedRanges = [...closed.values()];
    const openItems = items.filter(
      (item) =>
        !closedRanges.some(
          (range) => range.start <= item.start && range.end >= item.end,
        ),
    );
    const active =
      openItems.find((item) => item.id === activeId) ?? openItems[0];
    const available = openItems.filter(
      (item) => item.result.success && !migrated.has(item.id),
    );
    const blocked = pending || migrating || !fresh;

    useEffect(() => {
      if (hidden) return;
      resultTabs.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [active?.id, expanded, hidden, version]);

    useEffect(() => {
      const strip = resultTabs.current;
      if (!strip || hidden) return;
      const scroll = (event: WheelEvent) => {
        if (
          Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
          strip.scrollWidth <= strip.clientWidth
        )
          return;
        const delta =
          event.deltaY *
          (event.deltaMode === 1
            ? 24
            : event.deltaMode === 2
              ? strip.clientWidth
              : 1);
        const next = Math.max(
          0,
          Math.min(
            strip.scrollLeft + delta,
            strip.scrollWidth - strip.clientWidth,
          ),
        );
        if (next === strip.scrollLeft) return;
        event.preventDefault();
        strip.scrollLeft = next;
      };
      strip.addEventListener("wheel", scroll, { passive: false });
      return () => strip.removeEventListener("wheel", scroll);
    }, [hidden, openItems.length]);

    useEffect(() => {
      if (hidden || !requested || migrating) return;
      const previous = completedRef.current;
      if (
        previous?.source === source &&
        previous.signature === signature &&
        previous.version === version
      )
        return;
      const job = ++operation.current;
      setPending(true);
      setError("");
      setNoticeCount(0);
      const timer = setTimeout(async () => {
        try {
          if (new Blob([source]).size > MAX_FILE_BYTES)
            throw new Error("日志超过 20 MiB，请缩小后重试。");
          const result = await client.extractLog(
            source,
            options,
            recursiveUnescape,
          );
          if (job !== operation.current) return;
          if (result.error) throw new Error(result.error);
          const sameBatch =
            previous?.source === source && previous.version === version;
          const previousItems = new Map(
            sameBatch
              ? previous.result.items.map((item) => [item.id, item])
              : [],
          );
          const nextItems = result.items.map((item) => {
            const before = previousItems.get(item.id);
            return before &&
              before.raw === item.raw &&
              before.result.output === item.result.output
              ? before
              : item;
          });
          setCompleted({
            source,
            signature,
            version,
            result: { ...result, items: nextItems },
          });
          const visibleNext = nextItems.filter(
            (item) =>
              !closedRanges.some(
                (range) => range.start <= item.start && range.end >= item.end,
              ),
          );
          setActiveId((current) =>
            sameBatch && visibleNext.some((item) => item.id === current)
              ? current
              : visibleNext[0]?.id,
          );
          setMigrated(
            (current) =>
              new Set(
                nextItems
                  .filter(
                    (item) =>
                      current.has(item.id) &&
                      previousItems.get(item.id) === item,
                  )
                  .map((item) => item.id),
              ),
          );
        } catch (error) {
          if (job === operation.current)
            setError(error instanceof Error ? error.message : String(error));
        } finally {
          if (job === operation.current) setPending(false);
        }
      }, 180);
      return () => {
        operation.current++;
        clearTimeout(timer);
        client.cancel();
      };
    }, [
      client,
      hidden,
      options,
      migrating,
      recursiveUnescape,
      requested,
      signature,
      source,
      version,
    ]);

    useEffect(
      () => () => {
        operation.current++;
        client.dispose();
      },
      [client],
    );

    useEffect(() => {
      const previous = wasExpanded.current;
      wasExpanded.current = expanded;
      if (hidden || (!expanded && !previous)) return;
      const frame = requestAnimationFrame(() =>
        (expanded ? previewBackButton : previewExpandButton).current?.focus(),
      );
      return () => cancelAnimationFrame(frame);
    }, [expanded, hidden]);

    function extract() {
      if (hidden || !source.trim() || migrating) return;
      setExpanded(false);
      setClosed(new Map());
      setMigrated(new Set());
      setActiveId(undefined);
      setRequested(true);
      setVersion((value) => value + 1);
    }

    useImperativeHandle(ref, () => ({
      extract,
      collapsePreview: () => setExpanded(false),
    }));

    useEffect(() => {
      onPreviewExpandedChange(!hidden && expanded);
    }, [hidden, expanded, onPreviewExpandedChange]);

    useEffect(() => {
      if (hidden) return;
      const escape = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.isComposing
        )
          return;
        event.preventDefault();
        if (expanded) setExpanded(false);
        else onClose();
      };
      window.addEventListener("keydown", escape);
      return () => window.removeEventListener("keydown", escape);
    }, [expanded, hidden, onClose]);

    function changeSource(value: string) {
      if (migrationPending.current) return;
      operation.current++;
      client.cancel();
      setSource(value);
      setRequested(false);
      setCompleted(undefined);
      setClosed(new Map());
      setMigrated(new Set());
      setActiveId(undefined);
      setPending(false);
      setExpanded(false);
      setError("");
      setNoticeCount(0);
      setSelection(undefined);
    }

    async function copy(value: string) {
      try {
        if (window.desktop) await window.desktop.copyText(value);
        else await navigator.clipboard.writeText(value);
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    async function migrate(candidates: LogJsonCandidate[]) {
      if (blocked || !candidates.length || migrationPending.current) return;
      migrationPending.current = true;
      setMigrating(true);
      setError("");
      setNoticeCount(0);
      try {
        await onMigrate(candidates, { ...options });
        const ids = new Set(candidates.map((item) => item.id));
        setMigrated((previous) => new Set([...previous, ...ids]));
        setNoticeCount(candidates.length);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        migrationPending.current = false;
        setMigrating(false);
      }
    }

    function locate(item: LogJsonCandidate) {
      setExpanded(false);
      setSelection({
        from: item.start,
        to: item.end,
        key: ++selectionSequence.current,
      });
    }

    function focusTab(id: string | undefined, scroll = true) {
      requestAnimationFrame(() => {
        if (!id) {
          extractButton.current?.focus();
          return;
        }
        const tabs =
          resultTabs.current?.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
          );
        const tab = Array.from(tabs ?? []).find(
          (element) => element.dataset.resultId === id,
        );
        tab?.focus({ preventScroll: true });
        if (scroll)
          tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }

    function closeResult(item: LogJsonCandidate) {
      if (pending || migrationPending.current) return;
      const index = openItems.indexOf(item);
      const remaining = openItems.filter(
        (candidate) => candidate.id !== item.id,
      );
      const next =
        active?.id === item.id
          ? remaining[Math.min(index, remaining.length - 1)]
          : active;
      setClosed((previous) =>
        new Map(previous).set(item.id, { start: item.start, end: item.end }),
      );
      setActiveId(next?.id);
      if (!remaining.length) setExpanded(false);
      focusTab(next?.id, active?.id === item.id);
    }

    const status = pending
      ? t("正在提取 JSON…")
      : completed && fresh
        ? t("提取到 {{count}} 项 JSON", { count: items.length })
        : t("粘贴日志后，点击“提取 JSON”。");

    return (
      <main
        className="log-extraction-page"
        data-testid="log-extraction-page"
        data-preview-expanded={expanded || undefined}
        hidden={hidden}
        aria-label={t("JSON 提取")}
      >
        <header className="log-extraction-header">
          <button
            ref={expanded ? previewBackButton : undefined}
            className="button ghost"
            data-testid={expanded ? "log-preview-back" : "log-extraction-back"}
            onClick={() => (expanded ? setExpanded(false) : onClose())}
          >
            <ArrowLeft size={15} />
            {t(expanded ? "返回提取结果" : "返回工作区")}
          </button>
          <div>
            <h1>{t(expanded ? "JSON 预览" : "JSON 提取")}</h1>
            <p>
              {t(
                "从日志或混合文本中提取 JSON，对象、数组和 JSON 字符串均可识别。",
              )}
            </p>
          </div>
          {!expanded && (
            <button
              ref={extractButton}
              className="button primary"
              data-testid="extract-log-json"
              disabled={!source.trim() || pending || migrating}
              onClick={extract}
            >
              {pending ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <TextSearch size={16} />
              )}
              {t(pending ? "正在提取…" : "提取 JSON")}
              <kbd>
                {window.desktop?.platform === "darwin" ? "⌘" : "Ctrl"} ↵
              </kbd>
            </button>
          )}
        </header>

        <div className="log-extraction-options format-options">
          <label
            className="check-control"
            title={t("去除当前 JSON 外层的字符串包装")}
          >
            <input
              type="checkbox"
              checked={options.autoUnescape}
              disabled={migrating}
              onChange={(event) =>
                setOptions({ ...options, autoUnescape: event.target.checked })
              }
            />
            {t("自动去转义")}
          </label>
          <label
            className="check-control"
            title={t("展开对象字段和列表项中的嵌套 JSON 字符串")}
          >
            <input
              type="checkbox"
              checked={recursiveUnescape}
              disabled={!options.autoUnescape || migrating}
              onChange={(event) => onRecursiveChange(event.target.checked)}
            />
            {t("递归去转义")}
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={options.repair}
              disabled={migrating}
              onChange={(event) =>
                setOptions({ ...options, repair: event.target.checked })
              }
            />
            {t("尝试修复")}
          </label>
          <div className="indent-label">
            {t("缩进")}
            <Select
              label={t("JSON 缩进")}
              size="compact"
              value={options.indent}
              disabled={migrating}
              options={[
                { value: "2", label: t("2 空格") },
                { value: "4", label: t("4 空格") },
                { value: "tab", label: "Tab" },
              ]}
              onChange={(indent) =>
                setOptions({
                  ...options,
                  indent: indent as FormatOptions["indent"],
                })
              }
            />
          </div>
          <button
            className={`icon-button wrap-control ${wrap ? "active" : ""}`}
            aria-label={t("自动换行")}
            title={t("自动换行")}
            aria-pressed={wrap}
            onClick={onWrapChange}
          >
            <TextWrap size={16} />
          </button>
        </div>

        {error && (
          <div className="log-extraction-message error" role="alert">
            <CircleAlert size={14} />
            {localizeMessage(error)}
          </div>
        )}
        {noticeCount > 0 && (
          <div className="log-extraction-message success" role="status">
            <Check size={14} />
            {t("已迁移 {{count}} 项至工作区并自动保存。", {
              count: noticeCount,
            })}
          </div>
        )}
        {completed?.result.truncated && fresh && (
          <div className="log-extraction-message warning" role="status">
            <CircleAlert size={14} />
            {t("内容较多，已达到单次提取上限。请分段提取剩余日志。")}
          </div>
        )}

        <div className="log-extraction-body">
          <section
            className="editor-panel log-source-panel"
            aria-label={t("原始日志")}
          >
            <header className="editor-header">
              <h2>
                <span className="editor-index">LOG</span>
                {t("原始日志")}
              </h2>
              <button
                className="icon-button"
                aria-label={t("清空日志")}
                title={t("清空日志")}
                disabled={!source || migrating}
                onClick={() => changeSource("")}
              >
                <Eraser size={15} />
              </button>
            </header>
            <div className="editor-body" data-testid="log-input-editor">
              <JsonEditor
                value={source}
                label={t("日志输入编辑器")}
                wrap={wrap}
                readOnly={migrating}
                syntaxHighlighting={false}
                placeholder={t("粘贴包含 JSON 的日志、接口响应或其他文本…")}
                selection={selection}
                onChange={changeSource}
              />
            </div>
            <footer className="editor-footer">
              <span>
                {t("{{total}} 字符", { total: number.format(source.length) })}
              </span>
              <span>{t("日志仅在当前会话保留")}</span>
            </footer>
          </section>

          <section
            className="log-results-panel"
            aria-label={t("提取结果")}
            aria-busy={pending}
          >
            <header className="log-results-header">
              <div className="log-results-title">
                <ListFilter size={15} />
                <h2>{t("提取结果")}</h2>
                <span className="record-count">
                  {number.format(openItems.length)}
                </span>
              </div>
              <span
                className="log-result-summary"
                data-testid="log-extraction-status"
                role="status"
              >
                {pending && <LoaderCircle size={12} className="spin" />}
                {status}
              </span>
            </header>
            <div className="log-results-content">
              {openItems.length > 0 && (
                <div
                  ref={resultTabs}
                  className="log-result-tabs"
                  data-testid="log-result-tabs"
                  data-scrollbar-size="thin"
                  role="tablist"
                  aria-label={t("提取结果标签页")}
                  aria-orientation="horizontal"
                >
                  {openItems.map((item, index) => {
                    const originalIndex = items.indexOf(item) + 1;
                    const isActive = active?.id === item.id;
                    const isMigrated = migrated.has(item.id);
                    return (
                      <div
                        className="log-result-tab"
                        key={item.id}
                        data-result-id={item.id}
                        data-active={isActive || undefined}
                        data-migrated={isMigrated || undefined}
                      >
                        <button
                          className="log-result-select"
                          id={`${tabId}-${item.id}`}
                          data-result-id={item.id}
                          role="tab"
                          aria-controls={`${tabId}-preview`}
                          aria-label={t("预览第 {{index}} 项 JSON", {
                            index: originalIndex,
                          })}
                          aria-selected={isActive}
                          tabIndex={isActive ? 0 : -1}
                          title={`${t("第 {{line}} 行 · 第 {{column}} 列", { line: item.line, column: item.column })}${isMigrated ? ` · ${t("已迁移")}` : ""}`}
                          onClick={() => setActiveId(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Delete") {
                              event.preventDefault();
                              closeResult(item);
                              return;
                            }
                            const destination =
                              event.key === "ArrowRight"
                                ? (index + 1) % openItems.length
                                : event.key === "ArrowLeft"
                                  ? (index - 1 + openItems.length) %
                                    openItems.length
                                  : event.key === "Home"
                                    ? 0
                                    : event.key === "End"
                                      ? openItems.length - 1
                                      : -1;
                            if (destination < 0) return;
                            event.preventDefault();
                            setActiveId(openItems[destination].id);
                            focusTab(openItems[destination].id);
                          }}
                        >
                          <FileJson2 size={14} />
                          <span>JSON {number.format(originalIndex)}</span>
                          {isMigrated && (
                            <Check size={12} className="log-migrated-check" />
                          )}
                        </button>
                        <button
                          className="log-tab-close"
                          aria-label={t("关闭 JSON {{index}}", {
                            index: originalIndex,
                          })}
                          title={t("关闭 JSON {{index}}", {
                            index: originalIndex,
                          })}
                          tabIndex={isActive ? 0 : -1}
                          disabled={pending || migrating}
                          onClick={() => closeResult(item)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <section
                className="editor-panel log-preview-panel"
                id={`${tabId}-preview`}
                role="tabpanel"
                aria-labelledby={active ? `${tabId}-${active.id}` : undefined}
                aria-label={active ? undefined : t("JSON 预览")}
              >
                <header className="editor-header">
                  <h2>
                    {active ? (
                      <span className="log-result-location">
                        {t("第 {{line}} 行 · 第 {{column}} 列", {
                          line: number.format(active.line),
                          column: number.format(active.column),
                        })}
                      </span>
                    ) : (
                      t("JSON 预览")
                    )}
                  </h2>
                  <div className="editor-actions">
                    {active && !expanded && (
                      <button
                        className="button ghost log-locate-source"
                        onClick={() => locate(active)}
                        title={t("定位原文")}
                      >
                        <ArrowUpRight size={13} />
                        {t("定位原文")}
                      </button>
                    )}
                    <button
                      ref={previewExpandButton}
                      className="icon-button"
                      data-testid="log-preview-expand"
                      disabled={!active}
                      title={t(expanded ? "返回提取结果" : "独占查看提取结果")}
                      aria-label={t(
                        expanded ? "返回提取结果" : "独占查看提取结果",
                      )}
                      aria-pressed={expanded}
                      onClick={() => setExpanded((previous) => !previous)}
                    >
                      {expanded ? (
                        <Minimize2 size={15} />
                      ) : (
                        <Maximize2 size={15} />
                      )}
                    </button>
                  </div>
                </header>
                <div className="editor-body" data-testid="log-preview-editor">
                  {active ? (
                    <JsonEditor
                      key={active.id}
                      value={active.result.output}
                      label={t("提取 JSON 预览编辑器")}
                      readOnly
                      wrap={wrap}
                    />
                  ) : (
                    <div className="log-preview-empty">
                      <TextSearch size={28} />
                      <p>
                        {t(
                          items.length
                            ? "结果已全部关闭"
                            : completed && fresh
                              ? "未找到可提取的 JSON"
                              : "提取结果将显示在这里",
                        )}
                      </p>
                      <span>
                        {t(
                          items.length
                            ? "重新提取可恢复全部结果。"
                            : "提取后，通过标签页预览结果；关闭不需要的项，再一键移入工作区。",
                        )}
                      </span>
                    </div>
                  )}
                </div>
                <footer className="editor-footer log-preview-footer">
                  <span>
                    {active
                      ? t("{{total}} 字符", {
                          total: number.format(active.result.output.length),
                        })
                      : ""}
                  </span>
                  {active?.result.changeCount ? (
                    <span className="log-repair-count">
                      {t("已修复 {{count}} 处", {
                        count: active.result.changeCount,
                      })}
                    </span>
                  ) : null}
                  <CopyButton
                    onCopy={() => copy(active?.result.output ?? "")}
                    feedbackKey={active?.result.output}
                    disabled={!active || blocked}
                  />
                </footer>
              </section>
            </div>
            <footer className="log-migrate-footer">
              <span>{t("仅移入未关闭的结果，自动保存至文件存储目录。")}</span>
              <div>
                <button
                  className="button primary"
                  data-testid="log-migrate-all"
                  disabled={blocked || !available.length}
                  onClick={() => void migrate(available)}
                >
                  {migrating ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <MoveRight size={14} />
                  )}
                  {t("移入工作区")}
                  {available.length > 0 &&
                    ` (${number.format(available.length)})`}
                </button>
              </div>
            </footer>
          </section>
        </div>
      </main>
    );
  },
);
