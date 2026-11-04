import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Columns2,
  Eraser,
  FolderOpen,
  LoaderCircle,
  TextWrap,
} from "lucide-react";
import {
  defaultOptions,
  MAX_FILE_BYTES,
  type FormatOptions,
} from "../../../shared/types";
import { FormatClient } from "../../services/format-client";
import { JsonEditor } from "../editor/JsonEditor";
import { CopyButton } from "../../components/CopyButton";
import { Select } from "../../components/Select";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import { ComparisonResult } from "./ComparisonResult";
import { useComparisonInput } from "./use-comparison-input";
import "./comparison-page.css";

export interface ComparisonPageHandle {
  compare(): void;
  importFiles(files: File[], side?: "left" | "right"): void;
}

interface Props {
  hidden: boolean;
  recursiveUnescape: boolean;
  onRecursiveChange: (enabled: boolean) => void;
  wrap: boolean;
  onWrapChange: () => void;
  onClose: () => void;
}

export const ComparisonPage = forwardRef<ComparisonPageHandle, Props>(
  function ComparisonPage(
    {
      hidden,
      recursiveUnescape,
      onRecursiveChange,
      wrap,
      onWrapChange,
      onClose,
    },
    ref,
  ) {
    const { t } = useI18n();
    const client = useMemo(() => new FormatClient(), []);
    const [options, setOptions] = useState<FormatOptions>(defaultOptions);
    const left = useComparisonInput(client, options, recursiveUnescape);
    const right = useComparisonInput(client, options, recursiveUnescape);
    const [result, setResult] = useState<{ left: string; right: string }>();
    const [comparing, setComparing] = useState(false);
    const [error, setError] = useState("");
    const operation = useRef(0);
    const fileInput = useRef<HTMLInputElement>(null);
    const fileSide = useRef<"left" | "right">("left");
    const current = useRef({ left, right, options, recursiveUnescape });
    current.current = { left, right, options, recursiveUnescape };
    const ready = left.valid && right.valid && !comparing;

    useEffect(
      () => () => {
        operation.current++;
        client.dispose();
      },
      [client],
    );

    function back() {
      if (result) setResult(undefined);
      else onClose();
    }

    useEffect(() => {
      if (hidden) return;
      const handleEscape = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.isComposing
        )
          return;
        event.preventDefault();
        back();
      };
      window.addEventListener("keydown", handleEscape);
      return () => window.removeEventListener("keydown", handleEscape);
    });

    async function compare() {
      if (!ready || hidden || result) return;
      const job = ++operation.current;
      const snapshot = current.current;
      setComparing(true);
      setError("");
      try {
        const aligned = await client.alignKeys(
          left.result!.output,
          right.result!.output,
          options.indent,
        );
        if (
          job !== operation.current ||
          snapshot.left.source !== current.current.left.source ||
          snapshot.right.source !== current.current.right.source ||
          snapshot.options !== current.current.options ||
          snapshot.recursiveUnescape !== current.current.recursiveUnescape
        )
          return;
        if (!aligned.success) throw new Error(aligned.error);
        setResult({ left: aligned.left, right: aligned.right });
      } catch (error) {
        if (job === operation.current)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (job === operation.current) setComparing(false);
      }
    }

    async function importFiles(files: File[], side?: "left" | "right") {
      const accepted = files.filter((file) => /\.json$/i.test(file.name));
      if (!accepted.length) {
        setError(t("请选择 .json 文件。"));
        return;
      }
      operation.current++;
      setComparing(false);
      setResult(undefined);
      setError("");
      const targets = side ? [side] : (["left", "right"] as const);
      await Promise.all(
        targets.map(async (target, index) => {
          const file = accepted[index];
          if (!file) return;
          const input = current.current[target];
          const token = input.beginImport();
          try {
            if (file.size > MAX_FILE_BYTES)
              throw new Error(t("文件超过 20 MiB，请缩小后重试。"));
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              await file.arrayBuffer(),
            );
            input.finishImport(token, text, file.name);
          } catch (error) {
            input.failImport(
              token,
              error instanceof TypeError
                ? t("无法读取 UTF-8 文本，请转换文件编码后导入。")
                : error instanceof Error
                  ? error.message
                  : String(error),
            );
          }
        }),
      );
      if (!side && accepted.length > 2)
        setError(t("仅使用前两个 JSON 文件进行对比。"));
    }

    useImperativeHandle(ref, () => ({
      compare: () => void compare(),
      importFiles: (files, side) => void importFiles(files, side),
    }));

    async function copy(text: string) {
      try {
        if (window.desktop) await window.desktop.copyText(text);
        else await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return false;
      }
    }

    return (
      <main
        className="comparison-page"
        data-testid="comparison-page"
        hidden={hidden}
        aria-label={t("JSON 对比")}
      >
        <div className="comparison-inputs" hidden={Boolean(result)}>
          <header className="comparison-header">
            <button className="button ghost" onClick={onClose}>
              <ArrowLeft size={15} />
              {t("返回工作区")}
            </button>
            <div>
              <h1>{t("JSON 对比")}</h1>
              <p>{t("两侧输入自动格式化，对比时按左侧顺序递归对齐 Key。")}</p>
            </div>
            <button
              className="button primary"
              data-testid="compare-json"
              disabled={!ready}
              onClick={() => void compare()}
            >
              {comparing ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Columns2 size={16} />
              )}
              {t(comparing ? "正在对齐…" : "对齐并比较")}
              <kbd>
                {window.desktop?.platform === "darwin" ? "⌘" : "Ctrl"} ↵
              </kbd>
            </button>
          </header>
          <div className="comparison-options format-options">
            <label
              className="check-control"
              title={t("去除当前 JSON 外层的字符串包装")}
            >
              <input
                type="checkbox"
                checked={options.autoUnescape}
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
                disabled={!options.autoUnescape}
                onChange={(event) => onRecursiveChange(event.target.checked)}
              />
              {t("递归去转义")}
            </label>
            <label className="check-control">
              <input
                type="checkbox"
                checked={options.repair}
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
            <div className="comparison-error" role="alert">
              <CircleAlert size={14} />
              {localizeMessage(error)}
            </div>
          )}
          <div className="comparison-editors">
            {(["left", "right"] as const).map((side, index) => {
              const input = side === "left" ? left : right;
              const title = t(
                side === "left" ? "第一份 JSON · 基准" : "第二份 JSON · 待对比",
              );
              const status = input.loading
                ? t("正在读取文件…")
                : input.error
                  ? localizeMessage(input.error)
                  : input.pending
                    ? t("正在自动格式化…")
                    : input.valid
                      ? input.result?.changeCount
                        ? t("已修复 {{count}} 处", {
                            count: input.result.changeCount,
                          })
                        : t("已自动格式化")
                      : t("粘贴 JSON 或导入文件");
              return (
                <section
                  className="editor-panel comparison-pane"
                  data-testid={`comparison-${side}`}
                  key={side}
                  aria-label={title}
                >
                  <header className="editor-header">
                    <h2>
                      <span className="editor-index">0{index + 1}</span>
                      {title}
                    </h2>
                    <div className="editor-actions">
                      <button
                        className="icon-button"
                        title={t("导入文件")}
                        aria-label={t("导入文件")}
                        disabled={comparing}
                        onClick={() => {
                          fileSide.current = side;
                          fileInput.current?.click();
                        }}
                      >
                        <FolderOpen size={15} />
                      </button>
                      <button
                        className="icon-button"
                        title={t("清空输入")}
                        aria-label={t("清空输入")}
                        disabled={!input.text || comparing}
                        onClick={() => input.change("", "")}
                      >
                        <Eraser size={15} />
                      </button>
                    </div>
                  </header>
                  <div
                    className="editor-body"
                    onCompositionStartCapture={() => input.setComposing(true)}
                    onCompositionEndCapture={() => input.setComposing(false)}
                  >
                    <JsonEditor
                      value={input.text}
                      label={t(
                        side === "left"
                          ? "第一份 JSON 输入"
                          : "第二份 JSON 输入",
                      )}
                      wrap={wrap}
                      readOnly={comparing}
                      onChange={(text) => input.change(text)}
                    />
                  </div>
                  <footer className="editor-footer comparison-pane-footer">
                    <div
                      className={`comparison-status ${input.error ? "error" : input.valid ? "valid" : ""}`}
                      role="status"
                      data-testid={`comparison-${side}-status`}
                    >
                      {input.error ? (
                        <CircleAlert size={12} />
                      ) : input.pending ? (
                        <LoaderCircle className="spin" size={12} />
                      ) : input.valid ? (
                        <Check size={12} />
                      ) : null}
                      <span>{status}</span>
                      {input.result?.arrayDecoding?.failedItems ? (
                        <span>
                          {t("{{count}} 项未展开", {
                            count: input.result.arrayDecoding.failedItems,
                          })}
                        </span>
                      ) : null}
                    </div>
                    <CopyButton
                      onCopy={() => copy(input.text)}
                      feedbackKey={input.text}
                      disabled={!input.text || comparing}
                    />
                  </footer>
                  {input.name && (
                    <div className="comparison-file-name" title={input.name}>
                      {input.name}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <footer className="comparison-note">
            <ArrowRight size={13} />
            <span>
              {t("仅对齐对象字段，保留数组顺序；右侧独有字段追加到末尾。")}
            </span>
            <span>{t("对比输入仅在当前会话保留，不写入文件。")}</span>
          </footer>
        </div>
        {result && (
          <ComparisonResult
            result={result}
            wrap={wrap}
            onBack={() => setResult(undefined)}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            if (event.target.files)
              void importFiles(
                Array.from(event.target.files),
                fileSide.current,
              );
            event.target.value = "";
          }}
        />
      </main>
    );
  },
);
