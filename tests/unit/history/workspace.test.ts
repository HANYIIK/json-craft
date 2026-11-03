import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  stat,
  rm,
  access,
  symlink,
  unlink,
  link as nativeLink,
  rename as nativeRename,
  copyFile as nativeCopyFile,
  open as nativeOpen,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  HistoryRecord,
  HistorySummary,
  HistoryUpdate,
  ThemePreference,
  LanguagePreference,
  WorkspaceSettings,
  WorkspaceState,
} from "../../../src/shared/types";

interface Store {
  load(): Promise<WorkspaceState>;
  read(id: string): Promise<HistoryRecord>;
  create(record: HistoryRecord): Promise<HistorySummary>;
  update(id: string, update: HistoryUpdate): Promise<HistorySummary>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<HistorySummary>;
  updateSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings>;
  setActive(id: string | null): Promise<void>;
  getSettings(): Promise<WorkspaceSettings>;
  flush(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { createWorkspaceStore } =
  require("../../../electron/services/workspace-store.cjs") as {
    createWorkspaceStore(options: {
      userDataDirectory: string;
      documentsDirectory: string;
      io?: Record<string, unknown>;
      trashFile?: (filePath: string) => Promise<void>;
    }): Store;
  };

function record(
  id = "record-a",
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    id,
    name: `${id}.json`,
    raw: '{"id":9007199254740993}',
    source: "scratch",
    options: { indent: "2", autoUnescape: true, repair: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function fixture(
  t: TestContext,
  io?: Record<string, unknown>,
  trashFile?: ((filePath: string) => Promise<void>) | null,
) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "json-craft-store-")),
  );
  const userDataDirectory = path.join(directory, "app-data");
  const documentsDirectory = path.join(directory, "documents");
  const trashDirectory = path.join(directory, "trash");
  const trashedFiles: string[] = [];
  await mkdir(documentsDirectory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    userDataDirectory,
    documentsDirectory,
    io,
    trashFile:
      trashFile === null
        ? undefined
        : (trashFile ??
          (async (filePath: string) => {
            await mkdir(trashDirectory, { recursive: true });
            const destination = path.join(
              trashDirectory,
              `${trashedFiles.length}-${path.basename(filePath)}`,
            );
            await nativeRename(filePath, destination);
            trashedFiles.push(destination);
          })),
  };
  return {
    directory,
    userDataDirectory,
    documentsDirectory,
    trashedFiles,
    store: createWorkspaceStore(options),
    restart: () => createWorkspaceStore(options),
  };
}

test("starts empty without falsely marking a new workspace initialized", async (t) => {
  const { store, userDataDirectory, documentsDirectory } = await fixture(t);
  const state = await store.load();
  assert.equal(state.initialized, false);
  assert.equal(state.activeId, null);
  assert.deepEqual(state.records, []);
  assert.equal(state.settings.theme, "system");
  assert.equal(state.settings.autoCopy, false);
  assert.equal(state.settings.recursiveUnescape, true);
  assert.equal(state.settings.language, "system");
  assert.equal(
    state.settings.historyDirectory,
    await realpath(path.join(userDataDirectory, "history")),
  );
  assert.equal(
    state.settings.readDirectory,
    await realpath(documentsDirectory),
  );
});

test("creates persistent records without parsing or normalizing the input", async (t) => {
  const { store, restart } = await fixture(t);
  const raw = '\n{"id":9007199254740993,"x":1,"x":2, unfinished';
  const saved = await store.create(record("first", { raw }));
  assert.equal(saved.characters, raw.length);
  assert.equal((await store.read("first")).raw, raw);
  const state = await restart().load();
  assert.equal(state.initialized, true);
  assert.equal(state.activeId, "first");
  assert.equal(state.records[0].characters, raw.length);
  assert.ok(!Object.hasOwn(state.records[0], "raw"));
  assert.equal((await restart().read("first")).raw, raw);
});

test("updates input, options and extraction and restores the latest values after restart", async (t) => {
  const { store, restart } = await fixture(t);
  const original = await store.create(record());
  const update: HistoryUpdate = {
    raw: '{"payload":false}',
    options: { indent: "4", repair: false, autoUnescape: false },
    extraction: { key: "payload", path: "$.payload", occurrence: 1 },
  };
  await store.update(original.id, update);
  const saved = await restart().read(original.id);
  assert.equal(saved.raw, update.raw);
  assert.deepEqual(saved.options, update.options);
  assert.deepEqual(saved.extraction, update.extraction);
  assert.equal(saved.createdAt, original.createdAt);
  await store.update(original.id, { ...update, extraction: null });
  assert.equal((await store.read(original.id)).extraction, undefined);
});

test("deleting the final history keeps initialization and leaves the imported source intact", async (t) => {
  const { store, directory, restart, trashedFiles } = await fixture(t);
  const sourcePath = path.join(directory, "source.json");
  await writeFile(sourcePath, '{"keep":true}');
  const saved = await store.create(
    record("only", { source: "imported", sourcePath, name: "source.json" }),
  );
  await store.remove("only");
  const state = await restart().load();
  assert.equal(state.initialized, true);
  assert.equal(state.activeId, null);
  assert.deepEqual(state.records, []);
  await assert.rejects(access(saved.managedPath!), { code: "ENOENT" });
  assert.equal(await readFile(trashedFiles[0], "utf8"), record().raw);
  assert.equal(await readFile(sourcePath, "utf8"), '{"keep":true}');
});

test("late queued updates cannot recreate a deleted history record or JSON file", async (t) => {
  const { store, restart, trashedFiles } = await fixture(t);
  const saved = await store.create(record());
  const removal = store.remove("record-a");
  await assert.rejects(
    store.update("record-a", {
      raw: "new",
      options: record().options,
      extraction: null,
    }),
    /已删除|不存在/,
  );
  await removal;
  await assert.rejects(access(saved.managedPath!), { code: "ENOENT" });
  assert.equal(await readFile(trashedFiles[0], "utf8"), record().raw);
  assert.deepEqual((await restart().load()).records, []);
});

test("deleting a managed JSON file preserves the other history and selects it", async (t) => {
  const { store, restart, trashedFiles } = await fixture(t);
  const first = await store.create(record("first"));
  const second = await store.create(record("second"));
  await store.remove(first.id);
  await assert.rejects(access(first.managedPath!), { code: "ENOENT" });
  assert.equal(await readFile(trashedFiles[0], "utf8"), record().raw);
  assert.equal(await readFile(second.managedPath!, "utf8"), record().raw);
  const state = await restart().load();
  assert.equal(state.activeId, second.id);
  assert.deepEqual(
    state.records.map((item) => item.id),
    [second.id],
  );
});

test("deleting a same-directory import trashes the reused source file", async (t) => {
  const { store, documentsDirectory, restart, trashedFiles } = await fixture(t);
  const sourcePath = path.join(documentsDirectory, "reused.json");
  await writeFile(sourcePath, record().raw);
  const saved = await store.create(
    record("reused", { source: "imported", sourcePath, name: "reused.json" }),
  );
  assert.equal(saved.managedPath, sourcePath);
  await store.remove(saved.id);
  await assert.rejects(access(sourcePath), { code: "ENOENT" });
  assert.equal(await readFile(trashedFiles[0], "utf8"), record().raw);
  assert.deepEqual((await restart().load()).records, []);
});

test("missing managed files and records without files can be removed without a trash handler", async (t) => {
  const { store, restart } = await fixture(t, undefined, null);
  const saved = await store.create(record("missing"));
  await unlink(saved.managedPath!);
  await store.remove(saved.id);
  const sample = await store.create(record("sample", { source: "sample" }));
  assert.equal(sample.managedPath, undefined);
  await store.remove(sample.id);
  const state = await restart().load();
  assert.equal(state.activeId, null);
  assert.equal(state.initialized, true);
  assert.deepEqual(state.records, []);
});

test("existing managed files require a trash handler and preserve history when it is absent", async (t) => {
  const { store, restart } = await fixture(t, undefined, null);
  const saved = await store.create(record());
  await assert.rejects(store.remove(saved.id), /回收站/);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  const state = await restart().load();
  assert.equal(state.activeId, saved.id);
  assert.deepEqual(
    state.records.map((item) => item.id),
    [saved.id],
  );
});

test("trash failures restore history and the active record without changing JSON files", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(
    t,
    undefined,
    async () => {
      throw new Error("trash blocked");
    },
  );
  const first = await store.create(record("first"));
  await store.create(record("second"));
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const originalConfig = await readFile(configPath, "utf8");
  await assert.rejects(store.remove(first.id), /trash blocked/);
  assert.equal(await readFile(first.managedPath!, "utf8"), record().raw);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal((await store.load()).activeId, first.id);
  assert.equal((await restart().load()).activeId, first.id);
  assert.equal((await restart().read(first.id)).raw, record().raw);
});

