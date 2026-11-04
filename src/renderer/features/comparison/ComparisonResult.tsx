import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CircleAlert,
  FileDiff,
  LoaderCircle,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { RepairStage } from "../../../shared/types";
import {
  RepairDiffEditor,
  type RepairDiffEditorHandle,
  type RepairDiffEditorState,
} from "../repair-diff/RepairDiffEditor";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "../repair-diff/repair-diff-page.css";
import "./comparison-result.css";

interface Props {
  result: { left: string; right: string };
  wrap: boolean;
  onBack: () => void;
}

export function ComparisonResult({ result, wrap, onBack }: Props) {
  const { t, language } = useI18n();
  const editor = useRef<RepairDiffEditorHandle>(null);
  const sequence = useRef(0);
  const [state, setState] = useState<RepairDiffEditorState>();
  const [showFull, setShowFull] = useState(false);
  const [request, setRequest] = useState({ index: 0, key: 0 });
  const stage = useMemo<RepairStage>(
    () => ({
      id: "json-comparison",
      layer: 0,
      before: result.left,
      after: result.right,
      changes: [],
      diffTruncated: false,
    }),
    [result.left, result.right],
  );
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const loading = !state;
  const count = state?.differenceCount ?? 0;
  const active = state?.activeDifference ?? -1;
  const contextExpanded = showFull || Boolean(state?.contextExpanded);

  useEffect(() => {
    const frame = requestAnimationFrame(() => editor.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <section
      className="comparison-result repair-diff-page"
      data-testid="comparison-result"
      aria-label={t("JSON 对比结果")}
    >
      <header className="repair-diff-page-header">
        <button
          className="button ghost"
          data-testid="comparison-back"
          onClick={onBack}
        >
          <ArrowLeft size={15} />
          {t("返回编辑")}
        </button>
        <div className="repair-diff-page-title">
          <h1>
            <FileDiff size={19} />
            {t("JSON 对比结果")}
          </h1>
          <p>
            {t("第二份 JSON 已按第一份的 Key 顺序对齐，数组项顺序保持不变。")}
          </p>
        </div>
      </header>

      <div className="repair-diff-page-toolbar">
        <span className="comparison-result-context">
          {t("默认仅显示差异附近的内容。")}
        </span>
        <div className="repair-diff-navigation">
          <span
            className="repair-diff-position"
            data-testid="comparison-position"
            role="status"
            aria-live="polite"
          >
            {loading ? (
              <>
                <LoaderCircle size={12} className="spin" />
                {t("正在计算差异…")}
              </>
            ) : (
              <>
                {t("差异块")}{" "}
                <strong>
                  {number.format(active >= 0 ? active + 1 : 0)} /{" "}
                  {number.format(count)}
                </strong>
              </>
            )}
          </span>
          <button
            className="button"
            data-testid="comparison-previous"
            aria-label={t("上一处差异")}
            title={t("上一处差异")}
            disabled={loading || active <= 0}
            onClick={() =>
              setRequest({ index: active - 1, key: ++sequence.current })
            }
          >
            <ArrowUp size={15} />
          </button>
          <button
            className="button"
            data-testid="comparison-next"
            aria-label={t("下一处差异")}
            title={t("下一处差异")}
            disabled={loading || count === 0 || active >= count - 1}
            onClick={() =>
              setRequest({ index: active + 1, key: ++sequence.current })
            }
          >
            <ArrowDown size={15} />
          </button>
        </div>
        <button
          className="button"
          data-testid="comparison-full-file"
          aria-pressed={contextExpanded}
          disabled={loading || Boolean(state?.error)}
          onClick={() => {
            if (contextExpanded) {
              setShowFull(false);
              if (!showFull) editor.current?.showDifferences();
            } else setShowFull(true);
          }}
        >
          {contextExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          {t(contextExpanded ? "仅显示差异" : "显示完整文件")}
        </button>
      </div>

      {state?.error || state?.precise === false ? (
        <div
          className="repair-diff-notice"
          data-testid="comparison-notice"
          role={state.error ? "alert" : "status"}
        >
          <CircleAlert size={14} />
          <p>
            {state.error
              ? localizeMessage(state.error)
              : t("文件较大或差异较复杂，当前显示近似差异，请展开全文核对。")}
          </p>
        </div>
      ) : state && count === 0 ? (
        <div
          className="comparison-result-identical"
          data-testid="comparison-identical"
          role="status"
        >
          <Check size={15} />
          {t("格式化并对齐 Key 后，两份 JSON 完全一致。")}
        </div>
      ) : null}

      <div className="repair-diff-file">
        <div className="repair-diff-file-header">
          <span>
            <span className="repair-diff-minus">−</span>
            {t("第一份 JSON · 基准")}
            {state && (
              <small className="repair-diff-minus">
                −{state.precise ? "" : "≈"}
                {number.format(state.removedLines)}
              </small>
            )}
          </span>
          <span>
            <span className="repair-diff-plus">+</span>
            {t("第二份 JSON · 已对齐")}
            {state && (
              <small className="repair-diff-plus">
                +{state.precise ? "" : "≈"}
                {number.format(state.addedLines)}
              </small>
            )}
          </span>
        </div>
        <div className="repair-diff-file-body">
          <RepairDiffEditor
            ref={editor}
            stage={stage}
            showFull={showFull}
            wrap={wrap}
            request={request}
            labels={{
              before: t("第一份 JSON 差异编辑器"),
              after: t("第二份 JSON 差异编辑器"),
            }}
            onStateChange={setState}
          />
        </div>
      </div>
      <p className="repair-diff-page-note">
        {t("红色表示删除，绿色表示新增；点击隐藏行可展开相邻内容。")}
      </p>
    </section>
  );
}
