import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  HistorySync,
  type SaveStatus,
} from "../../../src/renderer/features/history/history-sync";
import type {
  HistoryRecord,
  HistorySummary,
  WorkspaceApi,
} from "../../../src/shared/types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function record(raw = "initial", id = "record-one"): HistoryRecord {
  return {
    id,
    name: `${id}.json`,
    raw,
    source: "scratch",
    options: { indent: "2", autoUnescape: true, repair: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function summary(value: HistoryRecord): HistorySummary {
  const { raw, ...metadata } = value;
  return { ...metadata, characters: raw.length };
}

function fixture(t: TestContext, initial: HistoryRecord[] = []) {
  const records = new Map(
    initial.map((value) => [value.id, structuredClone(value)]),
  );
  const settings = {
    readDirectory: "/read",
    writeDirectory: "/write",
    historyDirectory: "/history",
    theme: "system" as const,
    autoCopy: false,
  };
  const events: { id: string; status: SaveStatus; error?: string }[] = [];
  const calls = { create: 0, update: 0, remove: 0, rename: 0 };
  const api: WorkspaceApi = {
    load: async () => ({
      initialized: true,
      records: [...records.values()].map(summary),
      settings,
      activeId: null,
    }),
    read: async (id) => {
      const found = records.get(id);
      if (!found) throw new Error("missing record");
      return structuredClone(found);
    },
    create: async (value) => {
      calls.create++;
      if (records.has(value.id)) throw new Error("record exists");
      records.set(value.id, structuredClone(value));
      return summary(value);
    },
    update: async (id, changes) => {
      calls.update++;
      const previous = records.get(id);
      if (!previous) throw new Error("missing record");
      const next = {
        ...previous,
        raw: changes.raw,
        options: structuredClone(changes.options),
        extraction: changes.extraction ?? undefined,
      };
      records.set(id, next);
      return summary(next);
    },
    remove: async (id) => {
      calls.remove++;
      records.delete(id);
    },
    rename: async (id, name) => {
      calls.rename++;
      const previous = records.get(id);
      if (!previous) throw new Error("missing record");
      const next = { ...previous, name };
      records.set(id, next);
      return summary(next);
    },
    updateSettings: async (patch) => Object.assign(settings, patch),
    chooseDirectory: async () => null,
    setActive: async () => {},
    requestClose: async () => {},
  };
  const sync = new HistorySync(
    api,
    (id, status, error) => events.push({ id, status, error }),
    60_000,
  );
  t.after(() => sync.dispose());
  return { records, events, calls, api, sync };
}

test("refreshing summaries preserves loaded snapshots and does not save untouched files", async (t) => {
  const initial = [record("first", "one"), record("second", "two")];
  const { sync, calls } = fixture(t, initial);
  for (const value of initial) sync.adopt(value);
  for (const value of initial) sync.adopt(summary(value));
  for (const value of initial) sync.schedule(value);
  await sync.flushAll();
  assert.equal(calls.update, 0);
  assert.equal(sync.hasPending(), false);
  sync.schedule(record("edited", "one"));
  await sync.flushAll();
  assert.equal(calls.update, 1);
  for (const value of [record("edited", "one"), initial[1]]) {
    sync.adopt(summary(value));
    sync.schedule(value);
  }
  await sync.flushAll();
  assert.equal(calls.update, 1);
});

test("coalesces edits arriving during a save and commits the latest snapshot", async (t) => {
  const initial = record();
  const { api, sync, records, events } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const update = api.update;
  const writes: string[] = [];
  api.update = async (id, changes) => {
    writes.push(changes.raw);
    if (writes.length === 1) {
      started.resolve();
      await release.promise;
    }
    return update(id, changes);
  };
  sync.schedule(record("A"));
  const saving = sync.flush(initial.id);
  await started.promise;
  sync.schedule(record("B"));
  sync.schedule(record("C"));
  release.resolve();
  await saving;
  assert.deepEqual(writes, ["A", "C"]);
  assert.equal(records.get(initial.id)?.raw, "C");
  assert.equal(sync.hasPending(), false);
  assert.equal(events.at(-1)?.status, "saved");
});

test("an in-flight create becomes an update instead of creating a duplicate", async (t) => {
  const { api, sync, records, calls } = fixture(t);
  const started = deferred();
  const release = deferred();
  const create = api.create;
  api.create = async (value) => {
    started.resolve();
    await release.promise;
    return create(value);
  };
  sync.schedule(record("first"));
  const saving = sync.flush("record-one");
  await started.promise;
  sync.schedule(record("last edit"));
  release.resolve();
  await saving;
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 1);
  assert.equal(records.get("record-one")?.raw, "last edit");
});

test("flushAll drains newly scheduled records and final edits before allowing close", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const update = api.update;
  let calls = 0;
  api.update = async (id, changes) => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
    }
    return update(id, changes);
  };
  sync.schedule(record("first edit"));
  let closed = false;
  const closing = sync.flushAll().then(() => {
    closed = true;
  });
  await started.promise;
  sync.schedule(record("final edit"));
  sync.schedule(record("another record", "record-two"));
  await setImmediate();
  assert.equal(closed, false);
  release.resolve();
  await closing;
  assert.equal(records.get(initial.id)?.raw, "final edit");
  assert.equal(records.get("record-two")?.raw, "another record");
  assert.equal(sync.hasPending(), false);
});

