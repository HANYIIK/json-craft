import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createBrowserWorkspace } from "../../../src/renderer/features/history/browser-workspace";
import type {
  HistoryRecord,
  LanguagePreference,
  ThemePreference,
} from "../../../src/shared/types";

const storageKey = "json-craft-workspace-v1";

function fixture(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return { storage, workspace: createBrowserWorkspace() };
}

function record(): HistoryRecord {
  return {
    id: "browser-record",
    name: "browser-record.json",
    raw: '{"id":9007199254740993}',
    source: "scratch",
    options: { indent: "2", autoUnescape: true, repair: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("browser history preserves edit times during view changes and sorts actual edits newest first", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-01T00:00:00Z"),
  });
  const { workspace } = fixture(t);
  const first = await workspace.create(record());
  t.mock.timers.tick(60_000);
  const second = await workspace.create({
    ...record(),
    id: "second",
    name: "second.json",
  });
  t.mock.timers.tick(60_000);
  const changes = {
    raw: record().raw,
    options: { indent: "4" as const, autoUnescape: false, repair: false },
    extraction: { key: "id", path: "$.id", occurrence: 1 },
  };
  assert.equal(
    (await workspace.update(first.id, changes)).updatedAt,
    first.updatedAt,
  );
  await workspace.setActive(first.id);
  assert.equal((await workspace.read(first.id)).updatedAt, first.updatedAt);
  assert.equal(
    (await workspace.rename(first.id, first.name)).updatedAt,
    first.updatedAt,
  );
  assert.deepEqual(
    (await workspace.load()).records.map((value) => value.id),
    [second.id, first.id],
  );
  t.mock.timers.tick(60_000);
  const edited = await workspace.update(first.id, {
    ...changes,
    raw: '{"edited":true}',
  });
  assert.equal(edited.updatedAt, new Date().toISOString());
  const restored = await createBrowserWorkspace().load();
  assert.deepEqual(
    restored.records.map((value) => value.id),
    [first.id, second.id],
  );
  assert.equal(restored.records[1].updatedAt, second.updatedAt);
});

test("browser workspaces default to following the system theme", async (t) => {
  const { workspace } = fixture(t);
  const state = await workspace.load();
  assert.equal(state.settings.theme, "system");
  assert.equal(state.settings.autoCopy, false);
  assert.equal(state.settings.recursiveUnescape, true);
  assert.equal(state.settings.language, "system");
  assert.equal(state.initialized, false);
  assert.deepEqual(state.records, []);
});

test("browser workspaces persist each theme preference without modifying history", async (t) => {
  const { workspace } = fixture(t);
  await workspace.create(record());
  await workspace.setActive("browser-record");
  const themes: ThemePreference[] = ["dark", "light", "system"];
  for (const theme of themes) {
    await workspace.updateSettings({ theme });
    const restored = createBrowserWorkspace();
    const state = await restored.load();
    assert.equal(state.settings.theme, theme);
    assert.equal(state.activeId, "browser-record");
    assert.equal(state.records.length, 1);
    assert.equal((await restored.read("browser-record")).raw, record().raw);
  }
});

test("legacy browser storage without a theme remains readable and adopts system as the default", async (t) => {
  const { storage, workspace } = fixture(t);
  const directories = {
    readDirectory: "/previous-read",
    writeDirectory: "/previous-write",
    historyDirectory: "/previous-history",
  };
  storage.setItem(
    storageKey,
    JSON.stringify({
      initialized: true,
      records: [record()],
      settings: directories,
      activeId: "browser-record",
    }),
  );
  const restored = await workspace.load();
  assert.deepEqual(restored.settings, {
    ...directories,
    theme: "system",
    autoCopy: false,
    recursiveUnescape: true,
    language: "system",
  });
  assert.equal((await workspace.read("browser-record")).raw, record().raw);
  await workspace.updateSettings({ theme: "dark" });
  assert.deepEqual((await createBrowserWorkspace().load()).settings, {
    ...directories,
    theme: "dark",
    autoCopy: false,
    recursiveUnescape: true,
    language: "system",
  });
});