test("a missing trash service cannot silently remove history while its JSON file still exists", async (t) => {
  const { store, restart } = await fixture(t, undefined, async () => {
    throw Object.assign(new Error("trash directory missing"), {
      code: "ENOENT",
    });
  });
  const saved = await store.create(record());
  await assert.rejects(store.remove(saved.id), /trash directory missing/);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  assert.equal((await restart().load()).activeId, saved.id);
  assert.equal((await restart().read(saved.id)).raw, record().raw);
});

test("a JSON file disappearing before trashing still allows its history to be removed", async (t) => {
  const { store, restart } = await fixture(t, undefined, async (filePath) => {
    await unlink(filePath);
    throw Object.assign(new Error("JSON file disappeared"), { code: "ENOENT" });
  });
  const saved = await store.create(record());
  await store.remove(saved.id);
  await assert.rejects(access(saved.managedPath!), { code: "ENOENT" });
  const state = await restart().load();
  assert.equal(state.activeId, null);
  assert.deepEqual(state.records, []);
});

test("history deletion failures leave the managed file out of trash and restore the active record", async (t) => {
  let fail = false;
  const { store, restart, trashedFiles } = await fixture(t, {
    unlink: async (filePath: string) => {
      if (fail && path.basename(filePath) === "history-protected.json")
        throw new Error("history removal blocked");
      await unlink(filePath);
    },
  });
  const saved = await store.create(record("protected"));
  fail = true;
  await assert.rejects(store.remove(saved.id), /history removal blocked/);
  assert.deepEqual(trashedFiles, []);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  assert.equal((await restart().load()).activeId, saved.id);
  assert.equal((await restart().read(saved.id)).raw, record().raw);
});

test("settings commit failures preserve both history and JSON files before trashing", async (t) => {
  let fail = false;
  const { store, restart, trashedFiles } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to) === "workspace-settings.json")
        throw new Error("settings removal blocked");
      await nativeRename(from, to);
    },
  });
  const saved = await store.create(record());
  fail = true;
  await assert.rejects(store.remove(saved.id), /settings removal blocked/);
  assert.deepEqual(trashedFiles, []);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  assert.equal((await restart().load()).activeId, saved.id);
  assert.equal((await restart().read(saved.id)).raw, record().raw);
});

test("managed-path symbolic links and directories cannot authorize deleting their targets", async (t) => {
  const { store, directory, restart, trashedFiles } = await fixture(t);
  const saved = await store.create(record("replaced"));
  await unlink(saved.managedPath!);
  const protectedPath = path.join(directory, "protected.json");
  await writeFile(protectedPath, "protected source");
  await symlink(protectedPath, saved.managedPath!);
  await assert.rejects(store.remove(saved.id), /不是普通文件/);
  assert.equal(await readFile(protectedPath, "utf8"), "protected source");
  await unlink(saved.managedPath!);
  await mkdir(saved.managedPath!);
  await assert.rejects(store.remove(saved.id), /不是普通文件/);
  assert.deepEqual(trashedFiles, []);
  assert.equal((await restart().load()).activeId, saved.id);
});

test("authoritative managed paths cannot delete application settings or history envelopes", async (t) => {
  const { store, userDataDirectory, trashedFiles } = await fixture(t);
  const saved = await store.create(record("unsafe"));
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const historyPath = path.join(
    (await store.getSettings()).historyDirectory,
    `history-${saved.id}.json`,
  );
  const original = await store.read(saved.id);
  const originalConfig = await readFile(configPath, "utf8");
  for (const managedPath of [configPath, historyPath]) {
    const envelope = JSON.stringify({ ...original, managedPath });
    await writeFile(historyPath, envelope);
    await assert.rejects(store.remove(saved.id), /应用数据冲突/);
    assert.equal(await readFile(historyPath, "utf8"), envelope);
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
  }
  assert.deepEqual(trashedFiles, []);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
});

test("deleting a shared managed file retains the other history without recreating the file", async (t) => {
  const { store, documentsDirectory, restart, trashedFiles } = await fixture(t);
  const sourcePath = path.join(documentsDirectory, "shared.json");
  await writeFile(sourcePath, record().raw);
  const imported = {
    source: "imported" as const,
    sourcePath,
    name: "shared.json",
  };
  const first = await store.create(record("first", imported));
  const second = await store.create(record("second", imported));
  assert.equal(first.managedPath, second.managedPath);
  await store.remove(first.id);
  assert.equal(trashedFiles.length, 1);
  assert.equal(await readFile(trashedFiles[0], "utf8"), record().raw);
  await assert.rejects(access(sourcePath), { code: "ENOENT" });
  assert.equal((await store.read(second.id)).raw, record().raw);
  const state = await restart().load();
  assert.equal(state.activeId, second.id);
  assert.deepEqual(
    state.records.map((item) => item.id),
    [second.id],
  );
  assert.equal((await restart().read(second.id)).raw, record().raw);
  await assert.rejects(access(sourcePath), { code: "ENOENT" });
  await store.remove(second.id);
  assert.equal(trashedFiles.length, 1);
  assert.deepEqual((await restart().load()).records, []);
});

test("duplicate record IDs never overwrite previously saved content", async (t) => {
  const { store } = await fixture(t);
  await store.create(record("same", { raw: "original" }));
  await assert.rejects(
    store.create(record("same", { raw: "replacement" })),
    /已存在/,
  );
  assert.equal((await store.read("same")).raw, "original");
});

test("allows existing duplicate imports but rejects colliding history renames case-insensitively", async (t) => {
  const { store } = await fixture(t);
  await store.create(record("one", { name: "duplicate.json" }));
  await store.create(record("two", { name: "duplicate.json" }));
  await store.create(record("three", { name: "available.json" }));
  await assert.rejects(store.rename("three", "DUPLICATE.JSON"), /同名/);
  assert.equal((await store.read("three")).name, "available.json");
  const renamed = await store.rename("three", "new-name");
  assert.equal(renamed.name, "new-name.json");
  assert.equal((await store.read("one")).name, "duplicate.json");
});

test("renames the managed import while retaining the external source", async (t) => {
  const { store, directory, documentsDirectory, restart } = await fixture(t);
  const sourcePath = path.join(directory, "original.json");
  const content = '{"id":9007199254740993}';
  await writeFile(sourcePath, content);
  await store.create(
    record("imported", {
      name: "original.json",
      source: "imported",
      sourcePath,
      raw: "history edited independently",
    }),
  );
  const renamed = await store.rename("imported", "renamed.json");
  const destination = path.join(documentsDirectory, "renamed.json");
  assert.equal(renamed.sourcePath, sourcePath);
  assert.equal(renamed.managedPath, destination);
  assert.equal(await readFile(sourcePath, "utf8"), content);
  assert.equal(
    await readFile(destination, "utf8"),
    "history edited independently",
  );
  await assert.rejects(access(path.join(documentsDirectory, "original.json")));
  assert.equal(
    (await restart().read("imported")).raw,
    "history edited independently",
  );
  assert.equal((await restart().read("imported")).name, "renamed.json");
});

test("disk name conflicts leave both source and target untouched", async (t) => {
  const { store, directory, documentsDirectory } = await fixture(t);
  const sourcePath = path.join(directory, "source.json");
  const target = path.join(documentsDirectory, "target.json");
  await writeFile(sourcePath, '"original"');
  await writeFile(target, '"protected"');
  await store.create(
    record("imported", { name: "source.json", source: "imported", sourcePath }),
  );
  await assert.rejects(store.rename("imported", "target.json"), /同名/);
  assert.equal(await readFile(sourcePath, "utf8"), '"original"');
  assert.equal(await readFile(target, "utf8"), '"protected"');
  assert.equal((await store.read("imported")).name, "source.json");
});

test("a missing external source can be recovered while invalid names preserve the managed file", async (t) => {
  const { store, directory, documentsDirectory } = await fixture(t);
  await store.create(
    record("missing", {
      name: "missing.json",
      source: "imported",
      sourcePath: path.join(directory, "missing.json"),
    }),
  );
  const renamed = await store.rename("missing", "next.json");
  assert.equal(renamed.managedPath, path.join(documentsDirectory, "next.json"));
  assert.equal(await readFile(renamed.managedPath!, "utf8"), record().raw);
  for (const name of [
    "",
    "../secret.json",
    "x/y.json",
    "a\\b.json",
    "CON.json",
    "file?.json",
    " white.json",
    "white.json ",
  ])
    await assert.rejects(store.rename("missing", name));
  assert.equal((await store.read("missing")).name, "next.json");
});

