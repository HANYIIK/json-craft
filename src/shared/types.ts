export type Indent = "2" | "4" | "tab";

export interface FormatOptions {
  indent: Indent;
  autoUnescape: boolean;
  repair: boolean;
}

export const defaultOptions: FormatOptions = {
  indent: "2",
  autoUnescape: true,
  repair: true,
};
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface RepairChange {
  id: string;
  label: string;
  before: string;
  after: string;
  start: number;
  end: number;
  line: number;
  column: number;
  layer: number;
  stageId: string;
  path?: string;
}

export interface RepairStage {
  id: string;
  layer: number;
  before: string;
  after: string;
  changes: RepairChange[];
  diffTruncated: boolean;
  path?: string;
}

export interface ProcessingError {
  message: string;
  line?: number;
  column?: number;
  offset?: number;
  layer?: number;
}

export interface ProcessingResult {
  success: boolean;
  output: string;
  decodedLayers: number;
  stages: RepairStage[];
  changeCount: number | null;
  error?: ProcessingError;
  arrayDecoding?: {
    decodedItems: number;
    failedItems: number;
    warnings: { path: string; message: string }[];
    warningsTruncated: boolean;
  };
}

export type JsonValueType =
  "object" | "array" | "string" | "number" | "boolean" | "null";

export interface KeyMatch {
  id: string;
  path: string;
  type: JsonValueType;
  preview: string;
  start: number;
  end: number;
  line: number;
  column: number;
  occurrence: number;
  occurrences: number;
}

export interface KeySearchResult {
  key: string;
  preparation: ProcessingResult;
  matches: KeyMatch[];
  truncated: boolean;
  error?: string;
}

export interface ExtractedValue {
  key: string;
  path: string;
  matchId: string;
  occurrence: number;
  occurrences: number;
  raw: string;
  preparation: ProcessingResult;
}

export interface ImportedFile {
  name: string;
  content: string;
  filePath?: string;
  sourceFilePath?: string;
  storageError?: string;
  error?: string;
}

export type HistorySource = "sample" | "imported" | "scratch";

export interface SavedExtraction {
  key: string;
  path: string;
  occurrence: number;
}

export interface HistoryRecord {
  id: string;
  name: string;
  raw: string;
  source: HistorySource;
  sourcePath?: string;
  managedPath?: string;
  fileSaveError?: string;
  options: FormatOptions;
  extraction?: SavedExtraction;
  createdAt: string;
  updatedAt: string;
}

export interface HistorySummary extends Omit<HistoryRecord, "raw"> {
  characters: number;
}

export interface HistoryUpdate {
  raw: string;
  options: FormatOptions;
  extraction: SavedExtraction | null;
}

export type ThemePreference = "system" | "light" | "dark";
export type LanguagePreference = "system" | "zh-CN" | "en";
export type AppLanguage = "zh-CN" | "en";

export interface WorkspaceSettings {
  readDirectory: string;
  writeDirectory: string;
  historyDirectory: string;
  theme: ThemePreference;
  autoCopy: boolean;
  recursiveUnescape?: boolean;
  language?: LanguagePreference;
}

export interface WorkspaceState {
  initialized: boolean;
  records: HistorySummary[];
  settings: WorkspaceSettings;
  activeId: string | null;
}

export type DirectoryKind = "read" | "write" | "history";

export interface WorkspaceApi {
  load(): Promise<WorkspaceState>;
  read(id: string): Promise<HistoryRecord>;
  create(record: HistoryRecord): Promise<HistorySummary>;
  update(id: string, changes: HistoryUpdate): Promise<HistorySummary>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<HistorySummary>;
  updateSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings>;
  chooseDirectory(kind: DirectoryKind): Promise<WorkspaceSettings | null>;
  setActive(id: string | null): Promise<void>;
  requestClose(): Promise<void>;
}

export type MenuAction = "new" | "format" | "export";

export interface DesktopApi {
  platform: string;
  systemLocale: AppLanguage;
  workspace: WorkspaceApi;
  getPathForFile(file: File): string;
  openFiles(): Promise<ImportedFile[]>;
  importDroppedFiles(paths: string[]): Promise<ImportedFile[]>;
  saveFile(file: {
    name: string;
    content: string;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  copyText(text: string): Promise<void>;
  ready(): Promise<ImportedFile[]>;
  onOpenFiles(listener: (files: ImportedFile[]) => void): () => void;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}