test("browser automatic-copy preferences survive new workspace instances without changing document options", async (t) => {
  const { workspace } = fixture(t);
  await workspace.create(record());
  await workspace.setActive("browser-record");
  await workspace.updateSettings({ theme: "dark" });
  const initial = (await workspace.load()).settings;
  for (const autoCopy of [true, false]) {
    await workspace.updateSettings({ autoCopy });
    const restored = createBrowserWorkspace();
    assert.deepEqual((await restored.load()).settings, {
      ...initial,
      autoCopy,
    });
    assert.equal((await restored.load()).activeId, "browser-record");
    assert.equal((await restored.read("browser-record")).raw, record().raw);
    assert.deepEqual(
      (await restored.read("browser-record")).options,
      record().options,
    );
  }
});

test("browser storage predating automatic copying defaults to disabled and keeps its theme", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ theme: "dark", readDirectory: "/read" });
  const legacy = JSON.parse(storage.getItem(storageKey)!);
  delete legacy.settings.autoCopy;
  storage.setItem(storageKey, JSON.stringify(legacy));
  const initial = await createBrowserWorkspace().load();
  assert.equal(initial.settings.autoCopy, false);
  assert.equal(initial.settings.theme, "dark");
  assert.equal(initial.settings.readDirectory, "/read");
  await workspace.updateSettings({ autoCopy: true });
  assert.equal((await createBrowserWorkspace().load()).settings.autoCopy, true);
  assert.equal((await workspace.read("browser-record")).raw, record().raw);
});

test("invalid browser automatic-copy patches preserve the entire stored workspace", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ autoCopy: true, theme: "dark" });
  const original = storage.getItem(storageKey);
  for (const invalid of ["true", "false", 1, 0, null, undefined, {}, []]) {
    await assert.rejects(
      workspace.updateSettings({
        autoCopy: invalid as boolean,
        theme: "light",
        readDirectory: "/discarded",
      }),
      /自动复制/,
    );
    assert.equal(storage.getItem(storageKey), original);
    assert.equal((await workspace.load()).settings.autoCopy, true);
    assert.equal((await workspace.load()).settings.theme, "dark");
    assert.equal((await workspace.read("browser-record")).raw, record().raw);
  }
});

test("invalid browser theme updates leave all saved settings and records untouched", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ theme: "dark", readDirectory: "/read" });
  const previous = storage.getItem(storageKey);
  for (const invalid of ["auto", "", null, undefined, 42, {}]) {
    await assert.rejects(
      workspace.updateSettings({
        theme: invalid as ThemePreference,
        readDirectory: "/discarded-path",
      }),
      /主题/,
    );
    assert.equal(storage.getItem(storageKey), previous);
    assert.equal((await workspace.load()).settings.theme, "dark");
    assert.equal((await workspace.load()).settings.readDirectory, "/read");
    assert.equal((await workspace.read("browser-record")).raw, record().raw);
  }
});

test("browser language preferences persist without changing JSON, names, or paths", async (t) => {
  const { workspace } = fixture(t);
  await workspace.create(record());
  await workspace.setActive("browser-record");
  const initial = (await workspace.load()).settings;
  for (const language of ["en", "zh-CN", "system"] as LanguagePreference[]) {
    await workspace.updateSettings({ language });
    const restored = createBrowserWorkspace();
    assert.deepEqual((await restored.load()).settings, {
      ...initial,
      language,
    });
    assert.equal((await restored.read("browser-record")).raw, record().raw);
    assert.equal((await restored.read("browser-record")).name, record().name);
    assert.equal((await restored.load()).activeId, "browser-record");
  }
});

