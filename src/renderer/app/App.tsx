import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Columns2,
  Eraser,
  FileJson2,
  FolderOpen,
  GitPullRequestArrow,
  HardDrive,
  Settings,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelLeft,
  SquarePen,
  ShieldCheck,
  TextWrap,
  Upload,
  Undo2,
  RotateCw,
  ScanText,
} from "lucide-react";
import { defaultOptions, MAX_FILE_BYTES } from "../../shared/types";
import type {
  FormatOptions,
  ExtractedValue,
  ImportedFile,
  KeyMatch,
  KeySearchResult,
  ProcessingResult,
  HistoryRecord,
  HistorySummary,
  SavedExtraction,
  WorkspaceSettings,
  DirectoryKind,
} from "../../shared/types";
import { FormatClient } from "../services/format-client";
import {
  JsonEditor,
  type EditorSelection,
} from "../features/editor/JsonEditor";
import { CopyButton } from "../components/CopyButton";
import { OverlayScrollbars } from "../components/OverlayScrollbars";
import {
  ComparisonPage,
  type ComparisonPageHandle,
} from "../features/comparison/ComparisonPage";
import {
  LogExtractionPage,
  type LogExtractionPageHandle,
} from "../features/log-extraction/LogExtractionPage";
import type { LogJsonCandidate } from "../../core/json/log-extract";
import { DeleteConfirmation } from "../features/history/DeleteConfirmation";
import { KeyExtractor } from "../features/extraction/KeyExtractor";
import { HistorySync, type SaveStatus } from "../features/history/history-sync";
import { createBrowserWorkspace } from "../features/history/browser-workspace";
import { HistoryEntry } from "../features/history/HistoryEntry";
import { compareHistoryRecency } from "../features/history/history-order";
import { WorkspaceSettingsPanel } from "../features/settings/WorkspaceSettings";
import { Select } from "../components/Select";
import { Brand } from "./Brand";
import {
  RepairDiffPage,
  type RepairDiffSnapshot,
} from "../features/repair-diff/RepairDiffPage";
import {
  collectRepairRecords,
  getRepairSummary,
  type RepairRecordChange,
} from "../features/repair-diff/repair-records";
import {
  createRepairSourceLocator,
  type RepairSourceSelection,
} from "../features/repair-diff/repair-source-location";
import { getThemePreference, setThemePreference } from "../theme/theme";
import {
  getLanguagePreference,
  localizeMessage,
  setLanguagePreference,
  translate as t,
  useI18n,
} from "../i18n/i18n";
import { useSidebarMotion } from "./sidebar-motion";
import { version } from "../../../package.json";

type DocumentStatus =
  "empty" | "pending" | "processing" | "done" | "error" | "stored" | "loading";
type FocusedPane = "input" | "output" | null;

interface WorkDocument {
  id: string;
  name: string;
  raw: string;
  revision: number;
  source: "sample" | "imported" | "scratch";
  status: DocumentStatus;
  result?: ProcessingResult;
  importError?: string;
  duration?: number;
  cleared?: string;
  extraction?: ExtractedValue;
  savedExtraction?: SavedExtraction;
  keyQuery?: string;
  keySearch?: KeySearchResult;
  autoExtract?: boolean;
  options?: FormatOptions;
  sourcePath?: string;
  managedPath?: string;
  fileSaveError?: string;
  fileStorageError?: string;
  autoCopyRequested?: boolean;
  createdAt?: string;
  updatedAt?: string;
  pinned?: boolean;
  loaded?: boolean;
  persisted?: boolean;
  characters?: number;
  saveState?: SaveStatus;
  saveError?: string;
  deleting?: boolean;
}

function historySnapshot(doc: WorkDocument): HistoryRecord {
  return {
    id: doc.id,
    name: doc.name,
    raw: doc.raw,
    source: doc.source,
    sourcePath: doc.sourcePath,
    managedPath: doc.managedPath,
    fileSaveError: doc.fileSaveError,
    pinned: doc.pinned ?? false,
    options: doc.options ?? defaultOptions,
    extraction: doc.extraction
      ? {
          key: doc.extraction.key,
          path: doc.extraction.path,
          occurrence: doc.extraction.occurrence,
        }
      : doc.savedExtraction,
    createdAt: doc.createdAt ?? new Date().toISOString(),
    updatedAt: doc.updatedAt ?? new Date().toISOString(),
  };
}

function storedDocument(record: HistorySummary): WorkDocument {
  return {
    ...record,
    savedExtraction: record.extraction,
    extraction: undefined,
    raw: "",
    revision: 0,
    loaded: false,
    persisted: true,
    saveState: record.fileSaveError ? "error" : "saved",
    saveError: record.fileSaveError,
    status: "stored",
  };
}

const samples: WorkDocument[] = [
  {
    id: "release",
    name: "release.json",
    raw: '{"app":"JSON Craft","version":"0.1.0" "targets":["macOS","Windows",],"local":True}',
    revision: 0,
    source: "sample",
    status: "pending",
  },
  {
    id: "settings",
    name: "settings.json",
    raw: '{"editor":{"indent":2,"wrap":true},"theme":"light","language":"zh-CN"}',
    revision: 0,
    source: "sample",
    status: "pending",
  },
  {
    id: "response",
    name: "response.json",
    raw: JSON.stringify(
      '{"status":200,"message":"Hello, JSON!","data":{"id":42,"active":true}}',
    ),
    revision: 0,
    source: "sample",
    status: "pending",
  },
];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : t("操作失败，请重试。");
const snippet = (text: string) =>
  text
    ? text
        .replace(/\r/g, "␍")
        .replace(/\n/g, "↵")
        .replace(/\t/g, "⇥")
        .slice(0, 45) + (text.length > 45 ? "…" : "")
    : "∅";

function resultLabel(doc: WorkDocument) {
  if (doc.status === "stored") return t("已保存");
  if (doc.status === "loading") return t("正在载入");
  if (doc.status === "processing") return t("处理中");
  if (doc.status === "pending") return t("待格式化");
  if (doc.status === "empty") return t("空白输入");
  if (doc.status === "error") return t("无法处理");
  if (doc.result?.arrayDecoding?.failedItems) return t("存在未展开项");
  const repairs = getRepairSummary(doc.result, doc.extraction?.preparation);
  if (repairs.stageCount)
    return repairs.changeCount === null
      ? t("已修复")
      : t("已修复 {{count}} 处", { count: repairs.changeCount });
  if (
    doc.result?.decodedLayers ||
    doc.result?.arrayDecoding?.decodedItems ||
    doc.extraction?.preparation.decodedLayers
  )
    return t("已去转义");
  return t("已格式化");
}

function textLocation(layer: number, extracted: boolean, path?: string) {
  const target = layer
    ? t(
        extracted
          ? "提取值解码 {{count}} 层后的文本"
          : "解码 {{count}} 层后的文本",
        { count: layer },
      )
    : t(extracted ? "提取值" : "原文");
  return path ? t("位置 {{path}} · {{target}}", { path, target }) : target;
}

function selectedValue(
  match: KeyMatch,
  search: KeySearchResult,
): ExtractedValue {
  return {
    key: search.key,
    path: match.path,
    matchId: match.id,
    occurrence: match.occurrence,
    occurrences: match.occurrences,
    raw: search.preparation.output.slice(match.start, match.end),
    preparation: search.preparation,
  };
}

function savedValue(value: ExtractedValue): SavedExtraction {
  return { key: value.key, path: value.path, occurrence: value.occurrence };
}