test("failed writes do not loop when the same content is scheduled again", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  const update = api.update;
  let attempts = 0;
  let failing = true;
  api.update = async (id, changes) => {
    attempts++;
    if (failing) throw new Error("write denied");
    return update(id, changes);
  };
  sync.schedule(record("latest"));
  await assert.rejects(sync.flush(initial.id), /write denied/);
  for (let index = 0; index < 4; index++) sync.schedule(record("latest"));
  await setImmediate();
  assert.equal(attempts, 1);
  assert.equal(sync.hasPending(), true);
  failing = false;
  await sync.flushAll();
  assert.equal(attempts, 2);
  assert.equal(records.get(initial.id)?.raw, "latest");
  assert.equal(sync.hasPending(), false);
});

test("failed save and failed deletion restore the newest snapshot instead of an older write", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const failedWrite = deferred<HistorySummary>();
  const update = api.update;
  api.update = async () => {
    started.resolve();
    return failedWrite.promise;
  };
  api.remove = async () => {
    throw new Error("delete denied");
  };
  sync.schedule(record("A"));
  const saving = sync.flush(initial.id);
  const saveRejected = assert.rejects(saving, /write denied/);
  await started.promise;
  sync.schedule(record("B"));
  const deletion = sync.remove(initial.id);
  const deleteRejected = assert.rejects(deletion, /delete denied/);
  failedWrite.reject(new Error("write denied"));
  await Promise.all([saveRejected, deleteRejected]);
  api.update = update;
  await sync.flushAll();
  assert.equal(records.get(initial.id)?.raw, "B");
});

test("late hydration cannot erase a deletion tombstone or leave phantom pending updates", async (t) => {
  const initial = record();
  const { api, sync, records, calls } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const remove = api.remove;
  api.remove = async (id) => {
    started.resolve();
    await release.promise;
    return remove(id);
  };
  const deletion = sync.remove(initial.id);
  await started.promise;
  sync.adopt(initial);
  sync.schedule(record("stale hydration"));
  release.resolve();
  await deletion;
  await sync.flushAll();
  assert.equal(records.has(initial.id), false);
  assert.equal(calls.update, 0);
  assert.equal(sync.hasPending(), false);
  sync.adopt(initial);
  sync.schedule(record("another stale update"));
  await sync.flushAll();
  assert.equal(records.has(initial.id), false);
  assert.equal(calls.update, 0);
});