test("updates cannot bypass the dedicated rename operation", async (t) => {
  const { store } = await fixture(t);
  await store.create(record());
  const forbidden = {
    raw: "changed",
    options: record().options,
    extraction: null,
    name: "bypass.json",
  };
  await assert.rejects(store.update("record-a", forbidden), /重命名/);
  assert.equal((await store.read("record-a")).raw, record().raw);
});

test("recursively creates and persists missing read, write and history directories", async (t) => {
  const { store, directory, restart } = await fixture(t);
  const canonicalParent = path.join(directory, "canonical-settings");
  const alias = path.join(directory, "settings-alias");
  await mkdir(canonicalParent);
  await symlink(canonicalParent, alias, "junction");
  const readDirectory = path.join(alias, "new-read", "nested", "json");
  const writeDirectory = path.join(alias, "new-write", "nested", "json");
  const historyDirectory = path.join(alias, "new-history", "nested", "data");
  await store.updateSettings({
    readDirectory,
    writeDirectory,
    historyDirectory,
  });
  const restored = await restart().getSettings();
  assert.equal(restored.readDirectory, await realpath(readDirectory));
  assert.equal(restored.writeDirectory, await realpath(writeDirectory));
  assert.equal(restored.historyDirectory, await realpath(historyDirectory));
  assert.notEqual(restored.readDirectory, readDirectory);
  for (const directory of [readDirectory, writeDirectory, historyDirectory])
    assert.equal((await stat(directory)).isDirectory(), true);
  assert.deepEqual((await restart().load()).settings, restored);
  await assert.rejects(
    store.updateSettings({ readDirectory: "relative/path" }),
    /绝对/,
  );
});

test("creates fresh user data, documents and default history directories before loading", async (t) => {
  const { store, restart, userDataDirectory, documentsDirectory } =
    await fixture(t);
  await rm(documentsDirectory, { recursive: true });
  await assert.rejects(access(userDataDirectory), { code: "ENOENT" });
  await assert.rejects(access(documentsDirectory), { code: "ENOENT" });
  const loaded = await store.load();
  assert.equal(loaded.initialized, false);
  assert.equal(loaded.activeId, null);
  assert.deepEqual(loaded.records, []);
  assert.equal(
    loaded.settings.readDirectory,
    await realpath(documentsDirectory),
  );
  assert.equal(
    loaded.settings.writeDirectory,
    await realpath(documentsDirectory),
  );
  assert.equal(
    loaded.settings.historyDirectory,
    await realpath(path.join(userDataDirectory, "history")),
  );
  assert.equal((await stat(userDataDirectory)).isDirectory(), true);
  assert.deepEqual(await restart().load(), loaded);
});

test("loads existing initialized and uninitialized configurations with missing configured directories", async (t) => {
  for (const initialized of [false, true]) {
    await t.test(`initialized ${initialized}`, async (t) => {
      const { store, restart, directory, userDataDirectory } = await fixture(t);
      const settings: WorkspaceSettings = {
        readDirectory: path.join(directory, "configured", "read", "deep"),
        writeDirectory: path.join(directory, "configured", "files", "deep"),
        historyDirectory: path.join(directory, "configured", "history", "deep"),
        theme: "dark",
        autoCopy: true,
      };
      await mkdir(userDataDirectory);
      await writeFile(
        path.join(userDataDirectory, "workspace-settings.json"),
        JSON.stringify({
          version: 1,
          initialized,
          activeId: initialized ? "previous-record" : null,
          settings,
        }),
      );
      const loaded = await store.load();
      assert.equal(loaded.initialized, initialized);
      assert.equal(loaded.activeId, null);
      assert.deepEqual(loaded.records, []);
      assert.equal(loaded.settings.theme, "dark");
      assert.equal(loaded.settings.autoCopy, true);
      for (const key of [
        "readDirectory",
        "writeDirectory",
        "historyDirectory",
      ] as const) {
        assert.equal((await stat(settings[key])).isDirectory(), true);
        assert.equal(loaded.settings[key], await realpath(settings[key]));
      }
      assert.deepEqual(await restart().load(), loaded);
    });
  }
});

test("directory creation failures preserve existing configuration and history", async (t) => {
  for (const code of ["EACCES", "ENOTDIR"]) {
    await t.test(code, async (t) => {
      let blocked = "";
      const { store, restart, directory, userDataDirectory } = await fixture(
        t,
        {
          mkdir: async (
            target: string,
            options?: { recursive?: boolean; mode?: number | string },
          ) => {
            if (target === blocked)
              throw Object.assign(
                new Error(`injected directory failure ${code}`),
                { code },
              );
            return mkdir(target, options);
          },
        },
      );
      await store.create(record("preserved", { raw: "unfinished original" }));
      const previous = await store.read("preserved");
      const settings = await store.getSettings();
      const configPath = path.join(
        userDataDirectory,
        "workspace-settings.json",
      );
      const config = await readFile(configPath, "utf8");
      blocked = path.join(directory, "blocked", "deep");
      await assert.rejects(
        store.updateSettings({ writeDirectory: blocked }),
        /目录|权限|EACCES|ENOTDIR|injected/,
      );
      assert.equal(await readFile(configPath, "utf8"), config);
      assert.deepEqual(await store.getSettings(), settings);
      assert.deepEqual(await store.read("preserved"), previous);
      assert.deepEqual(await restart().read("preserved"), previous);
      await assert.rejects(access(blocked), { code: "ENOENT" });
    });
  }
});

test("a failed configured-directory startup preserves the configuration and can retry on the same store", async (t) => {
  let blocked = "";
  let denied = true;
  const { store, directory, userDataDirectory, documentsDirectory } =
    await fixture(t, {
      mkdir: async (
        target: string,
        options?: { recursive?: boolean; mode?: number | string },
      ) => {
        if (denied && target === blocked)
          throw Object.assign(new Error("injected startup mkdir denied"), {
            code: "EACCES",
          });
        return mkdir(target, options);
      },
    });
  blocked = path.join(directory, "startup-history", "nested");
  const settings: WorkspaceSettings = {
    readDirectory: documentsDirectory,
    writeDirectory: documentsDirectory,
    historyDirectory: blocked,
    theme: "light",
    autoCopy: true,
  };
  await mkdir(userDataDirectory);
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const config = JSON.stringify({
    version: 1,
    initialized: true,
    activeId: null,
    settings,
  });
  await writeFile(configPath, config);
  await assert.rejects(store.load(), /目录|权限|EACCES|denied/);
  await assert.rejects(store.getSettings(), /目录|权限|EACCES|denied/);
  assert.equal(await readFile(configPath, "utf8"), config);
  await assert.rejects(access(blocked), { code: "ENOENT" });
  denied = false;
  const recovered = await store.load();
  assert.equal(recovered.initialized, true);
  assert.deepEqual(recovered.records, []);
  assert.equal(recovered.settings.historyDirectory, await realpath(blocked));
  assert.equal(recovered.settings.autoCopy, true);
  assert.equal(await readFile(configPath, "utf8"), config);
});

test("directory access failures reject each setting without changing configuration or history", async (t) => {
  let blocked = "";
  const { store, directory, userDataDirectory } = await fixture(t, {
    access: async (target: string, mode?: number) => {
      if (target === blocked)
        throw Object.assign(new Error("injected access denied"), {
          code: "EACCES",
        });
      return access(target, mode);
    },
  });
  await store.create(record("preserved"));
  const original = await store.read("preserved");
  const settings = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const config = await readFile(configPath, "utf8");
  blocked = path.join(directory, "inaccessible");
  await mkdir(blocked);
  for (const key of [
    "readDirectory",
    "writeDirectory",
    "historyDirectory",
  ] as const)
    await assert.rejects(
      store.updateSettings({ [key]: blocked }),
      /权限|EACCES|denied/,
    );
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.deepEqual(await store.getSettings(), settings);
  assert.deepEqual(await store.read("preserved"), original);
  assert.deepEqual(await readdir(blocked), []);
});

test("files occupying directory paths remain untouched for direct and nested settings", async (t) => {
  const { store, directory, userDataDirectory } = await fixture(t);
  await store.create(record("preserved"));
  const original = await store.read("preserved");
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const config = await readFile(configPath, "utf8");
  const occupied = path.join(directory, "occupied-file");
  const content = "This ordinary file must be retained.";
  await writeFile(occupied, content);
  for (const key of [
    "readDirectory",
    "writeDirectory",
    "historyDirectory",
  ] as const)
    for (const target of [occupied, path.join(occupied, "nested", "json")])
      await assert.rejects(store.updateSettings({ [key]: target }));
  assert.equal(await readFile(occupied, "utf8"), content);
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.deepEqual(await store.read("preserved"), original);
});

