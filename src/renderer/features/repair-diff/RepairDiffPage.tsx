import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  FileDiff,
  LoaderCircle,
  CircleAlert,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { RepairRecordStage } from "./repair-records";
import {
  RepairDiffEditor,
  type RepairDiffEditorHandle,
  type RepairDiffEditorState,
} from "./RepairDiffEditor";
import { Select } from "../../components/Select";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "./repair-diff-page.css";

export interface RepairDiffSnapshot {
  documentId: string;
  name: string;
  filePath?: string;
  extractionPath?: string;
  revision: number;
  stages: readonly RepairRecordStage[];
  initialStageId?: string;
  initialChangeId?: string;
  key: number;
}

interface Props {
  snapshot: RepairDiffSnapshot;
  hidden?: boolean;
  onClose: () => void;
}

export function RepairDiffPage({ snapshot, hidden, onClose }: Props) {
  const { t, language } = useI18n();
  const editor = useRef<RepairDiffEditorHandle>(null);
  useEffect(() => {
    if (hidden) return;
    const frame = requestAnimationFrame(() => editor.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [hidden]);
  const number = useMemo(() => new Intl.NumberFormat(language), [language]);
  const [stageIndex, setStageIndex] = useState(() =>
    Math.max(
      0,
      snapshot.stages.findIndex(
        (stage) => stage.id === snapshot.initialStageId,
      ),
    ),
  );
  const [fullStages, setFullStages] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<RepairDiffEditorState>();
  const sequence = useRef(0);
  const [request, setRequest] = useState<{
    index?: number;
    changeId?: string;
    key: number;
  }>(() => ({ index: 0, changeId: snapshot.initialChangeId, key: 0 }));
  const stage = snapshot.stages[stageIndex];
  const activeStage = useRef(stage?.id);
  activeStage.current = stage?.id;
  const stageId = stage?.id;
  const onEditorState = useCallback(
    (next: RepairDiffEditorState) => {
      if (activeStage.current === stageId) setState(next);
    },
    [stageId],
  );
  const showFull = stage ? Boolean(fullStages[stage.id]) : false;
  const contextExpanded = showFull || Boolean(state?.contextExpanded);
  const count = state?.differenceCount ?? 0;
  const active = state?.activeDifference ?? -1;
  const loading = !state;

  function stageLabel(value: RepairRecordStage, index: number) {
    const origin = value.origin === "source" ? t("源 JSON") : t("提取值");
    const base = snapshot.extractionPath ?? "$";
    const path =
      value.origin === "source"
        ? value.path
        : value.path?.startsWith("$")
          ? base + value.path.slice(1)
          : (value.path ?? snapshot.extractionPath);
    const target = path ? `${origin} · ${path}` : origin;
    const layer =
      value.layer > 0
        ? t("解码 {{count}} 层后的文本", { count: value.layer })
        : t("原始文本");
    return `${number.format(index + 1)}. ${target} · ${layer}`;
  }

  function chooseStage(index: number, edge = 0) {
    if (index !== stageIndex) {
      setState(undefined);
      setStageIndex(index);
    }
    setRequest({ index: edge, key: ++sequence.current });
  }

  function move(direction: -1 | 1) {
    if (loading) return;
    const next = active + direction;
    if (count > 0 && next >= 0 && next < count) {
      setRequest({ index: next, key: ++sequence.current });
    } else if (direction < 0 && stageIndex > 0) {
      chooseStage(stageIndex - 1, -1);
    } else if (direction > 0 && stageIndex + 1 < snapshot.stages.length) {
      chooseStage(stageIndex + 1);
    }
  }

  return (
    <main
      className="repair-diff-page"
      data-testid="repair-diff-page"
      data-origin={stage?.origin}
      hidden={hidden}
      aria-label={t("修复差异页面")}
    >
      <header className="repair-diff-page-header">
        <button
          className="button ghost"
          data-testid="diff-back"
          onClick={onClose}
        >
          <ArrowLeft size={15} />
          {t("返回工作区")}
        </button>
        <div className="repair-diff-page-title">
          <h1>
            <FileDiff size={19} />
            {t("修复差异")}
          </h1>
          <p>{t("左侧为修复前，右侧为修复后；默认仅显示改动附近的内容。")}</p>
        </div>
        <span className="repair-diff-file-count">
          {t("{{current}} / {{total}} 份对比内容", {
            current: number.format(stageIndex + 1),
            total: number.format(snapshot.stages.length),
          })}
        </span>
      </header>

      <div className="repair-diff-page-toolbar">
        <div className="repair-diff-stage-picker">
          <label htmlFor="diff-stage-select">{t("对比内容")}</label>
          <Select
            id="diff-stage-select"
            label={t("对比内容")}
            value={stageId ?? ""}
            options={snapshot.stages.map((value, index) => ({
              value: value.id,
              label: stageLabel(value, index),
            }))}
            onChange={(id) => {
              const index = snapshot.stages.findIndex(
                (value) => value.id === id,
              );
              if (index >= 0) chooseStage(index);
            }}
          />
        </div>
        <div className="repair-diff-navigation">
          <span
            data-testid="diff-position"
            data-kind={state?.navigationKind ?? "change"}
            className="repair-diff-position"
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
                {t(state.navigationKind === "chunk" ? "差异块" : "修改位置")}{" "}
                <strong>
                  {number.format(active >= 0 ? active + 1 : 0)} /{" "}
                  {number.format(count)}
                </strong>
              </>
            )}
          </span>
          <button
            className="button"
            data-testid="diff-previous"
            title={t("上一处差异")}
            aria-label={t("上一处差异")}
            disabled={loading || (stageIndex === 0 && active <= 0)}
            onClick={() => move(-1)}
          >
            <ArrowUp size={15} />
          </button>
          <button
            className="button"
            data-testid="diff-next"
            title={t("下一处差异")}
            aria-label={t("下一处差异")}
            disabled={
              loading ||
              (stageIndex === snapshot.stages.length - 1 &&
                (count === 0 || active >= count - 1))
            }
            onClick={() => move(1)}
          >
            <ArrowDown size={15} />
          </button>
        </div>
        <button
          className="button"
          data-testid="diff-full-file"
          aria-pressed={contextExpanded}
          onClick={() => {
            if (!stage) return;
            if (contextExpanded) {
              setFullStages((previous) => ({
                ...previous,
                [stage.id]: false,
              }));
              if (!showFull) editor.current?.showDifferences();
            } else {
              setFullStages((previous) => ({
                ...previous,
                [stage.id]: true,
              }));
            }
          }}
        >
          {contextExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          {t(contextExpanded ? "仅显示差异" : "显示完整文件")}
        </button>
      </div>

      {stage &&
        (stage.diffTruncated || state?.precise === false || state?.error) && (
          <div
            className="repair-diff-notice"
            data-testid="diff-notice"
            role={state?.error ? "alert" : "status"}
          >
            <CircleAlert size={14} />
            <div>
              {state?.error ? (
                <p>{localizeMessage(state.error)}</p>
              ) : (
                <>
                  {stage.diffTruncated && (
                    <p>
                      {t(
                        "原始字符改动未完整统计，当前按差异块浏览，可展开全文核对。",
                      )}
                    </p>
                  )}
                  {state?.precise === false && (
                    <p>
                      {t(
                        "文件较大或差异较复杂，当前显示近似差异，请展开全文核对。",
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

      {snapshot.extractionPath && stage?.origin === "extracted" && (
        <p className="repair-diff-source-path">
          {t("提取自 {{path}}", { path: snapshot.extractionPath })}
        </p>
      )}
      <div className="repair-diff-file">
        <div className="repair-diff-file-header">
          <span>
            <span className="repair-diff-minus">−</span>
            {t("修复前")}
            {state && (
              <small className="repair-diff-minus">
                −{state.precise ? "" : "≈"}
                {number.format(state.removedLines)}
              </small>
            )}
          </span>
          <span>
            <span className="repair-diff-plus">+</span>
            {t("修复后")}
            {state && (
              <small className="repair-diff-plus">
                +{state.precise ? "" : "≈"}
                {number.format(state.addedLines)}
              </small>
            )}
          </span>
        </div>
        <div className="repair-diff-file-body">
          {stage ? (
            <RepairDiffEditor
              ref={editor}
              key={stage.id}
              stage={stage}
              showFull={showFull}
              request={request}
              onStateChange={onEditorState}
            />
          ) : (
            <p className="repair-diff-empty">
              {t("当前没有可查看的修复差异。")}
            </p>
          )}
        </div>
      </div>
      <p className="repair-diff-page-note">
        {t("红色表示删除，绿色表示新增；点击隐藏行可展开相邻内容。")}
      </p>
    </main>
  );
}