test("only explicit adoption can restore a completed deletion after switching history directories", async (t) => {
  const initial = record();
  const { sync, records, calls } = fixture(t, [initial]);
  sync.adopt(initial);
  await sync.remove(initial.id);
  assert.equal(sync.isRemoving(initial.id), false);
  const restored = record("content from another history directory");
  records.set(restored.id, structuredClone(restored));

  sync.adopt(restored);
  sync.schedule(record("ignored stale edit"));
  await sync.flushAll();
  assert.equal(calls.update, 0);
  assert.equal(sync.hasPending(), false);
  assert.equal(records.get(restored.id)?.raw, restored.raw);

  sync.adopt(summary(restored), true);
  sync.schedule(record("edited restored history"));
  await sync.flushAll();
  assert.equal(calls.create, 0);
  assert.equal(calls.update, 1);
  assert.equal(records.get(restored.id)?.raw, "edited restored history");
});

test("explicit adoption cannot revive a record while its deletion is still running", async (t) => {
  const initial = record();
  const { api, sync, records, calls } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const remove = api.remove;
  api.remove = async (id) => {
    started.resolve();
    await release.promise;
    return remove(id);
  };
  const deletion = sync.remove(initial.id);
  await started.promise;
  assert.equal(sync.isRemoving(initial.id), true);
  sync.adopt(record("premature restoration"), true);
  sync.schedule(record("ignored edit during deletion"));
  release.resolve();
  await deletion;

  assert.equal(sync.isRemoving(initial.id), false);
  sync.schedule(record("ignored edit after deletion"));
  await sync.flushAll();
  assert.equal(records.has(initial.id), false);
  assert.equal(calls.create, 0);
  assert.equal(calls.update, 0);
  assert.equal(sync.hasPending(), false);
});

test("deleting a record during its first save waits for creation and never revives it", async (t) => {
  const { api, sync, records, calls } = fixture(t);
  const started = deferred();
  const release = deferred();
  const create = api.create;
  api.create = async (value) => {
    started.resolve();
    await release.promise;
    return create(value);
  };
  sync.schedule(record("first"));
  const saving = sync.flush("record-one");
  await started.promise;
  sync.schedule(record("discarded edit"));
  const deletion = sync.remove("record-one");
  assert.equal(sync.hasPending(), true);
  release.resolve();
  await Promise.all([saving, deletion]);
  sync.schedule(record("stale"));
  await sync.flushAll();
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 0);
  assert.equal(calls.remove, 1);
  assert.equal(records.has("record-one"), false);
});

test("a newly deleted unsaved draft is never created later", async (t) => {
  const { sync, records, calls } = fixture(t);
  sync.schedule(record("never save"));
  await sync.remove("record-one");
  sync.adopt(record("stale adoption"));
  sync.schedule(record("stale update"));
  await sync.flushAll();
  assert.equal(records.size, 0);
  assert.equal(calls.create, 0);
  assert.equal(sync.hasPending(), false);
});

test("close flushing waits for deletion and simultaneous removes share one operation", async (t) => {
  const initial = record();
  const { api, sync, records, calls } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const remove = api.remove;
  api.remove = async (id) => {
    started.resolve();
    await release.promise;
    return remove(id);
  };
  const first = sync.remove(initial.id);
  const second = sync.remove(initial.id);
  assert.equal(first, second);
  await started.promise;
  assert.equal(sync.hasPending(), true);
  let closed = false;
  const closing = sync.flushAll().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([first, second, closing]);
  assert.equal(calls.remove, 1);
  assert.equal(records.has(initial.id), false);
  assert.equal(sync.hasPending(), false);
});

