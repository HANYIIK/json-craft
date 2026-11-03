import { useEffect, useRef, useState } from "react";
import { FileJson2, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "./history-entry.css";

interface Props {
  id: string;
  name: string;
  selected: boolean;
  status: string;
  statusKind: "pending" | "processing" | "repair" | "ok" | "error" | "saving";
  updatedAt?: string;
  saveError?: string;
  onSelect: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<boolean>;
}

const dateFormatters = new Map<
  string,
  { modified: Intl.DateTimeFormat; full: Intl.DateTimeFormat }
>();

function getDateFormatters(language: string) {
  let formatters = dateFormatters.get(language);
  if (!formatters) {
    formatters = {
      modified: new Intl.DateTimeFormat(language, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      full: new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    };
    dateFormatters.set(language, formatters);
  }
  return formatters;
}

export function HistoryEntry({
  id,
  name,
  selected,
  status,
  statusKind,
  updatedAt,
  saveError,
  onSelect,
  onRename,
  onDelete,
}: Props) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const skipBlur = useRef(false);
  const mounted = useRef(true);
  const operation = useRef(0);
  const formatters = getDateFormatters(language);
  const updatedDate = updatedAt ? new Date(updatedAt) : undefined;
  const validDate =
    updatedDate && !Number.isNaN(updatedDate.getTime())
      ? updatedDate
      : undefined;
  const updatedLabel = validDate
    ? formatters.modified.format(validDate)
    : undefined;
  const visibleError = error || saveError;
  const localizedStatus = t(localizeMessage(status));

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(
        0,
        draft.replace(/\.json$/i, "").length,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current++;
    };
  }, []);

  function beginRename() {
    if (pending.current) return;
    skipBlur.current = false;
    setDraft(name);
    setError("");
    setEditing(true);
  }

  function cancelRename() {
    if (pending.current) return;
    skipBlur.current = true;
    setDraft(name);
    setError("");
    setEditing(false);
    requestAnimationFrame(() => selectRef.current?.focus());
  }

  async function commitRename(restoreFocus = false) {
    if (!editing || pending.current) return;
    if (draft === name) {
      setEditing(false);
      return;
    }
    if (!draft.trim()) {
      setError("文件名不能为空。");
      return;
    }
    pending.current = true;
    const currentOperation = ++operation.current;
    setRenaming(true);
    setError("");
    try {
      await onRename(draft);
      if (!mounted.current || currentOperation !== operation.current) return;
      setEditing(false);
      if (restoreFocus) requestAnimationFrame(() => selectRef.current?.focus());
    } catch (failure) {
      if (!mounted.current || currentOperation !== operation.current) return;
      setError(
        failure instanceof Error ? failure.message : "无法修改文件名，请重试。",
      );
      if (restoreFocus) requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      if (mounted.current && currentOperation === operation.current) {
        pending.current = false;
        setRenaming(false);
      }
    }
  }

  async function deleteEntry() {
    skipBlur.current = false;
    if (pending.current) return;
    pending.current = true;
    const currentOperation = ++operation.current;
    setDeleting(true);
    setError("");
    try {
      const removed = await onDelete();
      if (!mounted.current || currentOperation !== operation.current) return;
      if (removed) setEditing(false);
    } catch (failure) {
      if (!mounted.current || currentOperation !== operation.current) return;
      setError(
        failure instanceof Error ? failure.message : "无法删除此记录，请重试。",
      );
    } finally {
      if (mounted.current && currentOperation === operation.current) {
        pending.current = false;
        setDeleting(false);
      }
    }
  }

  return (
    <div
      className={`history-entry ${selected ? "history-entry-selected" : ""} ${editing ? "history-entry-editing" : ""}`}
      data-history-id={id}
    >
      <div className="history-entry-line">
        <button
          ref={selectRef}
          type="button"
          className="history-entry-select"
          aria-label={t("{{name}}，{{status}}", {
            name,
            status: localizedStatus,
          })}
          aria-pressed={selected}
          title={name}
          onClick={onSelect}
          disabled={deleting}
        >
          <FileJson2 size={17} />
          {!editing && <span className="history-entry-name">{name}</span>}
        </button>
        {editing && (
          <input
            ref={inputRef}
            className="history-entry-name-input"
            aria-label={t("文件名")}
            value={draft}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={renaming || deleting}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void commitRename(true);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelRename();
              }
            }}
            onBlur={(event) => {
              const next = event.relatedTarget as HTMLElement | null;
              if (
                skipBlur.current ||
                next
                  ?.closest("[data-history-delete]")
                  ?.getAttribute("data-history-delete") === id
              ) {
                skipBlur.current = false;
                return;
              }
              void commitRename();
            }}
          />
        )}
        <div className="history-entry-controls">
          {!editing && (
            <button
              type="button"
              className="history-entry-action"
              aria-label={t("重命名 {{name}}", { name })}
              title={t("重命名")}
              onClick={beginRename}
              disabled={renaming || deleting}
            >
              <Pencil size={12} />
            </button>
          )}
          {renaming && <LoaderCircle size={12} className="spin" />}
          <button
            type="button"
            className="history-entry-action history-entry-delete"
            data-history-delete={id}
            aria-label={t("删除 {{name}}", { name })}
            title={t("删除历史记录")}
            onPointerDown={() => {
              skipBlur.current = true;
            }}
            onPointerUp={() => {
              skipBlur.current = false;
            }}
            onPointerCancel={() => {
              skipBlur.current = false;
            }}
            onClick={() => void deleteEntry()}
            disabled={renaming || deleting}
          >
            {deleting ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <Trash2 size={12} />
            )}
          </button>
        </div>
      </div>
      <div className={`history-entry-meta history-status-${statusKind}`}>
        <span className="history-entry-status">
          {renaming ||
          deleting ||
          statusKind === "processing" ||
          statusKind === "saving" ? (
            <LoaderCircle size={9} className="spin" />
          ) : (
            <span className="status-dot" />
          )}
          {deleting
            ? t("正在删除")
            : renaming
              ? t("正在更新名称")
              : localizedStatus}
        </span>
        {updatedLabel && (
          <time
            dateTime={updatedAt}
            title={validDate ? formatters.full.format(validDate) : undefined}
          >
            {updatedLabel}
          </time>
        )}
      </div>
      {editing && !renaming && !visibleError && (
        <p className="history-entry-hint">
          {t("回车或移开焦点更新 · Esc 取消")}
        </p>
      )}
      {visibleError && (
        <p className="history-entry-error" role="alert">
          {t(localizeMessage(visibleError))}
        </p>
      )}
    </div>
  );
}