test("invalid mixed setting patches create none of their otherwise valid new directories", async (t) => {
  const { store, directory, userDataDirectory } = await fixture(t);
  await store.create(record("preserved"));
  const original = await store.read("preserved");
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const config = await readFile(configPath, "utf8");
  const invalid = [
    ["writeDirectory", "relative/path"],
    ["historyDirectory", "relative/path"],
    ["writeDirectory", `${directory}/nul\0path`],
    ["historyDirectory", undefined],
    ["theme", "invalid-theme"],
    ["autoCopy", "true"],
    ["recursiveUnescape", "true"],
    ["language", "fr"],
    ["unexpectedSetting", true],
  ] as const;
  for (const [index, [key, value]] of invalid.entries()) {
    const prefix = path.join(directory, `invalid-batch-${index}`);
    const patch = {
      readDirectory: path.join(prefix, "read", "deep"),
      writeDirectory: path.join(prefix, "files", "deep"),
      historyDirectory: path.join(prefix, "history", "deep"),
      [key]: value,
    } as unknown as Partial<WorkspaceSettings>;
    await assert.rejects(store.updateSettings(patch));
    await assert.rejects(access(prefix), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), config);
  }
  assert.deepEqual(await store.read("preserved"), original);
});

test("invalid settings on a cold store create neither default nor candidate directories", async (t) => {
  const { store, directory, userDataDirectory, documentsDirectory } =
    await fixture(t);
  await rm(documentsDirectory, { recursive: true });
  const candidate = path.join(directory, "cold-candidate");
  const validPaths = {
    readDirectory: path.join(candidate, "read"),
    writeDirectory: path.join(candidate, "files"),
    historyDirectory: path.join(candidate, "history"),
  };
  const invalid = [
    undefined,
    null,
    [],
    { ...validPaths, theme: "invalid-theme" },
    { ...validPaths, autoCopy: "true" },
    { ...validPaths, recursiveUnescape: "true" },
    { ...validPaths, language: "fr" },
    { ...validPaths, historyDirectory: "relative/path" },
    { ...validPaths, writeDirectory: `${directory}/nul\0path` },
    { ...validPaths, unexpectedSetting: true },
  ];
  for (const patch of invalid) {
    await assert.rejects(
      store.updateSettings(patch as unknown as Partial<WorkspaceSettings>),
    );
    for (const target of [userDataDirectory, documentsDirectory, candidate])
      await assert.rejects(access(target), { code: "ENOENT" });
  }
});

test("startup read/write failures preserve access to history and can recover files through new directories", async (t) => {
  for (const failure of ["occupied file", "EACCES"]) {
    await t.test(failure, async (t) => {
      let blocked = "";
      let denied = false;
      const {
        store,
        restart,
        directory,
        documentsDirectory,
        userDataDirectory,
      } = await fixture(t, {
        access: async (target: string, mode?: number) => {
          if (denied && target === blocked)
            throw Object.assign(new Error("injected startup access denied"), {
              code: "EACCES",
            });
          return access(target, mode);
        },
        open: async (target: string, flags: string, mode?: number) => {
          if (denied && path.dirname(target) === blocked)
            throw Object.assign(
              new Error("injected ordinary file write denied"),
              { code: "EACCES" },
            );
          return nativeOpen(target, flags, mode);
        },
      });
      const saved = await store.create(record("startup-preserved"));
      const original = await store.read(saved.id);
      const previous = await store.load();
      const configPath = path.join(
        userDataDirectory,
        "workspace-settings.json",
      );
      const config = await readFile(configPath, "utf8");
      const backup = path.join(directory, "documents-preserved");
      if (failure === "occupied file") {
        await nativeRename(documentsDirectory, backup);
        await writeFile(
          documentsDirectory,
          "This occupying file must not be replaced.",
        );
      } else {
        blocked = documentsDirectory;
        denied = true;
      }
      const reopened = restart();
      const loaded = await reopened.load();
      assert.equal(loaded.initialized, true);
      assert.equal(loaded.activeId, saved.id);
      assert.deepEqual(loaded.settings, previous.settings);
      assert.equal(loaded.records.length, 1);
      assert.deepEqual(await reopened.read(saved.id), original);
      assert.equal(await readFile(configPath, "utf8"), config);
      const raw = '{"latest":"retained despite ordinary file failure"}';
      const failed = await reopened.update(saved.id, {
        raw,
        options: original.options,
        extraction: null,
      });
      assert.ok(failed.fileSaveError);
      assert.equal((await reopened.read(saved.id)).raw, raw);
      const readDirectory = path.join(directory, "recovered", "read", "deep");
      const writeDirectory = path.join(directory, "recovered", "files", "deep");
      await reopened.updateSettings({ readDirectory, writeDirectory });
      const recovered = await reopened.read(saved.id);
      assert.equal(recovered.id, saved.id);
      assert.equal(recovered.fileSaveError, undefined);
      assert.equal(
        recovered.managedPath,
        path.join(await realpath(writeDirectory), recovered.name),
      );
      assert.equal(await readFile(recovered.managedPath!, "utf8"), raw);
      const state = await restart().load();
      assert.equal(state.records.length, 1);
      assert.equal(state.activeId, saved.id);
      assert.equal(state.settings.readDirectory, await realpath(readDirectory));
      assert.equal(
        state.settings.writeDirectory,
        await realpath(writeDirectory),
      );
      if (failure === "occupied file") {
        assert.equal(
          await readFile(documentsDirectory, "utf8"),
          "This occupying file must not be replaced.",
        );
        assert.equal(
          await readFile(path.join(backup, original.name), "utf8"),
          original.raw,
        );
      } else {
        assert.equal(
          await readFile(original.managedPath!, "utf8"),
          original.raw,
        );
      }
    });
  }
});

test("a history directory moved after loading is recreated empty without fabricating missing records", async (t) => {
  const { store, directory, userDataDirectory } = await fixture(t);
  const saved = await store.create(
    record("existing", { raw: "retained history input" }),
  );
  const loaded = await store.load();
  const history = loaded.settings.historyDirectory;
  const backup = path.join(directory, "externally-moved-history");
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const config = await readFile(configPath, "utf8");
  const original = await readFile(
    path.join(history, "history-existing.json"),
    "utf8",
  );
  await nativeRename(history, backup);
  const missing = await store.load();
  assert.equal((await stat(history)).isDirectory(), true);
  assert.deepEqual(missing.records, []);
  assert.equal(missing.initialized, true);
  assert.equal(missing.activeId, null);
  assert.deepEqual(missing.settings, loaded.settings);
  await assert.rejects(store.read(saved.id), /历史|目录|不存在|ENOENT/);
  await assert.rejects(
    store.update(saved.id, {
      raw: "cannot replace missing history",
      options: record().options,
      extraction: null,
    }),
  );
  await assert.rejects(access(path.join(history, "history-existing.json")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(path.join(backup, "history-existing.json"), "utf8"),
    original,
  );
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.equal(
    await readFile(saved.managedPath!, "utf8"),
    "retained history input",
  );
});

test("persists each theme preference across restarts without changing history or directories", async (t) => {
  const { store, restart } = await fixture(t);
  await store.create(record());
  const initial = await store.getSettings();
  const themes: ThemePreference[] = ["dark", "light", "system"];
  for (const theme of themes) {
    const settings = await store.updateSettings({ theme });
    assert.deepEqual(settings, { ...initial, theme });
    const restored = await restart().load();
    assert.deepEqual(restored.settings, { ...initial, theme });
    assert.equal(restored.activeId, "record-a");
    assert.equal((await restart().read("record-a")).raw, record().raw);
  }
});

test("persists language choices across restarts without changing document data", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  for (const language of ["en", "zh-CN", "system"] as LanguagePreference[]) {
    assert.deepEqual(await store.updateSettings({ language }), {
      ...initial,
      language,
    });
    const restored = await restart().load();
    assert.deepEqual(restored.settings, { ...initial, language });
    assert.equal(restored.activeId, "record-a");
    const saved = await restart().read("record-a");
    assert.equal(saved.raw, record().raw);
    assert.equal(saved.name, record().name);
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).settings.language,
      language,
    );
  }
});

test("legacy workspaces default to system language and keep their original records", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const legacy = JSON.parse(await readFile(configPath, "utf8"));
  delete legacy.settings.language;
  await writeFile(configPath, JSON.stringify(legacy));
  const restored = restart();
  assert.deepEqual((await restored.load()).settings, initial);
  assert.equal((await restored.read("record-a")).raw, record().raw);
  await restored.updateSettings({ language: "en" });
  assert.equal((await restart().load()).settings.language, "en");
});

