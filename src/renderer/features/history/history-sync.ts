import type {
  HistoryRecord,
  HistorySummary,
  WorkspaceApi,
} from "../../../shared/types";

export type SaveStatus = "saving" | "saved" | "error";

interface PendingRecord {
  persisted: boolean;
  deleted: boolean;
  snapshot?: HistoryRecord;
  pending?: HistoryRecord;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  error?: Error;
}

function sameContent(left: HistoryRecord | undefined, right: HistoryRecord) {
  return (
    left?.raw === right.raw &&
    left.options.indent === right.options.indent &&
    left.options.autoUnescape === right.options.autoUnescape &&
    left.options.repair === right.options.repair &&
    JSON.stringify(left.extraction) === JSON.stringify(right.extraction)
  );
}

export class HistorySync {
  private entries = new Map<string, PendingRecord>();
  private operations = new Set<Promise<unknown>>();
  private removals = new Map<string, Promise<void>>();

  constructor(
    private api: WorkspaceApi,
    private onStatus: (
      id: string,
      status: SaveStatus,
      error?: string,
      summary?: HistorySummary,
    ) => void,
    private delay = 350,
  ) {}

  adopt(record: HistoryRecord | HistorySummary, revive = false) {
    const existing = this.entries.get(record.id);
    if (
      this.isRemoving(record.id) ||
      (existing?.deleted && !revive) ||
      existing?.running ||
      existing?.pending
    )
      return;
    this.entries.set(record.id, {
      persisted: true,
      deleted: false,
      ...("raw" in record
        ? {
            snapshot: record,
            ...(record.fileSaveError
              ? { pending: record, error: new Error(record.fileSaveError) }
              : {}),
          }
        : {}),
    });
  }

  schedule(record: HistoryRecord) {
    let entry = this.entries.get(record.id);
    if (!entry) {
      entry = { persisted: false, deleted: false };
      this.entries.set(record.id, entry);
    }
    if (entry.deleted || sameContent(entry.snapshot, record)) return;
    entry.snapshot = record;
    entry.pending = record;
    entry.error = undefined;
    clearTimeout(entry.timer);
    this.onStatus(record.id, "saving");
    entry.timer = setTimeout(() => {
      void this.flush(record.id).catch(() => {});
    }, this.delay);
  }

  async flush(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.deleted) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.running) return entry.running;
    if (!entry.pending) return;
    const operation = async () => {
      while (entry.pending && !entry.deleted) {
        const snapshot = entry.pending;
        entry.pending = undefined;
        let saved: HistorySummary;
        try {
          saved = entry.persisted
            ? await this.api.update(id, {
                raw: snapshot.raw,
                options: snapshot.options,
                extraction: snapshot.extraction ?? null,
              })
            : await this.api.create(snapshot);
          entry.persisted = true;
        } catch (failure) {
          const error =
            failure instanceof Error
              ? failure
              : new Error("无法自动保存历史。");
          entry.pending ??= snapshot;
          entry.error = error;
          if (!entry.deleted) this.onStatus(id, "error", error.message);
          throw error;
        }
        if (saved.fileSaveError) {
          const error = new Error(saved.fileSaveError);
          entry.pending ??= snapshot;
          entry.error = error;
          if (!entry.deleted) this.onStatus(id, "error", error.message, saved);
          throw error;
        }
        entry.error = undefined;
        if (!entry.deleted)
          this.onStatus(
            id,
            entry.pending ? "saving" : "saved",
            undefined,
            saved,
          );
      }
    };
    entry.running = operation().finally(() => {
      entry.running = undefined;
    });
    return entry.running;
  }

  async flushAll() {
    do {
      await Promise.all([
        ...this.operations,
        ...[...this.entries.keys()].map((id) => this.flush(id)),
      ]);
    } while (this.hasPending());
  }

  hasPending() {
    return (
      this.operations.size > 0 ||
      [...this.entries.values()].some(
        (entry) => !entry.deleted && Boolean(entry.pending || entry.running),
      )
    );
  }

  isRemoving(id: string) {
    return this.removals.has(id);
  }

  remove(id: string): Promise<void> {
    const existing = this.removals.get(id);
    if (existing) return existing;
    const operation = this.removeRecord(id);
    this.operations.add(operation);
    const tracked = operation.finally(() => {
      this.operations.delete(operation);
      this.removals.delete(id);
    });
    this.removals.set(id, tracked);
    return tracked;
  }

  private async removeRecord(id: string) {
    const entry = this.entries.get(id) ?? { persisted: true, deleted: false };
    this.entries.set(id, entry);
    clearTimeout(entry.timer);
    entry.deleted = true;
    const pending = entry.pending;
    entry.pending = undefined;
    try {
      await entry.running?.catch(() => {});
      if (entry.persisted) await this.api.remove(id);
      entry.pending = undefined;
      entry.snapshot = undefined;
    } catch (error) {
      entry.deleted = false;
      entry.pending = entry.snapshot ?? pending ?? entry.pending;
      throw error;
    }
  }

  rename(id: string, name: string) {
    const operation = (async () => {
      await this.flush(id);
      if (this.entries.get(id)?.deleted) throw new Error("历史记录已删除。");
      return this.api.rename(id, name);
    })();
    this.operations.add(operation);
    return operation.finally(() => {
      this.operations.delete(operation);
    });
  }

  dispose() {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }
}
