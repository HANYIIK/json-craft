import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileJson2, LoaderCircle, Pin } from "lucide-react";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import { HistoryActions } from "./HistoryActions";
import "./history-entry.css";

interface Props {
  id: string;
  name: string;
  selected: boolean;
  status: string;
  statusKind: "pending" | "processing" | "repair" | "ok" | "error" | "saving";
  updatedAt?: string;
  pinned?: boolean;
  saveError?: string;
  onSelect: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<boolean>;
  onPin: (pinned: boolean) => Promise<void>;
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
  pinned = false,
  saveError,
  onSelect,
  onRename,
  onDelete,
  onPin,
}: Props) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pinning, setPinning] = useState(false);
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

  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(
      0,
      draft.replace(/\.json$/i, "").length,
    );
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
    if (editing) {
      inputRef.current?.focus();
      return;
    }
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
      else if (editing) requestAnimationFrame(() => inputRef.current?.focus());
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

  async function togglePin() {
    if (pending.current) return;
    const origin = document.activeElement;
    pending.current = true;
    const currentOperation = ++operation.current;
    setPinning(true);
    setError("");
    try {
      await onPin(!pinned);
      if (!mounted.current || currentOperation !== operation.current) return;
      requestAnimationFrame(() => {
        selectRef.current?.scrollIntoView({ block: "nearest" });
        if (editing) inputRef.current?.focus();
      });
    } catch (failure) {
      if (!mounted.current || currentOperation !== operation.current) return;
      setError(
        failure instanceof Error
          ? failure.message
          : "无法修改置顶状态，请重试。",
      );
    } finally {
      if (mounted.current && currentOperation === operation.current) {
        pending.current = false;
        setPinning(false);
        requestAnimationFrame(() => {
          if (!mounted.current || currentOperation !== operation.current)
            return;
          if (
            document.activeElement !== document.body &&
            document.activeElement !== origin
          )
            return;
          if (editing) inputRef.current?.focus({ preventScroll: true });
          else if (origin instanceof HTMLElement && origin.isConnected)
            origin.focus({ preventScroll: true });
        });
      }
    }
  }

  return (
    <div
      className={`history-entry ${selected ? "history-entry-selected" : ""} ${editing ? "history-entry-editing" : ""}`}
      data-history-id={id}
      data-pinned={pinned}
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
          {pinned && !editing && (
            <Pin
              size={11}
              className="history-entry-pin"
              aria-label={t("已置顶")}
            />
          )}
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
            disabled={renaming || deleting || pinning}
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
                  ?.closest("[data-history-actions]")
                  ?.getAttribute("data-history-actions") === id
              ) {
                skipBlur.current = false;
                return;
              }
              void commitRename();
            }}
          />
        )}
        <div className="history-entry-controls">
          <HistoryActions
            id={id}
            name={name}
            pinned={pinned}
            disabled={renaming || deleting || pinning}
            busy={renaming || deleting || pinning}
            onPin={() => void togglePin()}
            onRename={beginRename}
            onDelete={() => void deleteEntry()}
          />
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