test("invalid language settings preserve configuration, content, and candidate folders", async (t) => {
  const { store, restart, directory, userDataDirectory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ language: "en" });
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const original = await readFile(configPath, "utf8");
  const candidate = path.join(directory, "unused-language-history");
  for (const invalid of ["fr", "zh", "en-US", "", null, undefined, 1, {}, []]) {
    await assert.rejects(
      store.updateSettings({
        language: invalid as LanguagePreference,
        historyDirectory: candidate,
      }),
      /语言/,
    );
    assert.deepEqual(await store.getSettings(), initial);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(access(candidate), { code: "ENOENT" });
    assert.equal((await restart().read("record-a")).raw, record().raw);
  }
  const invalid = JSON.parse(original);
  invalid.settings.language = "fr";
  const content = JSON.stringify(invalid);
  await writeFile(configPath, content);
  await assert.rejects(restart().load(), /语言/);
  assert.equal(await readFile(configPath, "utf8"), content);
});

test("persists automatic copying as a workspace preference without changing format options or history", async (t) => {
  const { store, restart } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ theme: "dark" });
  const initial = await store.getSettings();
  for (const autoCopy of [true, false]) {
    assert.deepEqual(await store.updateSettings({ autoCopy }), {
      ...initial,
      autoCopy,
    });
    const restored = await restart().load();
    assert.deepEqual(restored.settings, { ...initial, autoCopy });
    assert.equal(restored.activeId, "record-a");
    const saved = await restart().read("record-a");
    assert.equal(saved.raw, record().raw);
    assert.deepEqual(saved.options, record().options);
    assert.equal(Object.hasOwn(saved.options, "autoCopy"), false);
  }
});

test("legacy configuration without automatic copying defaults to disabled and preserves its saved theme", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ theme: "dark" });
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const legacy = JSON.parse(await readFile(configPath, "utf8"));
  delete legacy.settings.autoCopy;
  await writeFile(configPath, JSON.stringify(legacy));

  const restored = restart();
  assert.deepEqual((await restored.load()).settings, initial);
  assert.equal((await restored.read("record-a")).raw, record().raw);
  await restored.updateSettings({ autoCopy: true });
  assert.equal((await restart().getSettings()).autoCopy, true);
  assert.equal((await restart().getSettings()).theme, "dark");
});

test("invalid automatic-copy patches preserve all settings, records and migration destinations", async (t) => {
  const { store, restart, userDataDirectory, directory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ autoCopy: true, theme: "dark" });
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const original = await readFile(configPath, "utf8");
  const target = path.join(directory, "history-target");
  await mkdir(target);
  for (const invalid of ["true", "false", 1, 0, null, undefined, {}, []]) {
    await assert.rejects(
      store.updateSettings({
        autoCopy: invalid as boolean,
        theme: "light",
        readDirectory: target,
        historyDirectory: target,
      }),
      /自动复制/,
    );
    assert.deepEqual(await store.getSettings(), initial);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.deepEqual(await readdir(target), []);
    assert.equal((await restart().read("record-a")).raw, record().raw);
  }
});

test("invalid stored automatic-copy values are reported without replacing the configuration", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const invalid = JSON.parse(await readFile(configPath, "utf8"));
  invalid.settings.autoCopy = "false";
  const content = JSON.stringify(invalid);
  await writeFile(configPath, content);
  await assert.rejects(restart().load(), /自动复制/);
  assert.equal(await readFile(configPath, "utf8"), content);
  assert.equal((await store.read("record-a")).raw, record().raw);
});

test("legacy configuration without a theme keeps its records and defaults to the system theme", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const settings = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const legacy = JSON.parse(await readFile(configPath, "utf8"));
  delete legacy.settings.theme;
  await writeFile(configPath, JSON.stringify(legacy));

  const restored = restart();
  const state = await restored.load();
  assert.deepEqual(state.settings, settings);
  assert.equal(state.settings.theme, "system");
  assert.equal(state.records.length, 1);
  assert.equal((await restored.read("record-a")).raw, record().raw);
  await restored.updateSettings({ theme: "dark" });
  assert.equal((await restart().getSettings()).theme, "dark");
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).settings.theme,
    "dark",
  );
});

test("invalid theme patches leave configuration, records and migration destinations unchanged", async (t) => {
  const { store, restart, userDataDirectory, directory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ theme: "dark" });
  const before = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const originalConfig = await readFile(configPath, "utf8");
  const target = path.join(directory, "history-target");
  await mkdir(target);
  for (const invalid of ["auto", "", null, undefined, 42, {}]) {
    await assert.rejects(
      store.updateSettings({
        theme: invalid as ThemePreference,
        readDirectory: target,
        historyDirectory: target,
      }),
      /主题/,
    );
    assert.deepEqual(await store.getSettings(), before);
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.deepEqual(await readdir(target), []);
    assert.equal((await restart().read("record-a")).raw, record().raw);
  }
});

test("invalid stored theme preferences are reported while preserving the original configuration", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const invalid = JSON.parse(await readFile(configPath, "utf8"));
  invalid.settings.theme = "sepia";
  const content = JSON.stringify(invalid);
  await writeFile(configPath, content);
  await assert.rejects(restart().load(), /主题/);
  assert.equal(await readFile(configPath, "utf8"), content);
  assert.equal((await store.read("record-a")).raw, record().raw);
});

test("creates a nested history directory and migrates complete record metadata there", async (t) => {
  const { store, directory, restart } = await fixture(t);
  await store.create(
    record("a", {
      raw: '{"payload":false, unfinished',
      options: { indent: "4", autoUnescape: false, repair: false },
      extraction: { key: "payload", path: "$.payload", occurrence: 1 },
    }),
  );
  await store.create(record("b"));
  const original = await store.read("a");
  const before = (await store.load()).settings.historyDirectory;
  const target = path.join(directory, "new-parent", "nested", "history-target");
  await store.setActive("b");
  const settings = await store.updateSettings({
    historyDirectory: target,
    theme: "dark",
    autoCopy: true,
  });
  assert.equal(settings.historyDirectory, await realpath(target));
  await assert.rejects(access(path.join(before, "history-a.json")));
  await access(path.join(target, "history-a.json"));
  const restored = await restart().load();
  assert.equal(restored.settings.theme, "dark");
  assert.equal(restored.settings.autoCopy, true);
  assert.equal(restored.records.length, 2);
  assert.equal(restored.activeId, "b");
  assert.deepEqual(await restart().read("a"), original);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, "history-a.json"), "utf8")),
    original,
  );
});

test("choosing the current history directory is a no-op even with canonical path aliases", async (t) => {
  const { store } = await fixture(t);
  await store.create(record());
  const settings = (await store.load()).settings;
  await store.updateSettings({ historyDirectory: settings.historyDirectory });
  assert.equal((await store.read("record-a")).raw, record().raw);
});

test("history migration never replaces a conflicting record at the destination", async (t) => {
  const { store, directory } = await fixture(t);
  await store.create(record("same", { raw: "source" }));
  const before = (await store.load()).settings.historyDirectory;
  const target = path.join(directory, "target");
  await mkdir(target);
  const destination = path.join(target, "history-same.json");
  await writeFile(
    destination,
    JSON.stringify(record("same", { raw: "protected" })),
  );
  await assert.rejects(
    store.updateSettings({ historyDirectory: target }),
    /同标识/,
  );
  assert.equal((await store.load()).settings.historyDirectory, before);
  assert.equal((await store.read("same")).raw, "source");
  assert.equal(
    JSON.parse(await readFile(destination, "utf8")).raw,
    "protected",
  );
});

test("migration merges distinct destination records without modifying unrelated JSON files", async (t) => {
  const { store, directory } = await fixture(t);
  await store.create(record("source"));
  const target = path.join(directory, "target");
  await mkdir(target);
  await writeFile(
    path.join(target, "history-existing.json"),
    JSON.stringify(record("existing")),
  );
  await writeFile(path.join(target, "unrelated.json"), "user owned");
  await store.updateSettings({ historyDirectory: target });
  assert.deepEqual((await store.load()).records.map((item) => item.id).sort(), [
    "existing",
    "source",
  ]);
  assert.equal(
    await readFile(path.join(target, "unrelated.json"), "utf8"),
    "user owned",
  );
});

test("failed atomic updates preserve original data and do not poison subsequent writes", async (t) => {
  let fail = false;
  const { store, restart } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to).startsWith("history-"))
        throw new Error("injected write failure");
      await nativeRename(from, to);
    },
  });
  await store.create(record());
  fail = true;
  await assert.rejects(
    store.update("record-a", {
      raw: "replacement",
      options: record().options,
      extraction: null,
    }),
    /injected/,
  );
  assert.equal((await restart().read("record-a")).raw, record().raw);
  const directory = (await store.load()).settings.historyDirectory;
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  fail = false;
  await store.update("record-a", {
    raw: "latest",
    options: record().options,
    extraction: null,
  });
  assert.equal((await store.read("record-a")).raw, "latest");
});