test("legacy browser storage follows the system language without rewriting content", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ theme: "dark" });
  const legacy = JSON.parse(storage.getItem(storageKey)!);
  delete legacy.settings.language;
  storage.setItem(storageKey, JSON.stringify(legacy));
  assert.equal(
    (await createBrowserWorkspace().load()).settings.language,
    "system",
  );
  await workspace.updateSettings({ language: "en" });
  assert.equal((await createBrowserWorkspace().load()).settings.language, "en");
  assert.equal((await workspace.read("browser-record")).raw, record().raw);
});

test("invalid browser language updates preserve the stored workspace", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ language: "en" });
  const original = storage.getItem(storageKey);
  for (const invalid of ["fr", "zh", "en-US", "", null, undefined, 1, {}, []]) {
    await assert.rejects(
      workspace.updateSettings({
        language: invalid as LanguagePreference,
        theme: "dark",
        readDirectory: "/discarded",
      }),
      /语言/,
    );
    assert.equal(storage.getItem(storageKey), original);
  }
  const invalidState = JSON.parse(original!);
  invalidState.settings.language = "fr";
  storage.setItem(storageKey, JSON.stringify(invalidState));
  await assert.rejects(createBrowserWorkspace().load(), /语言/);
  assert.equal(storage.getItem(storageKey), JSON.stringify(invalidState));
});

test("browser recursive-unescaping preferences persist without changing document options or history", async (t) => {
  const { workspace } = fixture(t);
  await workspace.create(record());
  await workspace.setActive("browser-record");
  const initial = (await workspace.load()).settings;
  for (const recursiveUnescape of [false, true]) {
    await workspace.updateSettings({ recursiveUnescape });
    const restored = createBrowserWorkspace();
    assert.deepEqual((await restored.load()).settings, {
      ...initial,
      recursiveUnescape,
    });
    assert.equal((await restored.load()).activeId, "browser-record");
    assert.deepEqual(
      await restored.read("browser-record"),
      await workspace.read("browser-record"),
    );
    assert.deepEqual(
      (await restored.read("browser-record")).options,
      record().options,
    );
    assert.equal(
      Object.hasOwn(
        (await restored.read("browser-record")).options,
        "recursiveUnescape",
      ),
      false,
    );
  }
});

test("legacy browser storage defaults recursive unescaping to enabled without rewriting content", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ theme: "dark", language: "en" });
  const legacy = JSON.parse(storage.getItem(storageKey)!);
  delete legacy.settings.recursiveUnescape;
  const content = JSON.stringify(legacy);
  storage.setItem(storageKey, content);
  const restored = createBrowserWorkspace();
  assert.equal((await restored.load()).settings.recursiveUnescape, true);
  assert.equal(storage.getItem(storageKey), content);
  assert.equal((await restored.read("browser-record")).raw, record().raw);
  await restored.updateSettings({ recursiveUnescape: false });
  const state = await createBrowserWorkspace().load();
  assert.equal(state.settings.recursiveUnescape, false);
  assert.equal(state.settings.language, "en");
  assert.equal(state.settings.theme, "dark");
});

test("invalid browser recursive-unescaping patches and stored values leave all saved data untouched", async (t) => {
  const { storage, workspace } = fixture(t);
  await workspace.create(record());
  await workspace.updateSettings({ recursiveUnescape: false, theme: "dark" });
  const original = storage.getItem(storageKey);
  for (const invalid of ["true", "false", 1, 0, null, undefined, {}, []]) {
    await assert.rejects(
      workspace.updateSettings({
        recursiveUnescape: invalid as boolean,
        theme: "light",
        readDirectory: "/discarded",
      }),
      /递归去转义/,
    );
    assert.equal(storage.getItem(storageKey), original);
    assert.equal((await workspace.load()).settings.recursiveUnescape, false);
    assert.equal((await workspace.read("browser-record")).raw, record().raw);
  }
  const invalidState = JSON.parse(original!);
  invalidState.settings.recursiveUnescape = "false";
  const content = JSON.stringify(invalidState);
  storage.setItem(storageKey, content);
  await assert.rejects(createBrowserWorkspace().load(), /递归去转义/);
  assert.equal(storage.getItem(storageKey), content);
});