export function App() {
  const { language } = useI18n();
  const runSidebarTransition = useSidebarMotion();
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(language),
    [language],
  );
  const [documents, setDocumentsState] = useState<WorkDocument[]>(samples);
  const [activeId, setActiveId] = useState("release");
  const [options, setOptions] = useState<FormatOptions>(defaultOptions);
  const [wrap, setWrap] = useState(true);
  const [focusedPane, setFocusedPane] = useState<FocusedPane>(null);
  const [diffSnapshot, setDiffSnapshot] = useState<RepairDiffSnapshot>();
  const [selectedChange, setSelectedChange] = useState<RepairRecordChange>();
  const [selection, setSelection] = useState<EditorSelection>();
  const [feedback, setFeedback] = useState("");
  const [dragging, setDragging] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deletePrompt = useRef<{
    id: string;
    confirming: boolean;
    resolve: (removed: boolean) => void;
  } | null>(null);
  useEffect(
    () => () => {
      deletePrompt.current?.resolve(false);
      deletePrompt.current = null;
    },
    [],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonVisited, setComparisonVisited] = useState(false);
  const comparisonMode = useRef(false);
  comparisonMode.current = comparisonOpen;
  const comparison = useRef<ComparisonPageHandle>(null);
  const [logExtractionOpen, setLogExtractionOpen] = useState(false);
  const [logExtractionVisited, setLogExtractionVisited] = useState(false);
  const [logPreviewExpanded, setLogPreviewExpanded] = useState(false);
  const logExtraction = useRef<LogExtractionPageHandle>(null);
  const logExtractionMode = useRef(false);
  logExtractionMode.current = logExtractionOpen;
  const migratedLogItems = useRef(new WeakMap<LogJsonCandidate, string>());
  const migrationOperation = useRef<Promise<void> | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("json-craft.sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "json-craft.sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {}
  }, [sidebarCollapsed]);
  const [settings, setSettings] = useState<WorkspaceSettings>({
    readDirectory: "",
    writeDirectory: "",
    historyDirectory: "",
    theme: getThemePreference(),
    language: getLanguagePreference(),
    autoCopy: false,
    recursiveUnescape: true,
  });
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  useEffect(() => {
    setThemePreference(settingsDraft.theme);
  }, [settingsDraft.theme]);
  useEffect(() => {
    setLanguagePreference(settingsDraft.language ?? "system");
  }, [settingsDraft.language]);
  const client = useMemo(() => new FormatClient(), [FormatClient]);
  const documentsRef = useRef(documents);
  const readyRef = useRef(false);
  const settingsRef = useRef(settings);
  const settingsDraftRef = useRef(settingsDraft);
  const pendingSettings = useRef<Partial<WorkspaceSettings>>({});
  const failedSettings = useRef<Partial<WorkspaceSettings>>({});
  const settingsFailure = useRef("");
  const directoryOperation = useRef<Promise<void> | undefined>(undefined);
  const settingsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settingsOperation = useRef<Promise<void> | undefined>(undefined);
  const closing = useRef(false);
  const closeAllowed = useRef(false);
  const lastActiveSaved = useRef<string | null | undefined>(undefined);
  const activeSaveSequence = useRef(0);
  const activeOperation = useRef<Promise<void> | undefined>(undefined);
  const bootstrapGeneration = useRef(0);
  const deletingRecords = useRef(new Set<string>());
  const deletionSequence = useRef(0);
  const deletedAt = useRef(new Map<string, number>());
  const pendingOpenedFiles = useRef<ImportedFile[]>([]);
  const importOperations = useRef(new Set<Promise<void>>());
  const clipboardQueue = useRef<Promise<unknown>>(Promise.resolve());
  const clipboardPending = useRef(0);
  const clipboardGeneration = useRef(0);
  const lastRecursivePreference = useRef<boolean | undefined>(undefined);
  const workspaceApi = useMemo(
    () => window.desktop?.workspace ?? createBrowserWorkspace(),
    [],
  );
  const draft = useMemo<WorkDocument>(
    () => ({
      id: crypto.randomUUID(),
      name: "untitled.json",
      raw: "",
      revision: 0,
      source: "scratch",
      status: "empty",
      options: defaultOptions,
      loaded: true,
    }),
    [],
  );
  const setDocuments = useCallback(
    (
      update: WorkDocument[] | ((previous: WorkDocument[]) => WorkDocument[]),
    ) => {
      const next =
        typeof update === "function" ? update(documentsRef.current) : update;
      documentsRef.current = next;
      setDocumentsState(next);
    },
    [],
  );
  const sync = useMemo(
    () =>
      new HistorySync(workspaceApi, (id, status, error, summary) => {
        setDocuments((previous) =>
          previous.map((doc) =>
            doc.id === id
              ? {
                  ...doc,
                  saveState: status,
                  saveError: error,
                  ...(status === "error" && !summary
                    ? { fileSaveError: undefined }
                    : {}),
                  ...(summary
                    ? {
                        name: summary.name,
                        managedPath: summary.managedPath,
                        fileSaveError: summary.fileSaveError,
                        ...(summary.managedPath && !summary.fileSaveError
                          ? { fileStorageError: undefined }
                          : {}),
                        persisted: true,
                        createdAt: summary.createdAt,
                        updatedAt: summary.updatedAt,
                        pinned: summary.pinned,
                        characters: summary.characters,
                      }
                    : {}),
                }
              : doc,
          ),
        );
      }),
    [workspaceApi, setDocuments],
  );
  const activeRef = useRef(activeId);
  const optionsRef = useRef(options);
  const fileInput = useRef<HTMLInputElement>(null);
  const applicationRef = useRef<HTMLDivElement>(null);
  const diffReturnFocus = useRef<HTMLElement | null>(null);
  const diffSequence = useRef(0);
  const focusOrigin = useRef<FocusedPane>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selectionCounter = useRef(0);
  const jobs = useRef(new Map<string, number>());
  const jobSequence = useRef(0);
  const dragDepth = useRef(0);
  documentsRef.current = documents;
  settingsRef.current = settings;
  settingsDraftRef.current = settingsDraft;
  activeRef.current = activeId;
  optionsRef.current = options;
  const current = documents.find((doc) => doc.id === activeId) ?? draft;
  const historyDocuments = useMemo(
    () => [...documents].sort(compareHistoryRecency),
    [documents],
  );
  const result = current.result;
  const keyQuery =
    current.keyQuery ??
    current.extraction?.key ??
    current.savedExtraction?.key ??
    "";
  const repairRecords = useMemo(
    () => collectRepairRecords(result, current.extraction?.preparation),
    [result, current.extraction?.preparation],
  );
  const repairLocations = useMemo(() => {
    const locations = new Map<string, RepairSourceSelection>();
    if (!repairRecords.changes.length) return locations;
    const locate = createRepairSourceLocator(
      current.raw,
      current.extraction,
      repairRecords.stages,
    );
    const stages = new Map(
      repairRecords.stages.map((stage) => [stage.id, stage]),
    );
    for (const change of repairRecords.changes) {
      const location = locate(change, stages.get(change.stageId));
      if (location) locations.set(change.id, location);
    }
    return locations;
  }, [current.raw, current.extraction, repairRecords]);
  const hasOutput = current.status === "done" && result?.success === true;
  const platform = window.desktop?.platform ?? "web";
  const command = platform === "darwin" ? "⌘" : "Ctrl";
  const sidebarHidden =
    sidebarCollapsed ||
    (!settingsOpen &&
      (focusedPane !== null ||
        Boolean(diffSnapshot) ||
        (logExtractionOpen && logPreviewExpanded)));

  useEffect(() => {
    if (settingsOpen || diffSnapshot) return;
    const pane = focusedPane ?? focusOrigin.current;
    if (!pane) return;
    focusOrigin.current = focusedPane;
    const frame = requestAnimationFrame(() => {
      const selector = focusedPane
        ? `[data-testid="${pane}-editor"] .cm-content`
        : `[data-focus-toggle="${pane}"]`;
      applicationRef.current
        ?.querySelector<HTMLElement>(selector)
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedPane, settingsOpen, diffSnapshot]);

  useEffect(() => {
    if (!focusedPane && !settingsOpen && !diffSnapshot) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      event.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else if (diffSnapshot) closeDiffPage();
      else setFocusedPane(null);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [focusedPane, settingsOpen, diffSnapshot]);

  const notify = useCallback((message: string) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(message);
    if (message)
      feedbackTimer.current = setTimeout(() => setFeedback(""), 5000);
  }, []);

  const copyResult = useCallback(
    (output: string, automatic = false, isCurrent?: () => boolean) => {
      clipboardPending.current++;
      const operation = clipboardQueue.current
        .then(async () => {
          if (isCurrent && !isCurrent()) return false;
          if (window.desktop) await window.desktop.copyText(output);
          else await navigator.clipboard.writeText(output);
          if (!isCurrent || isCurrent())
            notify(
              automatic
                ? t("格式化完成，已自动复制结果")
                : t("已复制格式化结果"),
            );
          return true;
        })
        .catch((error) => {
          if (!isCurrent || isCurrent())
            notify(
              automatic
                ? t("自动复制失败：{{message}}", {
                    message: localizeMessage(errorMessage(error)),
                  })
                : errorMessage(error),
            );
          return false;
        })
        .finally(() => {
          clipboardPending.current--;
        });
      clipboardQueue.current = operation;
      return operation;
    },
    [notify],
  );

  const formatDocument = useCallback(
    async (
      doc: WorkDocument,
      override?: ExtractedValue | null,
      allowAutoCopy = false,
    ) => {
      if (doc.loaded === false || doc.importError || !doc.raw.trim()) return;
      const live = documentsRef.current.find((item) => item.id === doc.id);
      if (
        !live ||
        live.revision !== doc.revision ||
        live.raw !== doc.raw ||
        (doc.autoExtract && live.keyQuery !== doc.keyQuery) ||
        live.deleting
      )
        return;
      const copyGeneration = clipboardGeneration.current;
      const shouldAutoCopy =
        allowAutoCopy &&
        !comparisonMode.current &&
        !logExtractionMode.current &&
        activeRef.current === doc.id;
      const automaticExtraction =
        override === undefined && Boolean(doc.autoExtract);
      let extraction =
        override === undefined
          ? automaticExtraction
            ? undefined
            : doc.extraction
          : (override ?? undefined);
      let keySearch: KeySearchResult | undefined;
      const job = ++jobSequence.current;
      jobs.current.set(doc.id, job);
      const formatOptions = { ...(doc.options ?? optionsRef.current) };
      const recursiveUnescape =
        settingsDraftRef.current.recursiveUnescape ?? true;
      const signature = JSON.stringify(formatOptions);
      const started = performance.now();
      setDocuments((previous) =>
        previous.map((item) =>
          item.id === doc.id && item.revision === doc.revision
            ? {
                ...item,
                status: "processing",
                result: undefined,
                keySearch: undefined,
                extraction,
                options: formatOptions,
                autoCopyRequested: false,
                ...(override !== undefined
                  ? {
                      savedExtraction: extraction
                        ? savedValue(extraction)
                        : undefined,
                      keyQuery:
                        item.keyQuery ??
                        extraction?.key ??
                        doc.extraction?.key ??
                        doc.savedExtraction?.key,
                      autoExtract: false,
                    }
                  : {}),
              }
            : item,
        ),
      );
      let processed: ProcessingResult;
      try {
        if (
          automaticExtraction ||
          (override === undefined && !extraction && doc.savedExtraction)
        ) {
          const key = automaticExtraction
            ? (doc.keyQuery ?? "")
            : doc.savedExtraction!.key;
          const found = await client.findKey(doc.raw, key, formatOptions);
          const preferred = doc.savedExtraction;
          const previousMatch =
            preferred?.key === key
              ? found.matches.find(
                  (item) =>
                    item.path === preferred.path &&
                    item.occurrence === preferred.occurrence,
                )
              : undefined;
          const match =
            previousMatch ??
            (automaticExtraction &&
            found.matches.length === 1 &&
            !found.truncated
              ? found.matches[0]
              : undefined);
          if (match && found.preparation.success && !found.error)
            extraction = selectedValue(match, found);
          else keySearch = found;
        }
        if (
          jobs.current.get(doc.id) !== job ||
          (settingsDraftRef.current.recursiveUnescape ?? true) !==
            recursiveUnescape
        )
          return;
        processed =
          keySearch && !keySearch.preparation.success
            ? keySearch.preparation
            : await client.format(
                extraction?.raw ?? doc.raw,
                formatOptions,
                recursiveUnescape,
              );
      } catch (error) {
        processed = {
          success: false,
          output: "",
          decodedLayers: 0,
          stages: [],
          changeCount: 0,
          error: { message: errorMessage(error) },
        };
      }
      if (
        jobs.current.get(doc.id) !== job ||
        (settingsDraftRef.current.recursiveUnescape ?? true) !==
          recursiveUnescape ||
        !documentsRef.current.some(
          (item) =>
            item.id === doc.id &&
            item.revision === doc.revision &&
            (!automaticExtraction || item.keyQuery === doc.keyQuery) &&
            JSON.stringify(item.options ?? defaultOptions) === signature,
        )
      )
        return processed;
      const duration = performance.now() - started;
      setDocuments((previous) =>
        previous.map((item) =>
          item.id === doc.id && item.revision === doc.revision
            ? {
                ...item,
                result: processed,
                status: processed.success ? "done" : "error",
                duration,
                extraction,
                keySearch,
                autoExtract: false,
                savedExtraction: extraction
                  ? savedValue(extraction)
                  : item.savedExtraction,
              }
            : item,
        ),
      );
      if (
        processed.success &&
        shouldAutoCopy &&
        settingsDraftRef.current.autoCopy
      ) {
        void copyResult(processed.output, true, () => {
          const current = documentsRef.current.find(
            (item) => item.id === doc.id,
          );
          return Boolean(
            readyRef.current &&
            !comparisonMode.current &&
            !logExtractionMode.current &&
            clipboardGeneration.current === copyGeneration &&
            settingsDraftRef.current.autoCopy &&
            (settingsDraftRef.current.recursiveUnescape ?? true) ===
              recursiveUnescape &&
            activeRef.current === doc.id &&
            jobs.current.get(doc.id) === job &&
            current?.revision === doc.revision &&
            current.status === "done" &&
            current.result?.output === processed.output &&
            !current.deleting,
          );
        });
      }
      return processed;
    },
    [client, setDocuments, copyResult],
  );

  const hydrateDocument = useCallback(
    async (id: string) => {
      const previous = documentsRef.current.find((doc) => doc.id === id);
      if (!previous) return;
      if (previous.loaded !== false) return previous;
      setDocuments((items) =>
        items.map((doc) =>
          doc.id === id ? { ...doc, status: "loading" } : doc,
        ),
      );
      try {
        const record = await workspaceApi.read(id);
        const live = documentsRef.current.find((doc) => doc.id === id);
        if (!live) return;
        if (live.loaded !== false) return live;
        const loaded: WorkDocument = {
          ...record,
          savedExtraction: record.extraction,
          extraction: undefined,
          keyQuery: live.keyQuery,
          revision: 0,
          loaded: true,
          persisted: true,
          saveState: record.fileSaveError ? "error" : "saved",
          saveError: record.fileSaveError,
          status: record.raw.trim() ? "pending" : "empty",
          name: live.name !== previous.name ? live.name : record.name,
          pinned: live.pinned !== previous.pinned ? live.pinned : record.pinned,
          sourcePath:
            live.sourcePath !== previous.sourcePath
              ? live.sourcePath
              : record.sourcePath,
          managedPath:
            live.managedPath !== previous.managedPath
              ? live.managedPath
              : record.managedPath,
        };
        sync.adopt(historySnapshot(loaded));
        setDocuments((items) =>
          items.map((doc) =>
            doc.id === id && doc.loaded === false ? loaded : doc,
          ),
        );
        if (activeRef.current === id) {
          optionsRef.current = record.options;
          setOptions(record.options);
        }
        return loaded;
      } catch (error) {
        setDocuments((items) =>
          items.map((doc) =>
            doc.id === id && doc.loaded === false
              ? { ...doc, status: "error", importError: errorMessage(error) }
              : doc,
          ),
        );
      }
    },
    [workspaceApi, sync, setDocuments],
  );

  const applySettings = useCallback((incoming: WorkspaceSettings) => {
    const previous = settingsRef.current;
    settingsRef.current = incoming;
    setSettings(incoming);
    setSettingsDraft((currentDraft) => {
      const next = { ...incoming };
      for (const key of Object.keys(incoming) as (keyof WorkspaceSettings)[]) {
        if (currentDraft[key] !== previous[key])
          Object.assign(next, { [key]: currentDraft[key] });
        if (pendingSettings.current[key] !== undefined)
          Object.assign(next, { [key]: pendingSettings.current[key] });
      }
      settingsDraftRef.current = next;
      return next;
    });
  }, []);

  const mergeHistoryRecords = useCallback(
    (records: HistorySummary[], reviveBefore?: number) => {
      for (const record of records) {
        const deleted = deletedAt.current.get(record.id);
        const revive =
          reviveBefore !== undefined &&
          deleted !== undefined &&
          deleted <= reviveBefore &&
          !sync.isRemoving(record.id);
        if (revive) {
          deletingRecords.current.delete(record.id);
          deletedAt.current.delete(record.id);
        }
        sync.adopt(record, revive);
      }
      setDocuments((previous) => {
        const ids = new Set(previous.map((doc) => doc.id));
        const summaries = new Map(records.map((record) => [record.id, record]));
        return [
          ...previous.map((doc) => {
            const record = summaries.get(doc.id);
            if (!record || deletingRecords.current.has(doc.id)) return doc;
            return {
              ...doc,
              name: record.name,
              pinned: record.pinned,
              managedPath: record.managedPath,
              fileSaveError: record.fileSaveError,
              ...(doc.fileSaveError || record.fileSaveError
                ? {
                    saveState: record.fileSaveError
                      ? ("error" as const)
                      : doc.saveState === "saving"
                        ? ("saving" as const)
                        : ("saved" as const),
                    saveError: record.fileSaveError,
                  }
                : {}),
            };
          }),
          ...records
            .filter(
              (record) =>
                !ids.has(record.id) && !deletingRecords.current.has(record.id),
            )
            .map(storedDocument),
        ];
      });
    },
    [sync, setDocuments],
  );

  const refreshWorkspaceSettings = useCallback(async () => {
    const state = await workspaceApi.load();
    applySettings(state.settings);
    mergeHistoryRecords(state.records);
  }, [workspaceApi, applySettings, mergeHistoryRecords]);

  const flushSettings = useCallback(
    async (strict = false): Promise<void> => {
      clearTimeout(settingsTimer.current);
      if (settingsOperation.current) {
        await settingsOperation.current;
        if (Object.keys(pendingSettings.current).length)
          await flushSettings(strict);
        if (strict && Object.keys(failedSettings.current).length)
          throw new Error(settingsFailure.current || t("设置尚未保存。"));
        return;
      }
      if (strict && Object.keys(failedSettings.current).length) {
        pendingSettings.current = {
          ...failedSettings.current,
          ...pendingSettings.current,
        };
        failedSettings.current = {};
      }
      const run = async () => {
        while (Object.keys(pendingSettings.current).length) {
          const patch = pendingSettings.current;
          const previousHistoryDirectory = settingsRef.current.historyDirectory;
          const reviveBefore = deletionSequence.current;
          pendingSettings.current = {};
          setSettingsBusy(true);
          try {
            if (patch.historyDirectory !== undefined)
              await sync.flushAll().catch(() => {});
            const saved = await workspaceApi.updateSettings(patch);
            for (const key of Object.keys(patch) as (keyof WorkspaceSettings)[])
              delete failedSettings.current[key];
            settingsRef.current = saved;
            setSettings(saved);
            setSettingsDraft((previous) => {
              const next = { ...previous };
              for (const key of Object.keys(
                saved,
              ) as (keyof WorkspaceSettings)[]) {
                if (
                  patch[key] !== undefined &&
                  previous[key] === patch[key] &&
                  pendingSettings.current[key] === undefined
                )
                  Object.assign(next, { [key]: saved[key] });
              }
              settingsDraftRef.current = next;
              return next;
            });
            if (!Object.keys(failedSettings.current).length) {
              settingsFailure.current = "";
              setSettingsError("");
            }
            if (patch.historyDirectory !== undefined) {
              const state = await workspaceApi.load();
              mergeHistoryRecords(
                state.records,
                saved.historyDirectory !== previousHistoryDirectory
                  ? reviveBefore
                  : undefined,
              );
              await sync.flushAll();
            }
            if (patch.writeDirectory !== undefined) {
              await sync.flushAll().catch(() => {});
              const state = await workspaceApi.load();
              mergeHistoryRecords(state.records);
            }
          } catch (error) {
            failedSettings.current = { ...failedSettings.current, ...patch };
            settingsFailure.current = errorMessage(error);
            setSettingsError(settingsFailure.current);
          }
        }
        setSettingsBusy(Boolean(directoryOperation.current));
      };
      settingsOperation.current = run().finally(() => {
        settingsOperation.current = undefined;
      });
      await settingsOperation.current;
      if (strict && Object.keys(failedSettings.current).length)
        throw new Error(settingsFailure.current || t("设置尚未保存。"));
    },
    [workspaceApi, mergeHistoryRecords, sync],
  );

  function updatePaths(patch: Partial<WorkspaceSettings>) {
    const next = { ...settingsDraftRef.current, ...patch };
    settingsDraftRef.current = next;
    setSettingsDraft(next);
    pendingSettings.current = {
      ...failedSettings.current,
      ...pendingSettings.current,
      ...patch,
    };
    failedSettings.current = {};
    settingsFailure.current = "";
    setSettingsError("");
    setSettingsBusy(true);
    clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      void flushSettings();
    }, 450);
  }

  async function browseDirectory(kind: DirectoryKind) {
    if (directoryOperation.current) return directoryOperation.current;
    await flushSettings();
    const requestDraft = { ...settingsDraftRef.current };
    const previousSettings = { ...settingsRef.current };
    const reviveBefore = deletionSequence.current;
    const field: keyof WorkspaceSettings =
      kind === "read"
        ? "readDirectory"
        : kind === "write"
          ? "writeDirectory"
          : "historyDirectory";
    setSettingsBusy(true);
    const operation = async () => {
      try {
        const next = await workspaceApi.chooseDirectory(kind);
        if (next) {
          settingsRef.current = next;
          setSettings(next);
          delete failedSettings.current[field];
          setSettingsDraft((previous) => {
            const merged = { ...next };
            for (const key of Object.keys(
              next,
            ) as (keyof WorkspaceSettings)[]) {
              if (
                previous[key] !== requestDraft[key] ||
                pendingSettings.current[key] !== undefined ||
                (key !== field && previous[key] !== previousSettings[key])
              )
                Object.assign(merged, { [key]: previous[key] });
            }
            settingsDraftRef.current = merged;
            return merged;
          });
          if (!Object.keys(failedSettings.current).length) {
            settingsFailure.current = "";
            setSettingsError("");
          }
          if (kind === "history") {
            const state = await workspaceApi.load();
            mergeHistoryRecords(
              state.records,
              next.historyDirectory !== previousSettings.historyDirectory
                ? reviveBefore
                : undefined,
            );
            await sync.flushAll();
          }
          if (kind === "write") {
            await sync.flushAll().catch(() => {});
            const state = await workspaceApi.load();
            mergeHistoryRecords(state.records);
          }
        }
      } catch (error) {
        setSettingsError(errorMessage(error));
      } finally {
        setSettingsBusy(
          Boolean(settingsOperation.current) ||
            Boolean(Object.keys(pendingSettings.current).length),
        );
      }
    };
    directoryOperation.current = operation().finally(() => {
      directoryOperation.current = undefined;
    });
    return directoryOperation.current;
  }

  function restoreSavedPaths() {
    clearTimeout(settingsTimer.current);
    pendingSettings.current = {};
    failedSettings.current = {};
    settingsFailure.current = "";
    settingsDraftRef.current = settingsRef.current;
    setSettingsDraft(settingsRef.current);
    setSettingsError("");
    setSettingsBusy(false);
  }

  const addImported = useCallback(
    (files: ImportedFile[]) => {
      if (!files.length) return;
      if (!readyRef.current) {
        pendingOpenedFiles.current.push(...files);
        return;
      }
      const added: WorkDocument[] = files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        raw: file.content,
        revision: 0,
        source: "imported",
        status: file.error
          ? "error"
          : file.content.trim()
            ? "pending"
            : "empty",
        importError: file.error,
        sourcePath: file.filePath,
        fileStorageError: file.storageError,
        options: { ...optionsRef.current },
        loaded: true,
      }));
      setDocuments((previous) => [...previous, ...added]);
      setActiveId(added[0].id);
      setComparisonOpen(false);
      setLogExtractionOpen(false);
      setSettingsOpen(false);
      setFocusedPane(null);
      setDiffSnapshot(undefined);
      setSelectedChange(undefined);
      setSelection(undefined);
      activeRef.current = added[0].id;
      for (const doc of added) void formatDocument(doc, undefined, true);
      void refreshWorkspaceSettings().catch((error) =>
        notify(errorMessage(error)),
      );
      notify(t("已导入 {{count}} 个文件", { count: files.length }));
    },
    [formatDocument, notify, refreshWorkspaceSettings, setDocuments],
  );

  const importBrowserFiles = useCallback(
    (files: FileList | File[]) => {
      const all = Array.from(files);
      const accepted = all.filter((file) => /\.json$/i.test(file.name));
      const run = async () => {
        let imported: ImportedFile[];
        if (window.desktop && accepted.length) {
          const desktop = window.desktop;
          notify(t("正在读取并保存文件…"));
          const paths = accepted.map((file) => {
            try {
              return desktop.getPathForFile(file);
            } catch {
              return "";
            }
          });
          await directoryOperation.current;
          await flushSettings(true);
          const loaded = await desktop.importDroppedFiles(
            paths.filter(Boolean),
          );
          let index = 0;
          imported = accepted.map((file, position) =>
            paths[position]
              ? loaded[index++]
              : {
                  name: file.name,
                  content: "",
                  error: t("无法获取文件路径，请重新拖入本地 JSON 文件。"),
                },
          );
        } else {
          imported = await Promise.all(
            accepted.map(async (file): Promise<ImportedFile> => {
              try {
                if (file.size > MAX_FILE_BYTES)
                  throw new Error(t("文件超过 20 MiB，请缩小后重试。"));
                const content = new TextDecoder("utf-8", {
                  fatal: true,
                }).decode(await file.arrayBuffer());
                return { name: file.name, content };
              } catch (error) {
                return {
                  name: file.name,
                  content: "",
                  error:
                    error instanceof TypeError
                      ? t("无法读取 UTF-8 文本，请转换文件编码后导入。")
                      : errorMessage(error),
                };
              }
            }),
          );
        }
        addImported(imported);
        const storageFailures = imported.filter(
          (file) => file.storageError,
        ).length;
        const skipped = all.length - accepted.length;
        if (storageFailures || skipped) {
          notify(
            t(
              storageFailures && skipped
                ? "已创建 {{count}} 个输入，{{failed}} 个文件未能保存到存储目录，跳过 {{skipped}} 个非 JSON 文件"
                : storageFailures
                  ? "已创建 {{count}} 个输入，{{failed}} 个文件未能保存到存储目录"
                  : "已创建 {{count}} 个输入，跳过 {{skipped}} 个非 JSON 文件",
              { count: imported.length, failed: storageFailures, skipped },
            ),
          );
        }
        if (fileInput.current) fileInput.current.value = "";
      };
      const operation = run()
        .catch((error) => notify(errorMessage(error)))
        .finally(() => {
          importOperations.current.delete(operation);
        });
      importOperations.current.add(operation);
      return operation;
    },
    [addImported, notify, flushSettings],
  );

  const openFiles = useCallback(async () => {
    if (!readyRef.current) return;
    if (!window.desktop) {
      fileInput.current?.click();
      return;
    }
    try {
      await flushSettings(true);
      addImported(await window.desktop.openFiles());
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [addImported, notify, flushSettings]);

  const newDocument = useCallback(async () => {
    if (!readyRef.current) return;
    try {
      await flushSettings(true);
    } catch (error) {
      setSettingsOpen(true);
      notify(errorMessage(error));
      return;
    }
    let timestamp = Date.now();
    let name: string;
    do {
      name = `untitled-${timestamp++}.json`;
    } while (
      documentsRef.current.some(
        (doc) => doc.name.toLowerCase() === name.toLowerCase(),
      )
    );
    const doc: WorkDocument = {
      id: crypto.randomUUID(),
      name,
      raw: "",
      revision: 0,
      source: "scratch",
      status: "empty",
      options: { ...optionsRef.current },
      loaded: true,
    };
    setDocuments((previous) => [...previous, doc]);
    setActiveId(doc.id);
    setComparisonOpen(false);
    setLogExtractionOpen(false);
    setSettingsOpen(false);
    setFocusedPane(null);
    setDiffSnapshot(undefined);
    setSelection(undefined);
    setSelectedChange(undefined);
    notify("");
  }, [notify, flushSettings]);

  const migrateLogItems = useCallback(
    (items: LogJsonCandidate[], importedOptions: FormatOptions) => {
      if (migrationOperation.current) return migrationOperation.current;
      const operation = (async () => {
        if (!readyRef.current || closing.current)
          throw new Error(t("工作区尚未就绪，请稍后重试。"));
        await flushSettings(true);
        let timestamp = Date.now();
        for (const item of items) {
          if (!item.result.success || !item.result.output.trim())
            throw new Error(t("只能迁移已成功提取的 JSON。"));
          if (
            new TextEncoder().encode(item.result.output).byteLength >
            MAX_FILE_BYTES
          )
            throw new Error(t("文件超过 20 MiB，请缩小后重试。"));
          const cached = migratedLogItems.current.get(item);
          let doc = cached
            ? documentsRef.current.find(
                (existing) =>
                  existing.id === cached && existing.raw === item.result.output,
              )
            : undefined;
          if (!doc) {
            let name: string;
            do {
              name = `extracted-${timestamp++}.json`;
            } while (
              documentsRef.current.some(
                (existing) =>
                  existing.name.toLowerCase() === name.toLowerCase(),
              )
            );
            doc = {
              id: crypto.randomUUID(),
              name,
              raw: item.result.output,
              revision: 0,
              source: "scratch",
              status: "pending",
              options: { ...importedOptions },
              loaded: true,
            };
            migratedLogItems.current.set(item, doc.id);
            setDocuments((previous) => [...previous, doc!]);
          }
          sync.schedule(historySnapshot(doc));
          await sync.flush(doc.id);
          if (doc.status === "pending") await formatDocument(doc);
        }
        notify(
          t("已将 {{count}} 项 JSON 保存至工作区", { count: items.length }),
        );
      })();
      const tracked = operation.finally(() => {
        importOperations.current.delete(tracked);
        migrationOperation.current = undefined;
      });
      migrationOperation.current = tracked;
      importOperations.current.add(tracked);
      return tracked;
    },
    [flushSettings, formatDocument, notify, setDocuments, sync],
  );

  const formatCurrent = useCallback(() => {
    if (logExtractionMode.current) {
      logExtraction.current?.extract();
      return;
    }
    if (comparisonMode.current) {
      comparison.current?.compare();
      return;
    }
    const doc = documentsRef.current.find(
      (item) => item.id === activeRef.current,
    );
    if (!doc || doc.status === "processing") return;
    setSelection(undefined);
    setSelectedChange(undefined);
    void formatDocument(doc, undefined, true);
  }, [formatDocument]);

  const exportCurrent = useCallback(async () => {
    if (comparisonMode.current || logExtractionMode.current) return;
    const doc = documentsRef.current.find(
      (item) => item.id === activeRef.current,
    );
    if (doc?.status !== "done" || !doc.result?.success) return;
    const suffix = doc.extraction
      ? "." + doc.extraction.key.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 50)
      : "";
    const name = doc.name.replace(/\.json$/i, "") + suffix + ".formatted.json";
    const content = doc.result.output + "\n";
    try {
      if (window.desktop) {
        const saved = await window.desktop.saveFile({ name, content });
        if (!saved.canceled) {
          notify(t("已导出 {{name}}", { name }));
          void refreshWorkspaceSettings().catch((error) =>
            notify(errorMessage(error)),
          );
        }
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: "application/json;charset=utf-8" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        notify(t("已导出 {{name}}", { name }));
      }
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify, refreshWorkspaceSettings]);

  const menuCommands = useRef({ newDocument, formatCurrent, exportCurrent });
  menuCommands.current = { newDocument, formatCurrent, exportCurrent };

  const bootstrap = useCallback(async () => {
    const generation = ++bootstrapGeneration.current;
    jobs.current.clear();
    setStorageError("");
    readyRef.current = false;
    setStorageReady(false);
    try {
      const state = await workspaceApi.load();
      if (generation !== bootstrapGeneration.current) return;
      settingsRef.current = state.settings;
      settingsDraftRef.current = state.settings;
      setSettings(state.settings);
      setSettingsDraft(state.settings);
      for (const record of state.records) sync.adopt(record);
      const next: WorkDocument[] = state.initialized
        ? state.records.map(storedDocument)
        : samples.map((doc) => ({
            ...doc,
            options: { ...defaultOptions },
            loaded: true,
          }));
      setDocuments(next);
      const chosen = next.find((doc) => doc.id === state.activeId) ?? next[0];
      const id = chosen?.id ?? draft.id;
      activeRef.current = id;
      setActiveId(id);
      lastActiveSaved.current = state.activeId;
      if (!state.initialized) {
        for (const doc of next) sync.schedule(historySnapshot(doc));
        await sync.flushAll();
      }
      if (generation !== bootstrapGeneration.current) return;
      readyRef.current = true;
      setStorageReady(true);
      const selected =
        chosen?.loaded === false ? await hydrateDocument(chosen.id) : chosen;
      if (selected) {
        const nextOptions = selected.options ?? defaultOptions;
        optionsRef.current = nextOptions;
        setOptions(nextOptions);
        void formatDocument(selected);
      }
      const opened = window.desktop ? await window.desktop.ready() : [];
      addImported([...pendingOpenedFiles.current.splice(0), ...opened]);
    } catch (error) {
      if (generation !== bootstrapGeneration.current) return;
      readyRef.current = false;
      setStorageReady(false);
      setStorageError(
        t("无法读取转换历史：{{message}}", {
          message: localizeMessage(errorMessage(error)),
        }),
      );
    }
  }, [
    workspaceApi,
    sync,
    setDocuments,
    draft.id,
    hydrateDocument,
    formatDocument,
    addImported,
  ]);

  const queueCurrentDocuments = useCallback(() => {
    if (!readyRef.current) return;
    for (const doc of documentsRef.current)
      if (doc.loaded !== false && !deletingRecords.current.has(doc.id))
        sync.schedule(historySnapshot(doc));
  }, [sync]);

  useEffect(() => {
    void bootstrap();
    const desktop = window.desktop;
    const removeFiles = desktop?.onOpenFiles(addImported);
    const removeMenu = desktop?.onMenuAction((action) => {
      if (deletePrompt.current) return;
      if (action === "new") menuCommands.current.newDocument();
      if (action === "format") menuCommands.current.formatCurrent();
      if (action === "export") void menuCommands.current.exportCurrent();
    });
    return () => {
      bootstrapGeneration.current++;
      queueCurrentDocuments();
      void sync.flushAll().catch(() => {});
      void flushSettings();
      readyRef.current = false;
      removeFiles?.();
      removeMenu?.();
      client.dispose();
      sync.dispose();
      clearTimeout(feedbackTimer.current);
      clearTimeout(settingsTimer.current);
    };
  }, [
    bootstrap,
    addImported,
    client,
    sync,
    queueCurrentDocuments,
    flushSettings,
  ]);

  useEffect(() => {
    if (!storageReady) return;
    queueCurrentDocuments();
    const active = documents.find((doc) => doc.id === activeId);
    if (active?.saveState === "error" && !active.fileSaveError) return;
    const id = active?.id ?? null;
    if (lastActiveSaved.current === id) return;
    lastActiveSaved.current = id;
    const sequence = ++activeSaveSequence.current;
    const operation = (async () => {
      if (id) {
        try {
          await sync.flush(id);
        } catch (error) {
          const doc = documentsRef.current.find((item) => item.id === id);
          if (!doc?.persisted || !doc.fileSaveError) throw error;
        }
      }
      if (sequence === activeSaveSequence.current)
        await workspaceApi.setActive(id);
    })().catch((error) => {
      if (sequence === activeSaveSequence.current) {
        lastActiveSaved.current = undefined;
        notify(errorMessage(error));
      }
    });
    activeOperation.current = operation;
    void operation.finally(() => {
      if (activeOperation.current === operation)
        activeOperation.current = undefined;
    });
  }, [
    documents,
    activeId,
    storageReady,
    queueCurrentDocuments,
    sync,
    workspaceApi,
    notify,
  ]);

  useEffect(() => {
    if (
      !storageReady ||
      current.loaded === false ||
      current.status !== "pending" ||
      !current.raw.trim() ||
      current.importError
    )
      return;
    const timer = setTimeout(() => {
      void formatDocument(
        current,
        undefined,
        Boolean(current.autoCopyRequested),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [
    storageReady,
    current.id,
    current.raw,
    current.revision,
    current.status,
    current.options,
    current.loaded,
    current.importError,
    current.autoCopyRequested,
    current.keyQuery,
    current.autoExtract,
    formatDocument,
  ]);

  useEffect(() => {
    const preference = settingsDraft.recursiveUnescape ?? true;
    if (!storageReady) {
      lastRecursivePreference.current = undefined;
      return;
    }
    if (lastRecursivePreference.current === undefined) {
      lastRecursivePreference.current = preference;
      return;
    }
    if (lastRecursivePreference.current === preference) return;
    lastRecursivePreference.current = preference;
    clipboardGeneration.current++;
    jobs.current.clear();
    setDocuments((previous) =>
      previous.map((doc) =>
        doc.loaded === false ||
        doc.importError ||
        !doc.raw.trim() ||
        doc.deleting
          ? doc
          : {
              ...doc,
              status: "pending",
              result: undefined,
              autoCopyRequested:
                !comparisonMode.current &&
                !logExtractionMode.current &&
                doc.id === activeRef.current,
            },
      ),
    );
    setSelectedChange(undefined);
    setSelection(undefined);
    const active = documentsRef.current.find(
      (doc) => doc.id === activeRef.current,
    );
    if (active) void formatDocument(active, undefined, true);
  }, [
    settingsDraft.recursiveUnescape,
    storageReady,
    formatDocument,
    setDocuments,
  ]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (closeAllowed.current || !readyRef.current) return;
      queueCurrentDocuments();
      const active = documentsRef.current.some(
        (doc) => doc.id === activeRef.current,
      )
        ? activeRef.current
        : null;
      if (
        !sync.hasPending() &&
        !Object.keys(pendingSettings.current).length &&
        !Object.keys(failedSettings.current).length &&
        !settingsOperation.current &&
        !directoryOperation.current &&
        !importOperations.current.size &&
        !clipboardPending.current &&
        !activeOperation.current &&
        lastActiveSaved.current === active
      )
        return;
      event.preventDefault();
      event.returnValue = false;
      if (closing.current) return;
      closing.current = true;
      void (async () => {
        while (importOperations.current.size)
          await Promise.all([...importOperations.current]);
        queueCurrentDocuments();
        await sync.flushAll();
        await directoryOperation.current;
        await flushSettings(true);
        await clipboardQueue.current;
        await activeOperation.current;
        const id = documentsRef.current.some(
          (doc) => doc.id === activeRef.current,
        )
          ? activeRef.current
          : null;
        if (id) await sync.flush(id);
        await workspaceApi.setActive(id);
        lastActiveSaved.current = id;
        closeAllowed.current = true;
        await workspaceApi.requestClose();
      })().catch((error) => {
        closing.current = false;
        notify(
          t("自动保存未完成：{{message}}", {
            message: localizeMessage(errorMessage(error)),
          }),
        );
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [queueCurrentDocuments, sync, flushSettings, workspaceApi, notify]);

  useEffect(() => {
    if (window.desktop) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        formatCurrent();
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openFiles();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        newDocument();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void exportCurrent();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exportCurrent, formatCurrent, newDocument, openFiles]);

  const updateInput = useCallback(
    (raw: string) => {
      if (!readyRef.current) return;
      if (documentsRef.current.find((doc) => doc.id === activeId)?.deleting)
        return;
      if (documentsRef.current.find((doc) => doc.id === activeId)?.raw === raw)
        return;
      setDocuments((previous) => {
        const existing = previous.find((doc) => doc.id === activeId);
        const update = (doc: WorkDocument): WorkDocument => {
          if (doc.id !== activeId && existing) return doc;
          const query =
            doc.keyQuery ??
            doc.extraction?.key ??
            doc.savedExtraction?.key ??
            "";
          const preferred = doc.extraction
            ? savedValue(doc.extraction)
            : doc.savedExtraction;
          return {
            ...doc,
            raw,
            revision: doc.revision + 1,
            status: raw.trim() ? "pending" : "empty",
            result: undefined,
            importError: undefined,
            cleared: undefined,
            extraction: undefined,
            savedExtraction: preferred?.key === query ? preferred : undefined,
            keyQuery: query,
            keySearch: undefined,
            autoExtract: Boolean(query.length),
            options: { ...optionsRef.current },
            autoCopyRequested: true,
            loaded: true,
          };
        };
        if (existing) return previous.map(update);
        activeRef.current = draft.id;
        setActiveId(draft.id);
        return [...previous, update(draft)];
      });
      setSelection(undefined);
      setSelectedChange(undefined);
      setDiffSnapshot(undefined);
    },
    [activeId, draft, setDocuments],
  );

  function clearInput() {
    if (!readyRef.current || !current.raw) return;
    setDocuments((previous) =>
      previous.map((doc) =>
        doc.id === activeId
          ? {
              ...doc,
              cleared: doc.raw,
              raw: "",
              revision: doc.revision + 1,
              status: "empty",
              result: undefined,
              importError: undefined,
              extraction: undefined,
              savedExtraction: undefined,
              keyQuery:
                doc.keyQuery ??
                doc.extraction?.key ??
                doc.savedExtraction?.key ??
                "",
              keySearch: undefined,
              autoExtract: false,
            }
          : doc,
      ),
    );
    setSelection(undefined);
    setSelectedChange(undefined);
    setDiffSnapshot(undefined);
    notify(t("输入已清空，可点击恢复按钮撤回。"));
  }

  function updateOption<K extends keyof FormatOptions>(
    key: K,
    value: FormatOptions[K],
  ) {
    if (!readyRef.current || current.loaded === false) return;
    const next = { ...optionsRef.current, [key]: value };
    jobs.current.delete(current.id);
    optionsRef.current = next;
    setOptions(next);
    setDocuments((previous) =>
      previous.map((doc) =>
        doc.id !== current.id || doc.importError
          ? doc
          : {
              ...doc,
              status: doc.raw.trim() ? "pending" : "empty",
              result: undefined,
              options: next,
              keyQuery:
                doc.keyQuery ??
                doc.extraction?.key ??
                doc.savedExtraction?.key ??
                "",
              keySearch: undefined,
              autoExtract: key === "indent" && Boolean(doc.autoExtract),
              ...(key !== "indent"
                ? { extraction: undefined, savedExtraction: undefined }
                : {}),
            },
      ),
    );
    setSelectedChange(undefined);
    setSelection(undefined);
    setDiffSnapshot(undefined);
    void formatDocument(
      { ...current, options: next },
      key === "indent" ? undefined : null,
      true,
    );
    if (key !== "indent" && current.extraction)
      notify(t("处理选项已变更，已返回完整 JSON。"));
  }

  async function searchKey(key: string) {
    return client.findKey(current.raw, key, { ...optionsRef.current });
  }

  function updateKeyQuery(query: string) {
    const doc = documentsRef.current.find((item) => item.id === current.id);
    const restart =
      doc?.autoExtract &&
      (doc.status === "pending" || doc.status === "processing");
    if (restart) jobs.current.delete(current.id);
    setDocuments((previous) =>
      previous.map((item) =>
        item.id === current.id
          ? {
              ...item,
              keyQuery: query,
              keySearch: undefined,
              ...(restart
                ? {
                    status: item.raw.trim()
                      ? ("pending" as const)
                      : ("empty" as const),
                    result: undefined,
                    extraction: undefined,
                    autoExtract: Boolean(query.length),
                    savedExtraction:
                      item.savedExtraction?.key === query
                        ? item.savedExtraction
                        : undefined,
                  }
                : {}),
            }
          : item,
      ),
    );
  }

  function extractValue(match: KeyMatch, search: KeySearchResult) {
    const doc = documentsRef.current.find(
      (item) => item.id === current.id && item.revision === current.revision,
    );
    if (!doc || !search.preparation.success) return;
    const extraction = selectedValue(match, search);
    setSelection(undefined);
    setSelectedChange(undefined);
    setDiffSnapshot(undefined);
    void formatDocument(doc, extraction, true);
  }

  function resetExtraction() {
    setSelection(undefined);
    setSelectedChange(undefined);
    setDiffSnapshot(undefined);
    void formatDocument(current, null, true);
  }

  function selectDocument(id: string) {
    setComparisonOpen(false);
    setLogExtractionOpen(false);
    setSettingsOpen(false);
    clipboardGeneration.current++;
    setDocuments((previous) =>
      previous.map((doc) =>
        doc.autoCopyRequested ? { ...doc, autoCopyRequested: false } : doc,
      ),
    );
    activeRef.current = id;
    setActiveId(id);
    setSelection(undefined);
    setSelectedChange(undefined);
    setDiffSnapshot(undefined);
    notify("");
    const doc = documentsRef.current.find((item) => item.id === id);
    if (doc?.options) {
      optionsRef.current = doc.options;
      setOptions(doc.options);
    }
    if (doc?.loaded === false)
      void hydrateDocument(id).then((loaded) => {
        if (loaded) void formatDocument(loaded);
      });
  }

  async function renameDocument(id: string, name: string) {
    queueCurrentDocuments();
    try {
      const renamed = await sync.rename(id, name);
      setDocuments((previous) =>
        previous.map((doc) =>
          doc.id === id
            ? {
                ...doc,
                name: renamed.name,
                sourcePath: renamed.sourcePath,
                managedPath: renamed.managedPath,
                fileSaveError: renamed.fileSaveError,
                updatedAt: renamed.updatedAt,
              }
            : doc,
        ),
      );
      notify(t("已重命名为 {{name}}", { name: renamed.name }));
    } catch (error) {
      notify(errorMessage(error));
      throw error;
    }
  }

  async function pinDocument(id: string, pinned: boolean) {
    queueCurrentDocuments();
    const saved = await sync.setPinned(id, pinned);
    setDocuments((previous) =>
      previous.map((doc) =>
        doc.id === id ? { ...doc, pinned: saved.pinned } : doc,
      ),
    );
  }

  async function deleteDocument(id: string) {
    const hasFile = Boolean(
      documentsRef.current.find((doc) => doc.id === id)?.managedPath,
    );
    deletingRecords.current.add(id);
    deletedAt.current.set(id, ++deletionSequence.current);
    jobs.current.delete(id);
    setDocuments((previous) =>
      previous.map((doc) => (doc.id === id ? { ...doc, deleting: true } : doc)),
    );
    try {
      queueCurrentDocuments();
      await Promise.allSettled(
        documentsRef.current
          .filter((doc) => doc.id !== id)
          .map((doc) => sync.flush(doc.id)),
      );
      await sync.remove(id);
      const remaining = documentsRef.current.filter((doc) => doc.id !== id);
      setDocuments(remaining);
      if (activeRef.current === id) {
        const next = remaining[0];
        activeRef.current = next?.id ?? draft.id;
        setActiveId(next?.id ?? draft.id);
        optionsRef.current = next?.options ?? defaultOptions;
        setOptions(next?.options ?? defaultOptions);
        setSelection(undefined);
        setSelectedChange(undefined);
        setDiffSnapshot(undefined);
        if (next?.loaded === false)
          void hydrateDocument(next.id).then((doc) => {
            if (doc) void formatDocument(doc);
          });
      }
      notify(t(hasFile ? "已删除记录及关联文件" : "已删除历史记录"));
    } catch (error) {
      deletingRecords.current.delete(id);
      deletedAt.current.delete(id);
      setDocuments((previous) =>
        previous.map((doc) =>
          doc.id === id
            ? {
                ...doc,
                deleting: false,
                status: doc.status === "processing" ? "pending" : doc.status,
              }
            : doc,
        ),
      );
      queueCurrentDocuments();
      notify(errorMessage(error));
      throw error;
    }
  }

  function requestDeleteDocument(id: string): Promise<boolean> {
    if (
      deletePrompt.current ||
      !documentsRef.current.some((doc) => doc.id === id)
    )
      return Promise.resolve(false);
    return new Promise((resolve) => {
      deletePrompt.current = { id, confirming: false, resolve };
      dragDepth.current = 0;
      setDragging(false);
      setDeleteError("");
      setDeleteBusy(false);
      setDeleteTargetId(id);
    });
  }

  function cancelDeleteDocument() {
    const prompt = deletePrompt.current;
    if (!prompt || prompt.confirming) return;
    deletePrompt.current = null;
    setDeleteTargetId(null);
    setDeleteError("");
    prompt.resolve(false);
  }

  async function confirmDeleteDocument() {
    const prompt = deletePrompt.current;
    const doc = documentsRef.current.find((item) => item.id === prompt?.id);
    if (!prompt || prompt.confirming || !doc || doc.saveState === "saving")
      return;
    prompt.confirming = true;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteDocument(prompt.id);
      deletePrompt.current = null;
      setDeleteTargetId(null);
      prompt.resolve(true);
    } catch (error) {
      prompt.confirming = false;
      setDeleteError(errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  function closeDiffPage() {
    setDiffSnapshot(undefined);
    requestAnimationFrame(() => {
      const origin = diffReturnFocus.current;
      if (origin?.isConnected) origin.focus({ preventScroll: true });
      else
        applicationRef.current
          ?.querySelector<HTMLElement>(
            '[data-testid="input-editor"] .cm-content',
          )
          ?.focus({ preventScroll: true });
    });
  }

  function openRepairDiff(change?: RepairRecordChange) {
    if (!repairRecords.stages.length) return;
    diffReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDiffSnapshot({
      documentId: current.id,
      name: current.name,
      filePath: current.managedPath ?? current.sourcePath,
      extractionPath: current.extraction?.path,
      revision: current.revision,
      stages: repairRecords.stages,
      initialStageId: change?.stageId,
      initialChangeId: change?.id,
      key: ++diffSequence.current,
    });
  }

  function selectRepair(change: RepairRecordChange) {
    setSelectedChange({ ...change });
    const location = repairLocations.get(change.id);
    if (!location) {
      notify(t("无法定位原文，请查看差异。"));
      return;
    }
    setSelection({
      from: location.from,
      to: location.to,
      key: ++selectionCounter.current,
    });
    requestAnimationFrame(() =>
      applicationRef.current
        ?.querySelector<HTMLElement>('[data-testid="input-editor"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
    notify(
      t(
        location.exact
          ? "已定位原文 {{line}}:{{column}}"
          : "已定位原文字段 {{line}}:{{column}}，内部修复请查看差异。",
        { line: location.line, column: location.column },
      ),
    );
  }

  async function copyOutput() {
    const doc = documentsRef.current.find(
      (item) => item.id === activeRef.current,
    );
    if (doc?.status !== "done" || !doc.result?.success) return false;
    return copyResult(doc.result.output);
  }

  async function formatAll() {
    const loaded = await Promise.all(
      documentsRef.current.map((doc) =>
        doc.loaded === false ? hydrateDocument(doc.id) : doc,
      ),
    );
    const all = loaded.filter((doc): doc is WorkDocument =>
      Boolean(
        doc &&
        doc.raw.trim() &&
        !doc.importError &&
        doc.status !== "processing",
      ),
    );
    const processed = await Promise.all(
      all.map((doc) => formatDocument(doc, undefined, true)),
    );
    const failures = processed.filter((item) => item && !item.success).length;
    notify(
      t("已处理 {{count}} 个文件{{failures}}", {
        count: processed.filter(Boolean).length,
        failures: failures
          ? t("，其中 {{count}} 个无法格式化", { count: failures })
          : "",
      }),
    );
  }

  const arrayDecoding = result?.arrayDecoding;
  const stateKind =
    storageError || current.status === "error"
      ? "error"
      : current.status === "done"
        ? repairRecords.stages.length || arrayDecoding?.failedItems
          ? "repair"
          : "ok"
        : "pending";
  let statusMessage = t("粘贴内容或导入文件，开始整理 JSON");
  if (!storageReady) statusMessage = storageError || t("正在载入转换历史…");
  const deleteTarget = documents.find((doc) => doc.id === deleteTargetId);

  const openSettings = () => {
    if (
      !settingsOpen &&
      !Object.keys(pendingSettings.current).length &&
      !Object.keys(failedSettings.current).length
    ) {
      setSettingsDraft(settingsRef.current);
      settingsDraftRef.current = settingsRef.current;
    }
    setSettingsOpen(true);
  };
  if (current.status === "loading" || current.status === "stored")
    statusMessage = t("正在载入历史记录…");
  if (current.status === "processing") statusMessage = t("正在处理 JSON…");
  if (current.status === "pending")
    statusMessage = t("输入已更新，正在自动格式化…");
  if (current.status === "error")
    statusMessage = t("无法格式化 · {{message}}", {
      message: localizeMessage(
        current.importError ||
          result?.error?.message ||
          t("请检查输入内容后重试。"),
      ),
    });
  if (hasOutput)
    statusMessage = repairRecords.stages.length
      ? repairRecords.changeCount === null
        ? t("修复完成 · 请核对完整差异")
        : t("修复完成 · {{count}} 处文本变更", {
            count: repairRecords.changeCount,
          })
      : arrayDecoding?.decodedItems
        ? t("已递归展开 {{count}} 个 JSON 字符串，格式化完成", {
            count: arrayDecoding.decodedItems,
          })
        : result.decodedLayers
          ? t("已去转义 {{count}} 层，格式化完成", {
              count: result.decodedLayers,
            })
          : t("格式化完成，JSON 语法有效");
  if (hasOutput && arrayDecoding?.failedItems)
    statusMessage = t("{{message}} · {{count}} 项未展开", {
      message: statusMessage,
      count: arrayDecoding.failedItems,
    });
  const changes = repairRecords.changes;
  const lineCount = hasOutput ? result.output.split("\n").length : 0;
  const characterCount =
    current.loaded === false ? (current.characters ?? 0) : current.raw.length;
  const currentError = result?.error;
  const canRetryFormatting =
    storageReady &&
    current.loaded !== false &&
    !current.deleting &&
    current.status === "error" &&
    !current.importError &&
    Boolean(current.raw.trim());
  const autosaveState = current.saveState ?? "idle";
  const autosaveLabel = !storageReady
    ? t("正在载入历史")
    : current.saveState === "error"
      ? t("自动保存失败")
      : current.saveState === "saving"
        ? t("正在自动保存…")
        : current.persisted
          ? t("已自动保存")
          : t("修改后自动保存");
  if (!storageReady) statusMessage = storageError || t("正在载入转换历史…");

  return (
    <div
      ref={applicationRef}
      className={`application platform-${platform}`}
      data-focused-pane={
        settingsOpen || comparisonOpen || logExtractionOpen || diffSnapshot
          ? undefined
          : (focusedPane ?? undefined)
      }
      data-page={
        settingsOpen
          ? "settings"
          : comparisonOpen
            ? "comparison"
            : logExtractionOpen
              ? "log-extraction"
              : diffSnapshot
                ? "diff"
                : "workspace"
      }
      data-sidebar-collapsed={sidebarHidden ? "true" : undefined}
      onDragEnterCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (deletePrompt.current) return;
        dragDepth.current++;
        if (!comparisonOpen || settingsOpen) setDragging(true);
      }}
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = deletePrompt.current
            ? "none"
            : "copy";
        }
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (deletePrompt.current) return;
        dragDepth.current = 0;
        setDragging(false);
        if (comparisonOpen && !settingsOpen) {
          const target = event.target instanceof Element ? event.target : null;
          const side = target?.closest('[data-testid="comparison-left"]')
            ? "left"
            : target?.closest('[data-testid="comparison-right"]')
              ? "right"
              : undefined;
          comparison.current?.importFiles(
            Array.from(event.dataTransfer.files),
            side,
          );
        } else void importBrowserFiles(event.dataTransfer.files);
      }}
    >
      <header className="titlebar">
        <div className="titlebar-navigation">
          <span className="native-controls-space" aria-hidden="true" />
          <button
            className="icon-button"
            aria-label={sidebarHidden ? t("展开侧栏") : t("收起侧栏")}
            title={sidebarHidden ? t("展开侧栏") : t("收起侧栏")}
            aria-expanded={!sidebarHidden}
            aria-controls="workspace-sidebar"
            onClick={() =>
              runSidebarTransition(() => {
                if (
                  applicationRef.current?.dataset.sidebarCollapsed === "true"
                ) {
                  setSidebarCollapsed(false);
                  if (!settingsOpen) {
                    setDiffSnapshot(undefined);
                    setFocusedPane(null);
                    logExtraction.current?.collapsePreview();
                    setLogPreviewExpanded(false);
                  }
                } else setSidebarCollapsed(true);
              })
            }
          >
            <PanelLeft size={17} />
          </button>
          {sidebarHidden && (
            <button
              className="icon-button"
              aria-label={t("新建输入")}
              title={t("新建输入（{{shortcut}}）", {
                shortcut: `${command} + N`,
              })}
              onClick={newDocument}
              disabled={!storageReady}
            >
              <SquarePen size={17} />
            </button>
          )}
        </div>
        <div className="titlebar-document">
          {settingsOpen ? (
            <Settings size={16} />
          ) : comparisonOpen ? (
            <Columns2 size={16} />
          ) : logExtractionOpen ? (
            <ScanText size={16} />
          ) : (
            <FileJson2 size={16} />
          )}
          {settingsOpen ? (
            <span className="window-name" data-testid="active-file-name">
              {t("应用设置")}
            </span>
          ) : comparisonOpen ? (
            <h1 className="window-name" data-testid="active-file-name">
              {t("JSON 对比")}
            </h1>
          ) : logExtractionOpen ? (
            <h1 className="window-name" data-testid="active-file-name">
              {t("JSON 提取")}
            </h1>
          ) : (
            <h1
              className="window-name"
              data-testid="active-file-name"
              title={
                diffSnapshot?.filePath ||
                (diffSnapshot
                  ? diffSnapshot.name
                  : current.managedPath || current.name)
              }
            >
              {diffSnapshot?.name ?? current.name}
            </h1>
          )}
        </div>
        <div className="titlebar-status">
          {sidebarHidden && (
            <button
              className="icon-button"
              aria-label={t("应用设置")}
              title={t("应用设置")}
              aria-current={settingsOpen ? "page" : undefined}
              disabled={!storageReady}
              onClick={openSettings}
            >
              <Settings size={16} />
            </button>
          )}
          <span className="local-label">
            <ShieldCheck size={13} />
            {t("本地处理")}
          </span>
        </div>
      </header>
      <div className="app-layout">
        <aside
          className="sidebar"
          id="workspace-sidebar"
          aria-label={t("文件工作区")}
        >
          <Brand />
          <div className="sidebar-create">
            <button
              className="button ghost full-width"
              disabled={!storageReady}
              onClick={() => void openFiles()}
            >
              <FolderOpen size={16} />
              {t("导入文件")}
            </button>
            <button
              className="button ghost full-width"
              onClick={newDocument}
              disabled={!storageReady}
            >
              <SquarePen size={16} />
              {t("新建输入")}
            </button>
            <button
              className="button ghost full-width comparison-entry"
              data-testid="open-comparison"
              disabled={!storageReady}
              aria-current={
                comparisonOpen && !settingsOpen ? "page" : undefined
              }
              onClick={() => {
                setComparisonVisited(true);
                setComparisonOpen(true);
                setLogExtractionOpen(false);
                setSettingsOpen(false);
                setFocusedPane(null);
                setDiffSnapshot(undefined);
                clipboardGeneration.current++;
              }}
            >
              <Columns2 size={16} />
              {t("JSON 对比")}
            </button>
            <button
              className="button ghost full-width log-extraction-entry"
              data-testid="open-log-extraction"
              disabled={!storageReady}
              aria-current={
                logExtractionOpen && !settingsOpen ? "page" : undefined
              }
              onClick={() => {
                setLogExtractionVisited(true);
                setLogExtractionOpen(true);
                setComparisonOpen(false);
                setSettingsOpen(false);
                setFocusedPane(null);
                setDiffSnapshot(undefined);
                clipboardGeneration.current++;
              }}
            >
              <ScanText size={16} />
              {t("JSON 提取")}
            </button>
          </div>
          <div className="file-section-header">
            <span>
              {t("转换历史")}
              <span className="file-count">{documents.length}</span>
            </span>
            <button
              className="icon-button"
              onClick={() => void formatAll()}
              aria-label={t("格式化全部文件")}
              title={t("格式化全部文件")}
            >
              <CheckCheck size={15} />
            </button>
          </div>
          <nav className="file-list" aria-label={t("JSON 文件")}>
            {historyDocuments.map((doc) => (
              <HistoryEntry
                key={doc.id}
                id={doc.id}
                name={doc.name}
                selected={
                  !comparisonOpen &&
                  !logExtractionOpen &&
                  !settingsOpen &&
                  doc.id === activeId
                }
                status={
                  doc.saveState === "error"
                    ? t("保存失败")
                    : doc.saveState === "saving"
                      ? t("正在保存")
                      : resultLabel(doc)
                }
                statusKind={
                  doc.saveState === "error" || doc.status === "error"
                    ? "error"
                    : doc.saveState === "saving"
                      ? "saving"
                      : doc.status === "processing"
                        ? "processing"
                        : getRepairSummary(
                              doc.result,
                              doc.extraction?.preparation,
                            ).stageCount ||
                            doc.result?.arrayDecoding?.failedItems
                          ? "repair"
                          : doc.status === "done" || doc.status === "stored"
                            ? "ok"
                            : "pending"
                }
                updatedAt={doc.updatedAt}
                pinned={doc.pinned}
                saveError={doc.saveError}
                onSelect={() => selectDocument(doc.id)}
                onRename={(name) => renameDocument(doc.id, name)}
                onDelete={() => requestDeleteDocument(doc.id)}
                onPin={(pinned) => pinDocument(doc.id, pinned)}
              />
            ))}
            {storageReady && !documents.length && (
              <div className="history-empty">
                {t("暂无转换历史，直接输入或新建记录即可自动保存。")}
              </div>
            )}
          </nav>
          <div className="sidebar-actions">
            <button
              className="button ghost full-width sidebar-settings"
              aria-label={t("应用设置")}
              aria-current={settingsOpen ? "page" : undefined}
              disabled={!storageReady}
              onClick={openSettings}
            >
              <Settings size={16} aria-hidden="true" />
              <span className="sidebar-settings-label">{t("应用设置")}</span>
              <span className="sidebar-version" aria-hidden="true">
                v{version}
              </span>
            </button>
          </div>
        </aside>
        <main
          className="workspace"
          hidden={
            settingsOpen ||
            comparisonOpen ||
            logExtractionOpen ||
            Boolean(diffSnapshot)
          }
        >
          <div className="workspace-filebar" data-testid="workspace-filebar">
            <span className="workspace-file-location">
              <HardDrive size={13} />
              {current.managedPath ? (
                <code
                  data-testid="managed-file-path"
                  title={current.managedPath}
                >
                  {current.managedPath}
                </code>
              ) : (
                t("内容在本机处理")
              )}
            </span>
            <span
              className={`autosave-status ${current.saveState === "error" ? "error" : ""}`}
              data-testid="autosave-status"
              data-save-state={autosaveState}
              role="status"
              aria-live="polite"
              title={
                current.saveError
                  ? localizeMessage(current.saveError)
                  : settings.historyDirectory
              }
            >
              {current.saveState === "saving" ? (
                <LoaderCircle size={12} className="spin" />
              ) : current.saveState === "error" ? (
                <CircleAlert size={12} />
              ) : (
                <Check size={12} />
              )}
              {localizeMessage(autosaveLabel)}
            </span>
            {canRetryFormatting && (
              <button
                className="button ghost retry-format"
                data-testid="retry-format-button"
                onClick={formatCurrent}
              >
                <RotateCw size={13} />
                {t("重试格式化")}
              </button>
            )}
          </div>
          <div className="toolbar">
            <div className="format-options">
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={options.autoUnescape}
                  title={t("去除当前 JSON 外层的字符串包装")}
                  onChange={(event) =>
                    updateOption("autoUnescape", event.target.checked)
                  }
                />
                {t("自动去转义")}
              </label>
              <label
                className="check-control"
                title={t(
                  options.autoUnescape
                    ? "展开对象字段和列表项中的嵌套 JSON 字符串"
                    : "开启自动去转义后生效，保留上次选择",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={t("递归去转义")}
                  checked={settingsDraft.recursiveUnescape ?? true}
                  disabled={!storageReady || !options.autoUnescape}
                  onChange={(event) =>
                    updatePaths({ recursiveUnescape: event.target.checked })
                  }
                />
                {t("递归去转义")}
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={options.repair}
                  onChange={(event) =>
                    updateOption("repair", event.target.checked)
                  }
                />
                {t("尝试修复")}
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  aria-label={t("格式化后自动复制")}
                  checked={settingsDraft.autoCopy}
                  disabled={!storageReady}
                  onChange={(event) => {
                    if (!event.target.checked) clipboardGeneration.current++;
                    updatePaths({ autoCopy: event.target.checked });
                  }}
                />
                {t("格式化后自动复制")}
              </label>
              <div className="indent-label">
                {t("缩进")}
                <Select
                  label={t("JSON 缩进")}
                  size="compact"
                  value={options.indent}
                  onChange={(value) =>
                    updateOption("indent", value as FormatOptions["indent"])
                  }
                  options={[
                    { value: "2", label: t("2 空格") },
                    { value: "4", label: t("4 空格") },
                    { value: "tab", label: "Tab" },
                  ]}
                />
              </div>
              <button
                className={`icon-button wrap-control ${wrap ? "active" : ""}`}
                aria-label={t("自动换行")}
                aria-pressed={wrap}
                onClick={() => setWrap((previous) => !previous)}
                title={t("自动换行")}
              >
                <TextWrap size={16} />
              </button>
            </div>
          </div>
          <KeyExtractor
            key={current.id}
            sourceId={`${current.id}:${current.revision}`}
            optionsKey={JSON.stringify(options)}
            query={keyQuery}
            onQueryChange={updateKeyQuery}
            automaticSearch={current.keySearch}
            disabled={
              !storageReady ||
              current.loaded === false ||
              Boolean(current.deleting) ||
              !current.raw.trim() ||
              Boolean(current.importError)
            }
            extraction={current.extraction}
            onSearch={searchKey}
            onExtract={extractValue}
            onReset={resetExtraction}
          />
          <div
            className={`status-strip kind-${stateKind}`}
            data-testid="processing-status"
            role={
              storageError || current.status === "error" ? "alert" : "status"
            }
          >
            <span className="status-message">
              {current.status === "processing" ? (
                <LoaderCircle size={15} className="spin" />
              ) : current.status === "error" ? (
                <CircleAlert size={15} />
              ) : (
                <CircleCheck size={15} />
              )}
              <span>{localizeMessage(statusMessage)}</span>
            </span>
            {storageError && (
              <button className="button ghost" onClick={() => void bootstrap()}>
                {t("重试载入历史")}
              </button>
            )}
            <span className="status-aside">
              {hasOutput && current.duration !== undefined
                ? `${Math.max(1, Math.round(current.duration))} ms · `
                : ""}
              {t("原始内容已保留")}
            </span>
          </div>
          {arrayDecoding &&
            (arrayDecoding.decodedItems > 0 ||
              arrayDecoding.failedItems > 0) && (
              <section
                className="array-decoding-summary"
                data-testid="extracted-array-summary"
                aria-label={t("JSON 字符串处理")}
              >
                <p>
                  {t("已展开 {{count}} 个 JSON 字符串", {
                    count: arrayDecoding.decodedItems,
                  })}
                </p>
                {result && result.decodedLayers > 0 && (
                  <p>
                    {t("外层已去转义 {{count}} 层", {
                      count: result.decodedLayers,
                    })}
                  </p>
                )}
                {arrayDecoding.failedItems > 0 && (
                  <details className="array-decoding-warnings">
                    <summary>
                      {t("{{count}} 项未展开，已保留原内容", {
                        count: arrayDecoding.failedItems,
                      })}
                    </summary>
                    <ul>
                      {arrayDecoding.warnings.map((warning, index) => (
                        <li key={`${warning.path}:${index}`}>
                          <code>{warning.path}</code>
                          <span>{localizeMessage(warning.message)}</span>
                        </li>
                      ))}
                    </ul>
                    {arrayDecoding.warningsTruncated && (
                      <p>{t("仅显示部分提示，请检查其余未展开项。")}</p>
                    )}
                  </details>
                )}
              </section>
            )}
          {current.saveError && (
            <div className="autosave-error" role="alert">
              <CircleAlert size={14} />
              <span>
                {current.fileSaveError
                  ? localizeMessage(current.fileSaveError)
                  : t("自动保存失败：{{message}}", {
                      message: localizeMessage(current.saveError),
                    })}
              </span>
              <button
                className="button ghost"
                onClick={() => {
                  queueCurrentDocuments();
                  void sync
                    .flush(current.id)
                    .catch((error) => notify(errorMessage(error)));
                }}
              >
                {t("重试保存")}
              </button>
              {current.fileSaveError && (
                <button
                  className="button ghost"
                  onClick={() => setSettingsOpen(true)}
                >
                  {t("检查文件存储目录")}
                </button>
              )}
            </div>
          )}
          {current.fileStorageError && !current.fileSaveError && (
            <div
              className="autosave-error"
              role="alert"
              data-testid="file-storage-error"
            >
              <CircleAlert size={14} />
              <span>
                {t(
                  "文件尚未保存到存储目录：{{message}}；原文已保留，请检查目录后重新拖入。",
                  { message: localizeMessage(current.fileStorageError) },
                )}
              </span>
              <button
                className="button ghost"
                aria-label={t("检查文件存储目录")}
                onClick={() => setSettingsOpen(true)}
              >
                {t("检查存储目录")}
              </button>
            </div>
          )}
          <div className="editors">
            <section
              className="editor-panel"
              data-pane="input"
              aria-label={t("原始输入编辑器")}
            >
              <header className="editor-header">
                <h2>
                  <span className="editor-index">IN</span>
                  {t("原始输入")}
                </h2>
                <div className="editor-actions">
                  {focusedPane === "input" && (
                    <button
                      className="icon-button"
                      aria-label={t("自动换行")}
                      aria-pressed={wrap}
                      title={t("自动换行")}
                      onClick={() => setWrap((previous) => !previous)}
                    >
                      <TextWrap size={16} />
                    </button>
                  )}
                  {!current.raw && current.cleared !== undefined && (
                    <button
                      className="icon-button"
                      aria-label={t("恢复清空的内容")}
                      title={t("恢复清空的内容")}
                      onClick={() => updateInput(current.cleared!)}
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    onClick={clearInput}
                    aria-label={t("清空当前输入")}
                    title={t("清空当前输入")}
                  >
                    <Eraser size={15} />
                  </button>
                  <button
                    className={
                      focusedPane === "input"
                        ? "button ghost focus-exit"
                        : "icon-button"
                    }
                    data-focus-toggle="input"
                    aria-label={
                      focusedPane === "input"
                        ? t("返回双栏")
                        : t("独占查看原始输入")
                    }
                    aria-pressed={focusedPane === "input"}
                    title={
                      focusedPane === "input"
                        ? t("返回双栏（Esc）")
                        : t("独占查看原始输入")
                    }
                    onClick={() =>
                      setFocusedPane((previous) =>
                        previous === "input" ? null : "input",
                      )
                    }
                  >
                    {focusedPane === "input" ? (
                      <>
                        <Minimize2 size={15} />
                        {t("返回双栏")}
                        <kbd>Esc</kbd>
                      </>
                    ) : (
                      <Maximize2 size={15} />
                    )}
                  </button>
                </div>
              </header>
              <div className="editor-body" data-testid="input-editor">
                <JsonEditor
                  key={current.id}
                  value={current.raw}
                  label={t("输入 JSON")}
                  wrap={wrap}
                  readOnly={
                    !storageReady ||
                    current.loaded === false ||
                    Boolean(current.deleting)
                  }
                  selection={selection}
                  onChange={updateInput}
                />
              </div>
              <footer className="editor-footer">
                <span>
                  {t("{{total}} 字符", {
                    count: characterCount,
                    total: numberFormatter.format(characterCount),
                  })}
                </span>
                <span
                  className={`focus-feedback ${current.status === "error" && !feedback ? "error" : ""}`}
                  role="status"
                  aria-live="polite"
                  title={localizeMessage(
                    feedback || current.saveError || statusMessage,
                  )}
                >
                  {focusedPane === "input"
                    ? localizeMessage(
                        feedback || current.saveError || statusMessage,
                      )
                    : ""}
                </span>
                <span title={current.managedPath}>
                  {t("原文 · {{status}}", { status: autosaveLabel })}
                </span>
              </footer>
            </section>
            <section
              className="editor-panel"
              data-pane="output"
              aria-label={t("格式化结果")}
            >
              <header className="editor-header">
                <h2>
                  <span className="editor-index">OUT</span>
                  {t("格式化结果")}
                </h2>
                {current.extraction && (
                  <span
                    className="focus-file-name"
                    title={current.extraction.path}
                  >
                    {current.extraction.path}
                  </span>
                )}
                <div className="editor-actions">
                  <span
                    className="quiet editor-result-kind"
                    title={current.extraction?.path}
                  >
                    {current.extraction ? t("提取值 · JSON") : "JSON"}
                  </span>
                  {focusedPane === "output" && (
                    <>
                      <button
                        className="icon-button"
                        aria-label={t("自动换行")}
                        aria-pressed={wrap}
                        title={t("自动换行")}
                        onClick={() => setWrap((previous) => !previous)}
                      >
                        <TextWrap size={16} />
                      </button>
                    </>
                  )}
                  <button
                    className={
                      focusedPane === "output"
                        ? "button ghost focus-exit"
                        : "icon-button"
                    }
                    data-focus-toggle="output"
                    aria-label={
                      focusedPane === "output"
                        ? t("返回双栏")
                        : t("独占查看格式化结果")
                    }
                    aria-pressed={focusedPane === "output"}
                    title={
                      focusedPane === "output"
                        ? t("返回双栏（Esc）")
                        : t("独占查看格式化结果")
                    }
                    onClick={() =>
                      setFocusedPane((previous) =>
                        previous === "output" ? null : "output",
                      )
                    }
                  >
                    {focusedPane === "output" ? (
                      <>
                        <Minimize2 size={15} />
                        {t("返回双栏")}
                        <kbd>Esc</kbd>
                      </>
                    ) : (
                      <Maximize2 size={15} />
                    )}
                  </button>
                </div>
              </header>
              <div className="editor-body" data-testid="output-editor">
                {hasOutput ? (
                  <JsonEditor
                    value={result.output}
                    label={t("格式化 JSON 结果")}
                    readOnly
                    wrap={wrap}
                  />
                ) : (
                  <div className="empty-output">
                    {current.status === "processing" ? (
                      <LoaderCircle size={26} className="spin" />
                    ) : current.status === "error" ? (
                      <CircleAlert size={26} />
                    ) : (
                      <span className="empty-braces" aria-hidden="true">
                        {"{ }"}
                      </span>
                    )}
                    <strong>
                      {current.status === "processing"
                        ? t("正在整理内容")
                        : current.status === "error"
                          ? t("暂时无法格式化")
                          : t("等待格式化")}
                    </strong>
                    <span>
                      {current.status === "error"
                        ? t("原始内容已保留，可以继续编辑后重试。")
                        : current.status === "processing"
                          ? t("处理在独立线程进行，你可以继续切换文件。")
                          : t("粘贴 JSON，或把文件拖到工作区。")}
                    </span>
                    {currentError?.line && (
                      <button
                        className="button ghost error-locate"
                        onClick={() => {
                          if (currentError.layer || current.extraction) {
                            notify(
                              t(
                                "错误位于 {{target}}，第 {{line}} 行第 {{column}} 列",
                                {
                                  target: textLocation(
                                    currentError.layer ?? 0,
                                    Boolean(current.extraction),
                                  ),
                                  line: currentError.line,
                                  column: currentError.column,
                                },
                              ),
                            );
                            return;
                          }
                          const from = currentError.offset ?? 0;
                          setFocusedPane((previous) =>
                            previous === "output" ? "input" : previous,
                          );
                          setSelection({
                            from,
                            to: Math.min(current.raw.length, from + 1),
                            key: ++selectionCounter.current,
                          });
                        }}
                      >
                        {t("定位 {{target}} 错误 · {{line}}:{{column}}", {
                          target: textLocation(
                            currentError.layer ?? 0,
                            Boolean(current.extraction),
                          ),
                          line: currentError.line,
                          column: currentError.column,
                        })}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <footer className="editor-footer output-footer">
                <div className="output-metadata">
                  <span>
                    {hasOutput
                      ? t("{{total}} 行 · {{indent}}", {
                          count: lineCount,
                          total: numberFormatter.format(lineCount),
                          indent:
                            options.indent === "tab"
                              ? "Tab"
                              : t("{{count}} 空格", { count: options.indent }),
                        })
                      : t("尚无输出")}
                  </span>
                  {hasOutput && (
                    <span className="valid-label">
                      <span className="status-dot" />
                      {t("有效 JSON")}
                    </span>
                  )}
                </div>
                <span
                  className={`focus-feedback ${current.status === "error" && !feedback ? "error" : ""}`}
                  role="status"
                  aria-live="polite"
                  title={localizeMessage(
                    feedback || current.saveError || statusMessage,
                  )}
                >
                  {focusedPane === "output"
                    ? localizeMessage(
                        feedback || current.saveError || statusMessage,
                      )
                    : ""}
                </span>
                <div className="output-actions">
                  <CopyButton
                    disabled={!hasOutput}
                    feedbackKey={result ?? current.id}
                    onCopy={copyOutput}
                  />
                  <button
                    className="button"
                    disabled={!hasOutput}
                    onClick={() => void exportCurrent()}
                  >
                    <ArrowDownToLine size={15} />
                    {t("导出")}
                  </button>
                </div>
              </footer>
            </section>
          </div>
          {(hasOutput ||
            repairRecords.stages.length > 0 ||
            repairRecords.sourceDecodedLayers > 0) && (
            <section
              className="processing-records"
              data-testid="processing-records"
              aria-label={t("处理记录")}
            >
              <div className="records-header">
                <h2>
                  <GitPullRequestArrow size={15} />
                  {repairRecords.stages.length ? t("修复记录") : t("处理记录")}
                  {repairRecords.stages.length > 0 && (
                    <span className="record-count" data-testid="repair-count">
                      {repairRecords.changeCount ?? "—"}
                    </span>
                  )}
                </h2>
                {repairRecords.stages.length > 0 && (
                  <button
                    className="button ghost"
                    data-testid="open-repair-diff"
                    onClick={() => openRepairDiff(selectedChange)}
                  >
                    <Columns2 size={14} />
                    {t("查看差异")}
                  </button>
                )}
              </div>
              {repairRecords.stages.length ? (
                <>
                  <div className="repair-list">
                    {changes.map((change, index) => {
                      const source = repairLocations.get(change.id);
                      return (
                        <button
                          key={change.id}
                          data-origin={change.origin}
                          data-stage-id={change.stageId}
                          data-repair-id={change.id}
                          data-source-line={source?.line}
                          data-source-column={source?.column}
                          data-location-exact={
                            source ? String(source.exact) : undefined
                          }
                          className={`repair-row ${selectedChange?.id === change.id ? "selected" : ""}`}
                          onClick={() => selectRepair(change)}
                          title={
                            source?.exact
                              ? `${t("原文")} ${source.line}:${source.column}`
                              : t("内部修复位置：{{line}}:{{column}}", {
                                  line: change.line,
                                  column: change.column,
                                })
                          }
                          aria-label={
                            source
                              ? t(
                                  "{{action}}，{{target}}第 {{line}} 行第 {{column}} 列",
                                  {
                                    action: t(change.label),
                                    target: t(
                                      source.exact ? "原文" : "原文字段",
                                    ),
                                    line: source.line,
                                    column: source.column,
                                  },
                                )
                              : t("无法定位原文，请查看差异。")
                          }
                        >
                          <span className="repair-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="repair-name">
                            {current.extraction && (
                              <span className="layer-label">
                                {t(
                                  change.origin === "source"
                                    ? "源 JSON"
                                    : "提取值",
                                )}
                                {" · "}
                              </span>
                            )}
                            {change.path && (
                              <code className="array-repair-path">
                                {change.path}
                              </code>
                            )}
                            {change.layer > 0 && (
                              <span className="layer-label">
                                {t("解码 {{count}} 层 · ", {
                                  count: change.layer,
                                })}
                              </span>
                            )}
                            {t(change.label)}
                          </span>
                          <span className="change-snippet">
                            <code className="removed" title={change.before}>
                              {snippet(change.before)}
                            </code>
                            <ArrowRight size={11} />
                            <code className="added" title={change.after}>
                              {snippet(change.after)}
                            </code>
                          </span>
                          <span className="repair-position">
                            {source ? `${source.line}:${source.column}` : "—"}
                          </span>
                        </button>
                      );
                    })}
                    {repairRecords.changeCount === null && (
                      <div className="diff-note">
                        <CircleAlert size={14} />
                        {t(
                          "差异较大，未统计精确变更条数，请展开完整差异核对。",
                        )}
                      </div>
                    )}
                  </div>
                  <p className="record-note">
                    <span>
                      {t(
                        "位置为原文行:列；点击定位原文，解码后的修复定位到所属字符串，内部修改可查看差异。",
                      )}
                    </span>
                    {Boolean(result?.decodedLayers) && (
                      <span>
                        {t("去转义 {{count}} 层 · 单独记录", {
                          count: result?.decodedLayers,
                        })}
                      </span>
                    )}
                  </p>
                </>
              ) : hasOutput ? (
                <>
                  <div className="clean-record">
                    <Check size={15} />
                    {arrayDecoding?.decodedItems
                      ? t("已展开 {{count}} 个 JSON 字符串", {
                          count: arrayDecoding.decodedItems,
                        })
                      : result?.decodedLayers
                        ? t("已解码 {{count}} 层 JSON 字符串，并完成格式化。", {
                            count: result.decodedLayers,
                          })
                        : t("语法有效，已调整缩进与换行。")}
                  </div>
                  <p className="record-note">
                    {arrayDecoding?.decodedItems
                      ? t(
                          "递归展开对象字段和数组项中的 JSON 字符串，普通文本和合法转义保持原样。",
                        )
                      : result?.decodedLayers
                        ? t("只解码包裹 JSON 的字符串，保留字段内的合法转义。")
                        : t("保留数字字面量、重复字段和字段内的原始转义。")}
                  </p>
                </>
              ) : null}
              {repairRecords.sourceDecodedLayers > 0 && (
                <p className="record-note">
                  {t("源 JSON 已去转义 {{count}} 层", {
                    count: repairRecords.sourceDecodedLayers,
                  })}
                </p>
              )}
            </section>
          )}
          <footer
            className="workspace-footer"
            data-has-feedback={feedback ? "true" : undefined}
          >
            <span className="feedback" aria-live="polite" role="status">
              {localizeMessage(feedback)}
            </span>
          </footer>
        </main>
        {comparisonVisited && (
          <ComparisonPage
            ref={comparison}
            hidden={!comparisonOpen || settingsOpen}
            recursiveUnescape={settingsDraft.recursiveUnescape ?? true}
            onRecursiveChange={(recursiveUnescape) =>
              updatePaths({ recursiveUnescape })
            }
            wrap={wrap}
            onWrapChange={() => setWrap((previous) => !previous)}
            onClose={() => setComparisonOpen(false)}
          />
        )}
        {logExtractionVisited && (
          <LogExtractionPage
            ref={logExtraction}
            hidden={!logExtractionOpen || settingsOpen}
            recursiveUnescape={settingsDraft.recursiveUnescape ?? true}
            onRecursiveChange={(recursiveUnescape) =>
              updatePaths({ recursiveUnescape })
            }
            wrap={wrap}
            onWrapChange={() => setWrap((previous) => !previous)}
            onClose={() => setLogExtractionOpen(false)}
            onPreviewExpandedChange={setLogPreviewExpanded}
            onMigrate={migrateLogItems}
          />
        )}
        {diffSnapshot && (
          <RepairDiffPage
            key={diffSnapshot.key}
            snapshot={diffSnapshot}
            hidden={settingsOpen}
            onClose={closeDiffPage}
          />
        )}
        <main
          className="settings-page"
          hidden={!settingsOpen}
          aria-label={t("应用设置页面")}
        >
          {settingsOpen && (
            <WorkspaceSettingsPanel
              settings={settingsDraft}
              busy={settingsBusy}
              error={settingsError || undefined}
              onChange={updatePaths}
              onBrowse={(kind) => void browseDirectory(kind)}
              onRestore={restoreSavedPaths}
              onClose={() => {
                void flushSettings();
                setSettingsOpen(false);
              }}
            />
          )}
        </main>
      </div>
      {deleteTarget && (
        <DeleteConfirmation
          name={deleteTarget.name}
          filePath={deleteTarget.managedPath}
          saving={deleteTarget.saveState === "saving" && !deleteBusy}
          busy={deleteBusy}
          error={deleteError || undefined}
          onCancel={cancelDeleteDocument}
          onConfirm={() => void confirmDeleteDocument()}
        />
      )}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Upload size={34} />
            <strong>{t("放开以导入 JSON 文件")}</strong>
            <span>{t("支持同时导入多个 .json 文件")}</span>
          </div>
        </div>
      )}
      <OverlayScrollbars />
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) void importBrowserFiles(event.target.files);
        }}
      />
    </div>
  );
}