test("corrupt configuration and records are reported and never silently overwritten", async (t) => {
  const { store, userDataDirectory, restart } = await fixture(t);
  await store.create(record());
  const directory = (await store.load()).settings.historyDirectory;
  const file = path.join(directory, "history-record-a.json");
  await writeFile(file, "broken JSON");
  await assert.rejects(restart().load(), /原文件已保留|不会被覆盖/);
  assert.equal(await readFile(file, "utf8"), "broken JSON");
  await assert.rejects(
    store.update("record-a", {
      raw: "replacement",
      options: record().options,
      extraction: null,
    }),
    /原文件已保留/,
  );
  assert.equal(await readFile(file, "utf8"), "broken JSON");
  const config = path.join(userDataDirectory, "workspace-settings.json");
  await writeFile(config, "corrupt config");
  await assert.rejects(restart().load(), /原文件已保留/);
  assert.equal(await readFile(config, "utf8"), "corrupt config");
});

test("validates byte limits, record IDs, options and extraction before persisting", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.create(record("../escape")), /标识/);
  await assert.rejects(
    store.create(record("large", { raw: "中".repeat(7 * 1024 * 1024) })),
    /20 MiB/,
  );
  await assert.rejects(
    store.create(
      record("bad", {
        options: {
          indent: "8",
          repair: true,
          autoUnescape: true,
        } as unknown as HistoryRecord["options"],
      }),
    ),
    /选项/,
  );
  await assert.rejects(
    store.create(
      record("bad", {
        extraction: { key: "payload", path: "payload", occurrence: 0 },
      }),
    ),
    /提取/,
  );
  assert.deepEqual((await store.load()).records, []);
});

test("serializes concurrent edits and preserves a concurrent rename", async (t) => {
  const { store, restart } = await fixture(t);
  await store.create(record());
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      store.update("record-a", {
        raw: `edit-${index}`,
        options: record().options,
        extraction: null,
      }),
    ),
    store.rename("record-a", "renamed.json"),
    store.update("record-a", {
      raw: "final edit",
      options: record().options,
      extraction: null,
    }),
  ]);
  const saved = await restart().read("record-a");
  assert.equal(saved.raw, "final edit");
  assert.equal(saved.name, "renamed.json");
  assert.ok(
    (
      await stat(
        path.join(
          (await store.load()).settings.historyDirectory,
          "history-record-a.json",
        ),
      )
    ).size > 0,
  );
});

test("a metadata write failure rolls back the uncommitted physical rename", async (t) => {
  let fail = false;
  const { store, directory, documentsDirectory } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to).startsWith("history-"))
        throw new Error("metadata write blocked");
      await nativeRename(from, to);
    },
  });
  const sourcePath = path.join(directory, "original.json");
  const target = path.join(directory, "renamed.json");
  await writeFile(sourcePath, '"protected source"');
  await store.create(
    record("physical", {
      name: "original.json",
      source: "imported",
      sourcePath,
    }),
  );
  fail = true;
  await assert.rejects(store.rename("physical", "renamed.json"), /blocked/);
  assert.equal(await readFile(sourcePath, "utf8"), '"protected source"');
  await assert.rejects(access(target));
  assert.equal(
    await readFile(path.join(documentsDirectory, "original.json"), "utf8"),
    record().raw,
  );
  await assert.rejects(access(path.join(documentsDirectory, "renamed.json")));
  assert.equal((await store.read("physical")).name, "original.json");
});

test("automatically stores exact input bytes as ordinary JSON and keeps the same file updated", async (t) => {
  const { store, documentsDirectory, restart } = await fixture(t);
  const raw = '\ufeff\n{"id":9007199254740993,"x":1,"x":2, unfinished';
  const saved = await store.create(
    record("plain", { name: "input.json", raw }),
  );
  const file = path.join(documentsDirectory, "input.json");
  assert.equal(saved.managedPath, file);
  assert.equal(saved.fileSaveError, undefined);
  assert.equal(await readFile(file, "utf8"), raw);
  await store.update(saved.id, {
    raw: "",
    options: record().options,
    extraction: null,
  });
  assert.equal(await readFile(file, "utf8"), "");
  await store.update(saved.id, {
    raw: '{"latest":true}',
    options: record().options,
    extraction: null,
  });
  assert.equal(await readFile(file, "utf8"), '{"latest":true}');
  assert.deepEqual(await readdir(documentsDirectory), ["input.json"]);
  assert.equal((await restart().read(saved.id)).managedPath, file);
});

test("seed samples and empty drafts wait for user input before creating ordinary files", async (t) => {
  const { store, documentsDirectory, restart } = await fixture(t);
  const sample = await store.create(record("sample", { source: "sample" }));
  const draft = await store.create(record("empty", { raw: "" }));
  assert.equal(sample.managedPath, undefined);
  assert.equal(draft.managedPath, undefined);
  await restart().load();
  assert.deepEqual(await readdir(documentsDirectory), []);
  await store.update(sample.id, {
    raw: "sample edit",
    options: record().options,
    extraction: null,
  });
  await store.update(draft.id, {
    raw: "draft edit",
    options: record().options,
    extraction: null,
  });
  assert.equal(
    await readFile(path.join(documentsDirectory, "sample.json"), "utf8"),
    "sample edit",
  );
  assert.equal(
    await readFile(path.join(documentsDirectory, "empty.json"), "utf8"),
    "draft edit",
  );
});

test("automatic file naming preserves existing files and avoids case and Unicode collisions", async (t) => {
  const { store, documentsDirectory } = await fixture(t);
  await writeFile(path.join(documentsDirectory, "INPUT.JSON"), "protected");
  await writeFile(path.join(documentsDirectory, "input-2.json"), "protected-2");
  const saved = await store.create(record("collision", { name: "input.json" }));
  assert.equal(saved.name, "input-3.json");
  assert.equal(saved.managedPath, path.join(documentsDirectory, saved.name));
  assert.equal(
    await readFile(path.join(documentsDirectory, "INPUT.JSON"), "utf8"),
    "protected",
  );
  assert.equal(
    await readFile(path.join(documentsDirectory, "input-2.json"), "utf8"),
    "protected-2",
  );
  await writeFile(path.join(documentsDirectory, "cafe\u0301.json"), "accent");
  const accented = await store.create(record("accent", { name: "café.json" }));
  assert.equal(accented.name, "café-2.json");
  const copies = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      store.create(record(`parallel-${index}`, { name: "parallel.json" })),
    ),
  );
  assert.equal(new Set(copies.map((copy) => copy.managedPath)).size, 5);
});

test("same-directory imports reuse the original and rename updates both linked paths", async (t) => {
  const { store, documentsDirectory, directory } = await fixture(t);
  const original = path.join(documentsDirectory, "same.json");
  const raw = '{"same":true}';
  await writeFile(original, raw);
  const alias = path.join(directory, "storage-alias");
  await symlink(documentsDirectory, alias, "dir");
  await store.updateSettings({ writeDirectory: alias });
  const saved = await store.create(
    record("same", {
      name: "same.json",
      source: "imported",
      sourcePath: original,
      raw,
    }),
  );
  assert.equal(saved.managedPath, original);
  assert.deepEqual(await readdir(documentsDirectory), ["same.json"]);
  await store.update(saved.id, {
    raw: "updated",
    options: record().options,
    extraction: null,
  });
  assert.equal(await readFile(original, "utf8"), "updated");
  const renamed = await store.rename(saved.id, "renamed.json");
  assert.equal(
    renamed.sourcePath,
    path.join(documentsDirectory, "renamed.json"),
  );
  assert.equal(renamed.managedPath, renamed.sourcePath);
  await assert.rejects(access(original));
  assert.equal(await readFile(renamed.managedPath!, "utf8"), "updated");
});

test("external imports get managed copies and later edits never overwrite the source", async (t) => {
  const { store, directory, documentsDirectory } = await fixture(t);
  const sourcePath = path.join(directory, "external.json");
  await writeFile(sourcePath, '{"source":true}');
  const saved = await store.create(
    record("external", {
      name: "external.json",
      source: "imported",
      sourcePath,
      raw: '{"source":true}',
    }),
  );
  assert.equal(
    saved.managedPath,
    path.join(documentsDirectory, "external.json"),
  );
  await store.update(saved.id, {
    raw: "editing",
    options: record().options,
    extraction: null,
  });
  assert.equal(await readFile(saved.managedPath!, "utf8"), "editing");
  assert.equal(await readFile(sourcePath, "utf8"), '{"source":true}');
  await store.remove(saved.id);
  await assert.rejects(access(saved.managedPath!), { code: "ENOENT" });
  assert.equal(await readFile(sourcePath, "utf8"), '{"source":true}');
});

