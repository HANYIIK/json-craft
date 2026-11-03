import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CornerDownRight,
  ListFilter,
  LoaderCircle,
  Search,
} from "lucide-react";
import type {
  ExtractedValue,
  JsonValueType,
  KeyMatch,
  KeySearchResult,
} from "../../../shared/types";
import { localizeMessage, useI18n } from "../../i18n/i18n";
import "./key-extractor.css";

interface Props {
  sourceId: string;
  optionsKey: string;
  disabled: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  automaticSearch?: KeySearchResult;
  extraction?: ExtractedValue;
  onSearch: (key: string) => Promise<KeySearchResult>;
  onExtract: (match: KeyMatch, search: KeySearchResult) => void;
  onReset: () => void;
}

const typeLabels: Record<JsonValueType, string> = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数字",
  boolean: "布尔值",
  null: "null",
};

const numberFormatters = {
  "zh-CN": new Intl.NumberFormat("zh-CN"),
  en: new Intl.NumberFormat("en"),
};

export function KeyExtractor({
  sourceId,
  optionsKey,
  disabled,
  query,
  onQueryChange,
  automaticSearch,
  extraction,
  onSearch,
  onExtract,
  onReset,
}: Props) {
  const { t, language } = useI18n();
  const number = (value: number) => numberFormatters[language].format(value);
  const occurrenceLabel = (
    match: Pick<KeyMatch, "occurrence" | "occurrences">,
  ) =>
    match.occurrences > 1
      ? t("同路径第 {{current}} / {{total}} 项", {
          current: number(match.occurrence),
          total: number(match.occurrences),
        })
      : "";
  const id = useId();
  const [storedSearch, setSearch] = useState<KeySearchResult>();
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const searchContext = useRef<
    | {
        sourceId: string;
        optionsKey: string;
        query: string;
      }
    | undefined
  >(undefined);
  const mounted = useRef(true);
  const context = useRef({ sourceId, optionsKey, disabled });
  const callbacks = useRef({ onSearch, onExtract, onReset });
  context.current = { sourceId, optionsKey, disabled };
  callbacks.current = { onSearch, onExtract, onReset };
  const search =
    !disabled &&
    searchContext.current?.sourceId === sourceId &&
    searchContext.current.optionsKey === optionsKey &&
    searchContext.current.query === query
      ? storedSearch
      : !disabled && automaticSearch?.key === query
        ? automaticSearch
        : undefined;

  useEffect(() => {
    request.current++;
    searchContext.current = undefined;
    setSearch(undefined);
    setSelectedId("");
    setBusy(false);
    setError("");
  }, [sourceId, optionsKey, disabled]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);

  function invalidate() {
    request.current++;
    searchContext.current = undefined;
    setSearch(undefined);
    setSelectedId("");
    setBusy(false);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy || !query.length) return;
    const sequence = ++request.current;
    const source = { ...context.current };
    const name = query;
    const currentRequest = () =>
      mounted.current &&
      sequence === request.current &&
      source.sourceId === context.current.sourceId &&
      source.optionsKey === context.current.optionsKey &&
      !context.current.disabled;
    setBusy(true);
    setSearch(undefined);
    setSelectedId("");
    setError("");
    try {
      const found = await callbacks.current.onSearch(name);
      if (!currentRequest()) return;
      searchContext.current = { ...source, query: name };
      setSearch(found);
      if (!found.preparation.success || found.error) {
        setError(
          found.error ||
            found.preparation.error?.message ||
            "无法读取源 JSON，请检查内容后重试。",
        );
        return;
      }
      if (found.matches.length === 1 && !found.truncated) {
        callbacks.current.onExtract(found.matches[0], found);
      }
    } catch (failure) {
      if (currentRequest())
        setError(
          failure instanceof Error ? failure.message : "查找失败，请重试。",
        );
    } finally {
      if (currentRequest()) setBusy(false);
    }
  }

  function extractSelected() {
    if (!search || busy || disabled) return;
    const selected = search.matches.find((match) => match.id === selectedId);
    if (selected) {
      invalidate();
      callbacks.current.onExtract(selected, search);
    }
  }

  const canChoose = Boolean(
    search?.preparation.success &&
    !search.error &&
    (search.matches.length > 1 ||
      (search.matches.length > 0 && search.truncated)),
  );
  const noMatches = Boolean(
    search?.preparation.success && !search.error && !search.matches.length,
  );
  const visibleError =
    error ||
    search?.error ||
    (search && !search.preparation.success
      ? search.preparation.error?.message
      : undefined);
  const showBody = Boolean(extraction || visibleError || search);

  return (
    <section className="key-extractor" aria-label={t("按 key 提取 JSON 值")}>
      <form className="key-form" onSubmit={(event) => void submit(event)}>
        <label className="key-form-label" htmlFor={`${id}-query`}>
          <ListFilter size={15} />
          {t("提取 Key")}
        </label>
        <div className="key-input-wrap">
          <input
            id={`${id}-query`}
            className="key-input"
            aria-label={t("提取 key 名称")}
            placeholder={t("例如 data、payload，递归查找所有层级")}
            value={query}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              invalidate();
              onQueryChange(event.target.value);
            }}
          />
        </div>
        <button
          type="submit"
          className="button"
          disabled={disabled || busy || !query.length}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Search size={14} />
          )}
          {t(busy ? "正在查找" : "查找并提取")}
        </button>
        {extraction && (
          <button
            type="button"
            className="button ghost key-reset"
            onClick={() => {
              invalidate();
              callbacks.current.onReset();
            }}
          >
            <ArrowLeft size={13} />
            {t("返回完整 JSON")}
          </button>
        )}
      </form>
      {showBody && (
        <div className="key-body">
          {extraction && (
            <div className="key-current" role="status">
              <CornerDownRight size={14} />
              <span>{t("当前提取")}</span>
              <code>{extraction.path}</code>
              {extraction.occurrences > 1 && (
                <span className="key-occurrence">
                  {occurrenceLabel(extraction)}
                </span>
              )}
            </div>
          )}
          {visibleError && (
            <div className="key-message key-error" role="alert">
              <CircleAlert size={14} />
              <span>{t(localizeMessage(visibleError))}</span>
            </div>
          )}
          {noMatches && search && (
            <div className="key-message" role="status">
              <Search size={14} />
              <span>
                {t("未找到名称为 {{key}} 的 key，请核对名称与大小写。", {
                  key: search.key,
                })}
              </span>
            </div>
          )}
          {search?.preparation.success &&
            !visibleError &&
            !search.error &&
            search.matches.length === 1 &&
            !search.truncated &&
            !extraction && (
              <div className="key-message" role="status">
                <CornerDownRight size={14} />
                <span>
                  {t("找到唯一匹配 {{path}}，正在提取。", {
                    path: search.matches[0].path,
                  })}
                </span>
              </div>
            )}
          {canChoose && search && (
            <fieldset className="key-matches">
              <legend>
                {t(
                  search.truncated
                    ? "找到至少 {{total}} 个同名 key，请选择完整路径"
                    : "找到 {{total}} 个同名 key，请选择完整路径",
                  {
                    total: number(search.matches.length),
                    count: search.matches.length,
                  },
                )}
              </legend>
              {search.matches.map((match) => (
                <label
                  key={match.id}
                  className={`key-match ${selectedId === match.id ? "key-match-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name={`${id}-matches`}
                    value={match.id}
                    checked={selectedId === match.id}
                    onChange={() => setSelectedId(match.id)}
                    aria-label={
                      match.occurrences > 1
                        ? t("{{path}}，{{occurrence}}，{{type}}", {
                            path: match.path,
                            occurrence: occurrenceLabel(match),
                            type: t(typeLabels[match.type]),
                          })
                        : t("{{path}}，{{type}}", {
                            path: match.path,
                            type: t(typeLabels[match.type]),
                          })
                    }
                  />
                  <span className="key-match-content">
                    <span className="key-match-heading">
                      <code className="key-match-path">{match.path}</code>
                      <span className="key-value-type">
                        {t(typeLabels[match.type])}
                      </span>
                      {match.occurrences > 1 && (
                        <span className="key-occurrence">
                          {occurrenceLabel(match)}
                        </span>
                      )}
                    </span>
                    <code className="key-preview">{match.preview}</code>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {search?.truncated && (
            <p className="key-limit" role="status">
              {t("匹配过多，仅展示前 {{total}} 项；选择前请核对路径和预览。", {
                total: number(search.matches.length),
              })}
            </p>
          )}
        </div>
      )}
      {canChoose && (
        <div className="key-selection-action">
          <span>{t("同名项不会自动提取。")}</span>
          <button
            type="button"
            className="button"
            disabled={!selectedId || busy || disabled}
            onClick={extractSelected}
          >
            <ArrowRight size={14} />
            {t("提取选中值")}
          </button>
        </div>
      )}
    </section>
  );
}
