import type {
  HistoryRecord,
  HistorySummary,
  LanguagePreference,
  ThemePreference,
  WorkspaceApi,
  WorkspaceSettings,
  WorkspaceState,
} from "../../../shared/types";

function validLanguage(value: unknown): LanguagePreference {
  if (value !== "system" && value !== "zh-CN" && value !== "en")
    throw new Error("语言设置无效，请选择跟随系统、简体中文或英语。");
  return value;
}

function validTheme(value: unknown): ThemePreference {
  if (value !== "system" && value !== "light" && value !== "dark")
    throw new Error("主题设置无效，请选择跟随系统、浅色或深色。");
  return value;
}

function validAutoCopy(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("自动复制设置无效，请使用开启或关闭状态。");
  return value;
}

function validRecursiveUnescape(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("递归去转义设置无效，请使用开启或关闭状态。");
  return value;
}

export function createBrowserWorkspace(): WorkspaceApi {
  const key = "json-craft-workspace-v1";
  const read = (): {
    initialized: boolean;
    records: HistoryRecord[];
    settings: WorkspaceSettings;
    activeId: string | null;
  } => {
    const stored = localStorage.getItem(key);
    const state = stored
      ? JSON.parse(stored)
      : {
          initialized: false,
          records: [],
          settings: {
            readDirectory: "",
            writeDirectory: "",
            historyDirectory: "",
            theme: "system",
            autoCopy: false,
            recursiveUnescape: true,
            language: "system",
          },
          activeId: null,
        };
    return {
      ...state,
      settings: {
        ...state.settings,
        theme: Object.hasOwn(state.settings, "theme")
          ? validTheme(state.settings.theme)
          : "system",
        autoCopy: Object.hasOwn(state.settings, "autoCopy")
          ? validAutoCopy(state.settings.autoCopy)
          : false,
        recursiveUnescape: Object.hasOwn(state.settings, "recursiveUnescape")
          ? validRecursiveUnescape(state.settings.recursiveUnescape)
          : true,
        language: Object.hasOwn(state.settings, "language")
          ? validLanguage(state.settings.language)
          : "system",
      },
    };
  };
  const write = (state: ReturnType<typeof read>) =>
    localStorage.setItem(key, JSON.stringify(state));
  const summary = ({ raw, ...record }: HistoryRecord): HistorySummary => ({
    ...record,
    characters: raw.length,
  });
  return {
    async load(): Promise<WorkspaceState> {
      const state = read();
      return { ...state, records: state.records.map(summary) };
    },
    async read(id) {
      const found = read().records.find((record) => record.id === id);
      if (!found) throw new Error("历史记录不存在。");
      return found;
    },
    async create(record) {
      const state = read();
      if (state.records.some((item) => item.id === record.id))
        throw new Error("历史记录已存在。");
      const saved = {
        ...record,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.records.push(saved);
      state.initialized = true;
      write(state);
      return summary(saved);
    },
    async update(id, changes) {
      const state = read();
      const record = state.records.find((item) => item.id === id);
      if (!record) throw new Error("历史记录已删除。");
      const saved = {
        ...record,
        ...changes,
        extraction: changes.extraction ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      state.records = state.records.map((item) =>
        item.id === id ? saved : item,
      );
      write(state);
      return summary(saved);
    },
    async remove(id) {
      const state = read();
      state.records = state.records.filter((item) => item.id !== id);
      if (state.activeId === id) state.activeId = null;
      write(state);
    },
    async rename(id, name) {
      const state = read();
      const record = state.records.find((item) => item.id === id);
      if (!record) throw new Error("历史记录不存在。");
      const normalized = /\.json$/i.test(name) ? name : name + ".json";
      if (!normalized.trim() || /[\\/<>:"|?*\x00-\x1f]/.test(normalized))
        throw new Error("文件名无效。");
      if (
        state.records.some(
          (item) =>
            item.id !== id &&
            item.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
        )
      )
        throw new Error("同名历史记录已存在。");
      record.name = normalized;
      record.updatedAt = new Date().toISOString();
      write(state);
      return summary(record);
    },
    async updateSettings(patch) {
      if (Object.hasOwn(patch, "theme")) validTheme(patch.theme);
      if (Object.hasOwn(patch, "autoCopy")) validAutoCopy(patch.autoCopy);
      if (Object.hasOwn(patch, "recursiveUnescape"))
        validRecursiveUnescape(patch.recursiveUnescape);
      if (Object.hasOwn(patch, "language")) validLanguage(patch.language);
      const state = read();
      state.settings = { ...state.settings, ...patch };
      write(state);
      return state.settings;
    },
    async chooseDirectory() {
      throw new Error("请在 Electron 桌面版中选择文件目录。");
    },
    async setActive(id) {
      const state = read();
      if (state.activeId === id) return;
      state.activeId = id;
      write(state);
    },
    async requestClose() {
      window.close();
    },
  };
}