test("legacy nonempty histories materialize during load without changing their timestamps", async (t) => {
  const { store, documentsDirectory, restart } = await fixture(t);
  const state = await store.load();
  const legacy = record("legacy", { name: "legacy.json", raw: "legacy raw" });
  await writeFile(
    path.join(state.settings.historyDirectory, "history-legacy.json"),
    JSON.stringify(legacy),
  );
  const migrated = await restart().load();
  const summary = migrated.records.find((item) => item.id === legacy.id)!;
  assert.equal(
    summary.managedPath,
    path.join(documentsDirectory, "legacy.json"),
  );
  assert.equal(summary.createdAt, legacy.createdAt);
  assert.equal(summary.updatedAt, legacy.updatedAt);
  assert.equal(await readFile(summary.managedPath!, "utf8"), legacy.raw);
  await writeFile(summary.managedPath!, "external edit after save");
  await restart().load();
  await restart().read(legacy.id);
  assert.equal(
    await readFile(summary.managedPath!, "utf8"),
    "external edit after save",
  );
  assert.deepEqual(await readdir(documentsDirectory), ["legacy.json"]);
});

test("changing storage directories keeps successful files in place and sends new inputs to the new directory", async (t) => {
  const { store, directory, documentsDirectory } = await fixture(t);
  const first = await store.create(record("first"));
  const target = path.join(directory, "new-storage");
  await mkdir(target);
  await store.updateSettings({ writeDirectory: target });
  await store.update(first.id, {
    raw: "latest",
    options: record().options,
    extraction: null,
  });
  const second = await store.create(record("second"));
  assert.equal(
    (await store.read(first.id)).managedPath,
    path.join(documentsDirectory, "first.json"),
  );
  assert.equal(await readFile(first.managedPath!, "utf8"), "latest");
  assert.equal(second.managedPath, path.join(target, "second.json"));
  assert.deepEqual(await readdir(target), ["second.json"]);
});

test("ordinary file failures preserve history content and recover without duplicate record creation", async (t) => {
  let fail = true;
  const { store, restart, documentsDirectory } = await fixture(t, {
    link: async (from: string, to: string) => {
      if (fail && path.basename(to) === "recover.json")
        throw new Error("ordinary file blocked");
      await nativeLink(from, to);
    },
  });
  const raw = '{"unfinished":';
  const saved = await store.create(record("recover", { raw }));
  assert.match(saved.fileSaveError!, /ordinary file blocked/);
  assert.equal(saved.managedPath, undefined);
  assert.equal((await store.read(saved.id)).raw, raw);
  assert.match(
    (await restart().load()).records[0].fileSaveError!,
    /ordinary file blocked/,
  );
  assert.deepEqual(await readdir(documentsDirectory), []);
  fail = false;
  const recovered = await store.update(saved.id, {
    raw,
    options: record().options,
    extraction: null,
  });
  assert.equal(recovered.fileSaveError, undefined);
  assert.equal(await readFile(recovered.managedPath!, "utf8"), raw);
  assert.equal((await restart().load()).records.length, 1);
  assert.deepEqual(await readdir(documentsDirectory), ["recover.json"]);
});

test("failed ordinary updates keep the latest input in history and retry the same managed file", async (t) => {
  let fail = false;
  const { store, restart, documentsDirectory } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to) === "managed.json")
        throw new Error("file update blocked");
      await nativeRename(from, to);
    },
  });
  const original = await store.create(record("managed"));
  fail = true;
  const failed = await store.update(original.id, {
    raw: "latest raw",
    options: record().options,
    extraction: null,
  });
  assert.match(failed.fileSaveError!, /file update blocked/);
  assert.equal(failed.managedPath, original.managedPath);
  assert.equal((await restart().read(original.id)).raw, "latest raw");
  assert.equal(await readFile(original.managedPath!, "utf8"), record().raw);
  fail = false;
  const recovered = await store.update(original.id, {
    raw: "latest raw",
    options: record().options,
    extraction: null,
  });
  assert.equal(recovered.fileSaveError, undefined);
  assert.equal(recovered.managedPath, original.managedPath);
  assert.equal(await readFile(original.managedPath!, "utf8"), "latest raw");
  assert.deepEqual(await readdir(documentsDirectory), ["managed.json"]);
});

test("a failed file can be rebound to a new storage directory without deleting the previous copy", async (t) => {
  let fail = false;
  let oldPath = "";
  const { store, directory } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && to === oldPath) throw new Error("previous storage blocked");
      await nativeRename(from, to);
    },
  });
  const original = await store.create(record("move"));
  oldPath = original.managedPath!;
  fail = true;
  const failed = await store.update(original.id, {
    raw: "latest",
    options: record().options,
    extraction: null,
  });
  assert.match(failed.fileSaveError!, /blocked/);
  const target = path.join(directory, "recovery-storage");
  await mkdir(target);
  await writeFile(path.join(target, "move.json"), "protected");
  await store.updateSettings({ writeDirectory: target });
  const recovered = await store.update(original.id, {
    raw: "latest",
    options: record().options,
    extraction: null,
  });
  assert.equal(recovered.name, "move-2.json");
  assert.equal(recovered.managedPath, path.join(target, "move-2.json"));
  assert.equal(recovered.fileSaveError, undefined);
  assert.equal(await readFile(oldPath, "utf8"), record().raw);
  assert.equal(await readFile(recovered.managedPath!, "utf8"), "latest");
  assert.equal(
    await readFile(path.join(target, "move.json"), "utf8"),
    "protected",
  );
});

test("a new-file metadata failure cleans its unbound copy while preserving history raw", async (t) => {
  let fail = true;
  let ordinaryCreated = false;
  const { store, documentsDirectory, restart } = await fixture(t, {
    link: async (from: string, to: string) => {
      await nativeLink(from, to);
      if (path.basename(to) === "metadata.json") ordinaryCreated = true;
    },
    rename: async (from: string, to: string) => {
      if (
        fail &&
        ordinaryCreated &&
        path.basename(to) === "history-metadata.json"
      )
        throw new Error("metadata attachment blocked");
      await nativeRename(from, to);
    },
  });
  const saved = await store.create(record("metadata"));
  assert.match(saved.fileSaveError!, /metadata attachment blocked/);
  assert.equal(saved.managedPath, undefined);
  assert.deepEqual(await readdir(documentsDirectory), []);
  fail = false;
  const restored = await restart().read(saved.id);
  assert.equal(restored.raw, record().raw);
  assert.equal(
    restored.managedPath,
    path.join(documentsDirectory, "metadata.json"),
  );
  assert.equal(restored.fileSaveError, undefined);
});

test("renderer-provided managed paths cannot authorize overwriting unrelated files", async (t) => {
  const { store, directory, documentsDirectory } = await fixture(t);
  const protectedPath = path.join(directory, "protected.json");
  await writeFile(protectedPath, "protected user content");
  const saved = await store.create(
    record("forged", {
      managedPath: protectedPath,
      fileSaveError: "forged",
      raw: "incoming",
    }),
  );
  assert.equal(saved.managedPath, path.join(documentsDirectory, "forged.json"));
  assert.equal(saved.fileSaveError, undefined);
  assert.equal(await readFile(protectedPath, "utf8"), "protected user content");
});

test("ordinary files cannot collide with history envelopes when both directories are the same", async (t) => {
  const { store, restart } = await fixture(t);
  const settings = await store.getSettings();
  await store.updateSettings({ writeDirectory: settings.historyDirectory });
  const saved = await store.create(
    record("shared", { name: "history-user.json", raw: "ordinary input" }),
  );
  assert.equal(saved.name, "input-history-user.json");
  assert.equal(await readFile(saved.managedPath!, "utf8"), "ordinary input");
  assert.equal((await restart().read(saved.id)).raw, "ordinary input");
  await assert.rejects(
    store.rename(saved.id, "history-other.json"),
    /应用历史/,
  );
  assert.equal((await restart().load()).records.length, 1);
});