test("close flushing waits for a pending rename to reach persistence", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const rename = api.rename;
  api.rename = async (id, name) => {
    started.resolve();
    await release.promise;
    return rename(id, name);
  };
  const renaming = sync.rename(initial.id, "renamed.json");
  await started.promise;
  assert.equal(sync.hasPending(), true);
  let closed = false;
  const closing = sync.flushAll().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([renaming, closing]);
  assert.equal(records.get(initial.id)?.name, "renamed.json");
  assert.equal(sync.hasPending(), false);
});

test("renaming flushes all edits received during the previous write first", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  const started = deferred();
  const release = deferred();
  const update = api.update;
  const rename = api.rename;
  const actions: string[] = [];
  api.update = async (id, changes) => {
    actions.push(`update:${changes.raw}`);
    if (actions.length === 1) {
      started.resolve();
      await release.promise;
    }
    return update(id, changes);
  };
  api.rename = async (id, name) => {
    actions.push(`rename:${name}`);
    return rename(id, name);
  };
  sync.schedule(record("A"));
  const renaming = sync.rename(initial.id, "renamed.json");
  await started.promise;
  sync.schedule(record("B"));
  release.resolve();
  await renaming;
  assert.deepEqual(actions, ["update:A", "update:B", "rename:renamed.json"]);
  assert.equal(records.get(initial.id)?.raw, "B");
  assert.equal(records.get(initial.id)?.name, "renamed.json");
});

test("a rejected rename releases its close barrier without changing the saved record", async (t) => {
  const initial = record();
  const { api, sync, records } = fixture(t, [initial]);
  sync.adopt(initial);
  api.rename = async () => {
    throw new Error("name conflict");
  };
  await assert.rejects(
    sync.rename(initial.id, "existing.json"),
    /name conflict/,
  );
  assert.equal(sync.hasPending(), false);
  await sync.flushAll();
  assert.equal(records.get(initial.id)?.name, initial.name);
});

test("keeps a persisted history after a JSON file failure and retries as an update", async (t) => {
  const { api, sync, records, calls, events } = fixture(t);
  const create = api.create;
  api.create = async (value) => ({
    ...(await create(value)),
    fileSaveError: "JSON file permission denied",
  });
  sync.schedule(record("latest raw input"));
  await assert.rejects(sync.flush("record-one"), /permission denied/);
  assert.equal(records.get("record-one")?.raw, "latest raw input");
  assert.equal(events.at(-1)?.status, "error");
  assert.equal(sync.hasPending(), true);
  sync.schedule(record("latest raw input"));
  await setImmediate();
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 0);
  await sync.flushAll();
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 1);
  assert.equal(sync.hasPending(), false);
  assert.equal(events.at(-1)?.status, "saved");
});

test("retries a failed JSON file restored from history without requiring new edits", async (t) => {
  const initial = { ...record(), fileSaveError: "JSON file unavailable" };
  const { api, sync, records, calls } = fixture(t, [initial]);
  const update = api.update;
  api.update = async (id, changes) => {
    const saved = await update(id, changes);
    const restored = records.get(id)!;
    delete restored.fileSaveError;
    return { ...saved, fileSaveError: undefined };
  };
  sync.adopt(initial);
  assert.equal(sync.hasPending(), true);
  await sync.flushAll();
  assert.equal(calls.create, 0);
  assert.equal(calls.update, 1);
  assert.equal(sync.hasPending(), false);
});

test("does not discard edits that arrive while the ordinary JSON file fails to save", async (t) => {
  const { api, sync, records, calls } = fixture(t);
  const create = api.create;
  const started = deferred();
  const release = deferred();
  api.create = async (value) => {
    const saved = await create(value);
    started.resolve();
    await release.promise;
    return { ...saved, fileSaveError: "file unavailable" };
  };
  sync.schedule(record("first input"));
  const saving = sync.flush("record-one");
  const failure = assert.rejects(saving, /file unavailable/);
  await started.promise;
  sync.schedule(record("newest input"));
  release.resolve();
  await failure;
  await sync.flushAll();
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 1);
  assert.equal(records.get("record-one")?.raw, "newest input");
});