test("missing managed files are recreated on edits while symbolic-link replacements stay untouched", async (t) => {
  const { store, directory } = await fixture(t);
  const saved = await store.create(record("missing-managed"));
  await unlink(saved.managedPath!);
  const recovered = await store.update(saved.id, {
    raw: "recreated",
    options: record().options,
    extraction: null,
  });
  assert.equal(recovered.managedPath, saved.managedPath);
  assert.equal(await readFile(saved.managedPath!, "utf8"), "recreated");
  await unlink(saved.managedPath!);
  const protectedPath = path.join(directory, "protected.json");
  await writeFile(protectedPath, "protected");
  await symlink(protectedPath, saved.managedPath!);
  const failed = await store.update(saved.id, {
    raw: "must not replace",
    options: record().options,
    extraction: null,
  });
  assert.match(failed.fileSaveError!, /不是普通文件/);
  assert.equal(await readFile(protectedPath, "utf8"), "protected");
  assert.equal((await store.read(saved.id)).raw, "must not replace");
});

test("ordinary storage supports file systems without hard links while retaining exclusive creation", async (t) => {
  const { store, documentsDirectory } = await fixture(t, {
    link: async () => {
      throw Object.assign(new Error("hard links unsupported"), {
        code: "ENOTSUP",
      });
    },
  });
  await writeFile(path.join(documentsDirectory, "fallback.json"), "protected");
  const saved = await store.create(record("fallback"));
  assert.equal(saved.name, "fallback-2.json");
  assert.equal(saved.fileSaveError, undefined);
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  assert.equal(
    await readFile(path.join(documentsDirectory, "fallback.json"), "utf8"),
    "protected",
  );
});

test("a failure to persist file error metadata cannot clear the live error or lose input", async (t) => {
  let fail = false;
  let historyWrites = 0;
  const { store } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to) === "error-status.json")
        throw new Error("ordinary update blocked");
      if (
        fail &&
        path.basename(to) === "history-error-status.json" &&
        ++historyWrites > 1
      )
        throw new Error("error metadata blocked");
      await nativeRename(from, to);
    },
  });
  const saved = await store.create(record("error-status"));
  fail = true;
  const failed = await store.update(saved.id, {
    raw: "latest input",
    options: record().options,
    extraction: null,
  });
  assert.match(failed.fileSaveError!, /error metadata blocked/);
  assert.equal(
    (await store.load()).records[0].fileSaveError?.includes("blocked"),
    true,
  );
  assert.equal((await store.read(saved.id)).raw, "latest input");
  assert.equal(await readFile(saved.managedPath!, "utf8"), record().raw);
  fail = false;
  const recovered = await store.update(saved.id, {
    raw: "latest input",
    options: record().options,
    extraction: null,
  });
  assert.equal(recovered.fileSaveError, undefined);
  assert.equal(await readFile(saved.managedPath!, "utf8"), "latest input");
});

test("importing application settings creates a separate JSON file instead of binding the configuration", async (t) => {
  const { store, userDataDirectory } = await fixture(t);
  await store.create(record("sample", { source: "sample" }));
  await store.updateSettings({ writeDirectory: userDataDirectory });
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const raw = await readFile(configPath, "utf8");
  const saved = await store.create(
    record("config-copy", {
      name: "workspace-settings.json",
      source: "imported",
      sourcePath: configPath,
      raw,
    }),
  );
  assert.equal(
    saved.managedPath,
    path.join(userDataDirectory, "workspace-settings-2.json"),
  );
  await store.update(saved.id, {
    raw: "edited copy",
    options: record().options,
    extraction: null,
  });
  assert.equal(await readFile(configPath, "utf8"), raw);
  assert.equal(await readFile(saved.managedPath!, "utf8"), "edited copy");
  const current = await store.read(saved.id);
  await writeFile(
    path.join(
      (await store.getSettings()).historyDirectory,
      `history-${saved.id}.json`,
    ),
    JSON.stringify({ ...current, managedPath: configPath }),
  );
  await assert.rejects(store.rename(saved.id, "unsafe.json"), /应用数据冲突/);
  assert.equal(await readFile(configPath, "utf8"), raw);
});

test("a migration copy failure removes only new copies and retains original configuration", async (t) => {
  let fail = false;
  const { store, directory } = await fixture(t, {
    copyFile: async (from: string, to: string, flags?: number) => {
      if (fail && path.basename(from) === "history-b.json")
        throw new Error("copy blocked");
      await nativeCopyFile(from, to, flags);
    },
  });
  await store.create(record("a"));
  await store.create(record("b"));
  const previous = (await store.load()).settings.historyDirectory;
  const target = path.join(directory, "target");
  await mkdir(target);
  await writeFile(
    path.join(target, "unrelated.json"),
    "unrelated user content",
  );
  fail = true;
  await assert.rejects(
    store.updateSettings({ historyDirectory: target }),
    /原数据与配置已保留/,
  );
  assert.equal((await store.load()).settings.historyDirectory, previous);
  assert.equal((await store.read("a")).raw, record().raw);
  assert.equal((await store.read("b")).raw, record().raw);
  assert.deepEqual(await readdir(target), ["unrelated.json"]);
});

test("a migration settings commit failure removes its copies while retaining originals", async (t) => {
  let fail = false;
  const { store, directory } = await fixture(t, {
    rename: async (from: string, to: string) => {
      if (fail && path.basename(to) === "workspace-settings.json")
        throw new Error("settings blocked");
      await nativeRename(from, to);
    },
  });
  await store.create(record());
  await store.updateSettings({ theme: "dark", autoCopy: true });
  const previous = (await store.load()).settings.historyDirectory;
  const target = path.join(directory, "target");
  await mkdir(target);
  fail = true;
  await assert.rejects(
    store.updateSettings({
      historyDirectory: target,
      theme: "light",
      autoCopy: false,
    }),
    /原数据与配置已保留/,
  );
  assert.equal((await store.load()).settings.historyDirectory, previous);
  assert.equal((await store.getSettings()).theme, "dark");
  assert.equal((await store.getSettings()).autoCopy, true);
  assert.equal((await store.read("record-a")).raw, record().raw);
  assert.deepEqual(await readdir(target), []);
});

test("persists recursive unescaping globally without changing raw content or document options", async (t) => {
  const { store, restart } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ theme: "dark", language: "en" });
  const initial = await store.getSettings();
  for (const recursiveUnescape of [false, true]) {
    assert.deepEqual(await store.updateSettings({ recursiveUnescape }), {
      ...initial,
      recursiveUnescape,
    });
    const restored = restart();
    assert.deepEqual((await restored.load()).settings, {
      ...initial,
      recursiveUnescape,
    });
    assert.equal((await restored.load()).activeId, "record-a");
    const saved = await restored.read("record-a");
    assert.equal(saved.raw, record().raw);
    assert.deepEqual(saved.options, record().options);
    assert.equal(Object.hasOwn(saved.options, "recursiveUnescape"), false);
  }
});

test("legacy configuration enables recursive unescaping while preserving existing settings and records", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ theme: "dark", language: "en" });
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const legacy = JSON.parse(await readFile(configPath, "utf8"));
  delete legacy.settings.recursiveUnescape;
  const content = JSON.stringify(legacy);
  await writeFile(configPath, content);
  const restored = restart();
  assert.deepEqual((await restored.load()).settings, initial);
  assert.equal(await readFile(configPath, "utf8"), content);
  assert.equal((await restored.read("record-a")).raw, record().raw);
  await restored.updateSettings({ recursiveUnescape: false });
  assert.deepEqual((await restart().load()).settings, {
    ...initial,
    recursiveUnescape: false,
  });
});

test("invalid recursive-unescaping patches preserve configuration, history and migration destinations", async (t) => {
  const { store, restart, userDataDirectory, directory } = await fixture(t);
  await store.create(record());
  await store.updateSettings({ recursiveUnescape: false, theme: "dark" });
  const initial = await store.getSettings();
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const original = await readFile(configPath, "utf8");
  const target = path.join(directory, "recursive-migration");
  for (const invalid of ["true", "false", 1, 0, null, undefined, {}, []]) {
    await assert.rejects(
      store.updateSettings({
        recursiveUnescape: invalid as boolean,
        theme: "light",
        readDirectory: target,
        historyDirectory: target,
      }),
      /递归去转义/,
    );
    assert.deepEqual(await store.getSettings(), initial);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(access(target), { code: "ENOENT" });
    assert.equal((await restart().read("record-a")).raw, record().raw);
  }
});

test("invalid stored recursive-unescaping values do not replace configuration or history", async (t) => {
  const { store, restart, userDataDirectory } = await fixture(t);
  await store.create(record());
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const invalid = JSON.parse(await readFile(configPath, "utf8"));
  invalid.settings.recursiveUnescape = "true";
  const content = JSON.stringify(invalid);
  await writeFile(configPath, content);
  await assert.rejects(restart().load(), /递归去转义/);
  assert.equal(await readFile(configPath, "utf8"), content);
  assert.equal((await store.read("record-a")).raw, record().raw);
});
