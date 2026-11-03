const nativeFs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_RECORD_BYTES = 20 * 1024 * 1024;
const RECORD_PATTERN = /^history-([A-Za-z0-9_-]{1,100})\.json$/;
const DIRECTORY_KEYS = ["readDirectory", "writeDirectory", "historyDirectory"];
const SETTINGS_KEYS = [
  ...DIRECTORY_KEYS,
  "theme",
  "autoCopy",
  "recursiveUnescape",
  "language",
];

function validLanguage(value) {
  if (!["system", "zh-CN", "en"].includes(value))
    throw new Error("语言设置无效，请选择跟随系统、简体中文或英语。");
  return value;
}

function validTheme(value) {
  if (!["system", "light", "dark"].includes(value))
    throw new Error("主题设置无效，请选择跟随系统、浅色或深色。");
  return value;
}

function validAutoCopy(value) {
  if (typeof value !== "boolean")
    throw new Error("自动复制设置无效，请使用开启或关闭状态。");
  return value;
}

function validRecursiveUnescape(value) {
  if (typeof value !== "boolean")
    throw new Error("递归去转义设置无效，请使用开启或关闭状态。");
  return value;
}

function validDirectory(value) {
  if (
    typeof value !== "string" ||
    !value ||
    !path.isAbsolute(value) ||
    value.includes("\0")
  )
    throw new Error("请输入有效的绝对目录路径。");
  return path.resolve(value);
}

function validId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new Error("历史记录标识无效。");
  return id;
}

function validName(value, appendExtension = false) {
  if (typeof value !== "string" || !value || value !== value.trim())
    throw new Error("请输入有效文件名，首尾不能包含空格。");
  const name =
    appendExtension && !/\.json$/i.test(value) ? value + ".json" : value;
  if (
    name.length > 180 ||
    Buffer.byteLength(name, "utf8") > 255 ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ||
    !/\.json$/i.test(name) ||
    name === ".json"
  )
    throw new Error("文件名无效，请使用不含路径或系统保留字符的 .json 名称。");
  return name;
}

function validOptions(value) {
  if (
    !value ||
    !["2", "4", "tab"].includes(value.indent) ||
    typeof value.autoUnescape !== "boolean" ||
    typeof value.repair !== "boolean"
  )
    throw new Error("历史记录的格式化选项无效。");
  return {
    indent: value.indent,
    autoUnescape: value.autoUnescape,
    repair: value.repair,
  };
}

function validExtraction(value) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    typeof value.key !== "string" ||
    !value.key.length ||
    value.key.length > 100_000 ||
    typeof value.path !== "string" ||
    !value.path.startsWith("$") ||
    value.path.length > 100_000 ||
    !Number.isSafeInteger(value.occurrence) ||
    value.occurrence < 1
  )
    throw new Error("历史记录的 key 提取信息无效。");
  return { key: value.key, path: value.path, occurrence: value.occurrence };
}

function validRaw(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > MAX_RECORD_BYTES ||
    Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES
  )
    throw new Error("历史记录内容无效，单条最多支持 20 MiB。");
  return raw;
}

function validRecord(value) {
  if (!value || typeof value !== "object")
    throw new Error("历史记录格式无效。");
  const sourcePath = value.sourcePath;
  const managedPath = value.managedPath;
  if (!["sample", "imported", "scratch"].includes(value.source))
    throw new Error("历史记录来源无效。");
  if (
    sourcePath !== undefined &&
    (typeof sourcePath !== "string" ||
      sourcePath.includes("\0") ||
      !path.isAbsolute(sourcePath) ||
      !/\.json$/i.test(sourcePath))
  )
    throw new Error("原始文件路径无效。");
  if (
    managedPath !== undefined &&
    (typeof managedPath !== "string" ||
      managedPath.includes("\0") ||
      !path.isAbsolute(managedPath) ||
      !/\.json$/i.test(managedPath))
  )
    throw new Error("自动保存文件路径无效。");
  if (
    value.fileSaveError !== undefined &&
    (typeof value.fileSaveError !== "string" ||
      value.fileSaveError.length > 10_000)
  )
    throw new Error("自动保存文件状态无效。");
  for (const key of ["createdAt", "updatedAt"])
    if (
      typeof value[key] !== "string" ||
      !Number.isFinite(Date.parse(value[key]))
    )
      throw new Error("历史记录时间无效。");
  return {
    id: validId(value.id),
    name: validName(value.name),
    raw: validRaw(value.raw),
    source: value.source,
    ...(sourcePath ? { sourcePath: path.resolve(sourcePath) } : {}),
    ...(managedPath ? { managedPath: path.resolve(managedPath) } : {}),
    ...(value.fileSaveError ? { fileSaveError: value.fileSaveError } : {}),
    options: validOptions(value.options),
    ...(value.extraction
      ? { extraction: validExtraction(value.extraction) }
      : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function summary(record) {
  const { raw, ...metadata } = record;
  return {
    ...metadata,
    options: { ...record.options },
    ...(record.extraction ? { extraction: { ...record.extraction } } : {}),
    characters: raw.length,
  };
}

function foldedName(name) {
  return name.normalize("NFC").toLowerCase();
}

function createWorkspaceStore({
  userDataDirectory,
  documentsDirectory,
  io = nativeFs,
  trashFile,
}) {
  if (
    !path.isAbsolute(userDataDirectory) ||
    !path.isAbsolute(documentsDirectory)
  )
    throw new Error("工作区目录必须为绝对路径。");
  const fs = { ...nativeFs, ...io };
  const configPath = path.join(userDataDirectory, "workspace-settings.json");
  const defaultHistoryDirectory = path.join(userDataDirectory, "history");
  let config;
  let loaded = false;
  let tail = Promise.resolve();
  const records = new Map();

  function serialize(action) {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }

  async function atomicTextWrite(filePath, content, exclusive = false) {
    const temporary = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (exclusive) {
        try {
          await fs.link(temporary, filePath);
        } catch (error) {
          if (!["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(error.code))
            throw error;
          await fs.copyFile(temporary, filePath, constants.COPYFILE_EXCL);
        }
      } else await fs.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }

  function atomicWrite(filePath, value, exclusive = false) {
    return atomicTextWrite(filePath, JSON.stringify(value) + "\n", exclusive);
  }

  function validateConfig(value) {
    if (
      !value ||
      value.version !== 1 ||
      typeof value.initialized !== "boolean" ||
      !value.settings ||
      (value.activeId !== null &&
        (typeof value.activeId !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(value.activeId)))
    )
      throw new Error("工作区配置已损坏或版本不受支持，原文件已保留。");
    const settings = {
      theme: Object.hasOwn(value.settings, "theme")
        ? validTheme(value.settings.theme)
        : "system",
      autoCopy: Object.hasOwn(value.settings, "autoCopy")
        ? validAutoCopy(value.settings.autoCopy)
        : false,
      recursiveUnescape: Object.hasOwn(value.settings, "recursiveUnescape")
        ? validRecursiveUnescape(value.settings.recursiveUnescape)
        : true,
      language: Object.hasOwn(value.settings, "language")
        ? validLanguage(value.settings.language)
        : "system",
    };
    for (const key of DIRECTORY_KEYS) {
      if (
        typeof value.settings[key] !== "string" ||
        !path.isAbsolute(value.settings[key]) ||
        value.settings[key].includes("\0")
      )
        throw new Error("工作区目录配置无效，原文件已保留。");
      settings[key] = path.resolve(value.settings[key]);
    }
    return {
      version: 1,
      initialized: value.initialized,
      activeId: value.activeId,
      settings,
    };
  }

  async function ensureConfig() {
    if (config) return;
    await fs.mkdir(userDataDirectory, { recursive: true });
    let next;
    let exists = true;
    try {
      next = validateConfig(JSON.parse(await fs.readFile(configPath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(`无法读取工作区配置，原文件已保留：${error.message}`);
      exists = false;
      next = {
        version: 1,
        initialized: false,
        activeId: null,
        settings: {
          readDirectory: documentsDirectory,
          writeDirectory: documentsDirectory,
          historyDirectory: defaultHistoryDirectory,
          theme: "system",
          autoCopy: false,
          recursiveUnescape: true,
          language: "system",
        },
      };
    }
    for (const key of DIRECTORY_KEYS) {
      try {
        next.settings[key] = await directory(
          next.settings[key],
          key !== "readDirectory",
        );
      } catch (error) {
        if (key === "historyDirectory") throw error;
      }
    }
    if (!exists) await atomicWrite(configPath, next, true);
    config = next;
  }

  async function writeConfig(next) {
    await atomicWrite(configPath, next);
    config = next;
  }

  function recordPath(id, directory = config.settings.historyDirectory) {
    return path.join(directory, `history-${validId(id)}.json`);
  }

  async function readRecord(id, directory = config.settings.historyDirectory) {
    const filePath = recordPath(id, directory);
    try {
      const information = await fs.lstat(filePath);
      if (
        !information.isFile() ||
        information.size > MAX_RECORD_BYTES * 6 + 1024 * 1024
      )
        throw new Error("记录文件类型或大小无效。");
      const record = validRecord(
        JSON.parse(await fs.readFile(filePath, "utf8")),
      );
      if (record.id !== id) throw new Error("记录标识与文件名不一致。");
      return record;
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("历史记录已删除或不存在。");
      throw new Error(`无法读取历史记录 ${id}，原文件已保留：${error.message}`);
    }
  }

  async function readCurrentRecord(id) {
    const record = await readRecord(id);
    const fileSaveError = records.get(id)?.fileSaveError;
    return !record.fileSaveError && fileSaveError
      ? { ...record, fileSaveError }
      : record;
  }

  async function scan(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const found = new Map();
    for (const entry of entries) {
      const match = RECORD_PATTERN.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile()) throw new Error(`历史记录文件无效：${entry.name}。`);
      const record = await readRecord(match[1], directory);
      found.set(record.id, summary(record));
    }
    return found;
  }

  async function initialize() {
    await ensureConfig();
    let found;
    try {
      if (loaded) {
        try {
          if (!(await fs.stat(config.settings.historyDirectory)).isDirectory())
            throw new Error("历史存储路径不是目录。");
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await directory(config.settings.historyDirectory, true);
      found = await scan(config.settings.historyDirectory);
    } catch (error) {
      throw new Error(
        `无法读取历史存储目录，已有内容不会被覆盖：${error.message}`,
      );
    }
    records.clear();
    for (const [id, record] of found) records.set(id, record);
    loaded = true;
  }

  function sortedRecords() {
    return [...records.values()]
      .map((item) => ({
        ...item,
        options: { ...item.options },
        ...(item.extraction ? { extraction: { ...item.extraction } } : {}),
      }))
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
  }

  async function directory(value, writable) {
    const target = validDirectory(value);
    let resolved;
    try {
      let information;
      try {
        information = await fs.stat(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.mkdir(target, { recursive: true });
        information = await fs.stat(target);
      }
      if (!information.isDirectory()) throw new Error("所选路径不是目录。");
      resolved = await fs.realpath(target);
    } catch (error) {
      if (["EEXIST", "ENOTDIR"].includes(error.code))
        throw new Error("所选路径或其上级路径已被文件占用，无法创建目录。");
      if (["EACCES", "EPERM"].includes(error.code))
        throw new Error("没有访问或创建该目录的权限。");
      throw new Error(`无法准备目录 ${target}：${error.message}`);
    }
    await fs
      .access(
        resolved,
        writable ? constants.R_OK | constants.W_OK : constants.R_OK,
      )
      .catch(() => {
        throw new Error(
          writable ? "没有该目录的读写权限。" : "没有该目录的读取权限。",
        );
      });
    return resolved;
  }

  async function createTarget(source, target) {
    try {
      await fs.link(source, target);
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error("同名文件已存在，未执行重命名。");
      if (!["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"].includes(error.code))
        throw error;
      try {
        await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError.code === "EEXIST")
          throw new Error("同名文件已存在，未执行重命名。");
        throw copyError;
      }
    }
  }

  function availableName(name, attempt) {
    const suffix = `${attempt === 1 ? "" : `-${attempt}`}${name.slice(-5)}`;
    const stem = Array.from(name.slice(0, -5));
    while (
      (stem.join("") + suffix).length > 180 ||
      Buffer.byteLength(stem.join("") + suffix, "utf8") > 255
    )
      stem.pop();
    return stem.join("") + suffix;
  }

  function needsManagedFile(record, rawChanged = false) {
    return (
      Boolean(record.fileSaveError) ||
      (!record.managedPath &&
        (record.source !== "sample" || rawChanged) &&
        Boolean(record.raw || record.characters || record.sourcePath))
    );
  }

  async function isApplicationDataFile(filePath) {
    const [candidate, currentConfig] = await Promise.all([
      fs.realpath(filePath).catch(() => filePath),
      fs.realpath(configPath).catch(() => configPath),
    ]);
    return (
      candidate === currentConfig ||
      (path.dirname(candidate) === config.settings.historyDirectory &&
        RECORD_PATTERN.test(path.basename(candidate)))
    );
  }

  async function createManagedFile(record, storageDirectory) {
    if (record.sourcePath) {
      const source = await fs.realpath(record.sourcePath).catch(() => null);
      if (
        source &&
        path.dirname(source) === storageDirectory &&
        !(await isApplicationDataFile(source))
      ) {
        const information = await fs.lstat(source);
        if (
          information.isFile() &&
          !information.isSymbolicLink() &&
          (await fs.readFile(source, "utf8")) === record.raw
        )
          return {
            record: {
              ...record,
              name: path.basename(source),
              sourcePath: source,
              managedPath: source,
            },
          };
      }
    }
    const baseName =
      storageDirectory === config.settings.historyDirectory &&
      RECORD_PATTERN.test(record.name)
        ? availableName(`input-${record.name}`, 1)
        : record.name;
    for (let attempt = 1; ; attempt++) {
      const name = availableName(baseName, attempt);
      const entries = await fs.readdir(storageDirectory);
      if (entries.some((entry) => foldedName(entry) === foldedName(name)))
        continue;
      const target = path.join(storageDirectory, name);
      try {
        await atomicTextWrite(target, record.raw, true);
        return {
          record: { ...record, name, managedPath: target },
          createdPath: target,
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  }

  async function syncManagedFile(record, writeRaw = false, rawChanged = false) {
    if (!writeRaw && !needsManagedFile(record, rawChanged)) return record;
    if (!record.managedPath && !needsManagedFile(record, rawChanged))
      return record;
    let next;
    let createdPath;
    try {
      const rebind =
        record.managedPath &&
        record.fileSaveError &&
        path.dirname(record.managedPath) !== config.settings.writeDirectory;
      if (!record.managedPath || rebind) {
        const storageDirectory = await directory(
          config.settings.writeDirectory,
          true,
        );
        const result = await createManagedFile(record, storageDirectory);
        next = result.record;
        createdPath = result.createdPath;
      } else {
        if (await isApplicationDataFile(record.managedPath))
          throw new Error("自动保存目标与应用历史文件冲突，未覆盖任何内容。");
        const information = await fs
          .lstat(record.managedPath)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        if (
          information &&
          (!information.isFile() || information.isSymbolicLink())
        )
          throw new Error("自动保存目标不是普通文件，未覆盖任何内容。");
        await atomicTextWrite(record.managedPath, record.raw, !information);
        next = { ...record };
      }
      delete next.fileSaveError;
    } catch (error) {
      next = {
        ...record,
        fileSaveError:
          `原文已保存到应用历史，但 JSON 文件自动保存失败：${error.message}`.slice(
            0,
            8000,
          ),
      };
    }
    if (
      next.name !== record.name ||
      next.managedPath !== record.managedPath ||
      next.fileSaveError !== record.fileSaveError
    ) {
      try {
        await atomicWrite(recordPath(record.id), next);
      } catch (error) {
        let cleanupError;
        if (createdPath)
          await fs.unlink(createdPath).catch((failure) => {
            cleanupError = failure;
          });
        next = {
          ...record,
          fileSaveError:
            `原文已保存到应用历史，但自动保存文件的位置或状态未能保存：${error.message}${cleanupError ? `；副本已保留在 ${createdPath}` : ""}`.slice(
              0,
              8000,
            ),
        };
      }
    }
    return next;
  }

  async function refreshManagedFiles() {
    for (const metadata of records.values()) {
      if (!needsManagedFile(metadata)) continue;
      const record = await readCurrentRecord(metadata.id);
      const saved = await syncManagedFile(record);
      records.set(record.id, summary(saved));
    }
  }

  return {
    load: () =>
      serialize(async () => {
        await initialize();
        await refreshManagedFiles();
        return {
          initialized: config.initialized,
          records: sortedRecords(),
          settings: { ...config.settings },
          activeId: records.has(config.activeId) ? config.activeId : null,
        };
      }),
    getSettings: () =>
      serialize(async () => {
        await ensureConfig();
        return { ...config.settings };
      }),
    read: (id) =>
      serialize(async () => {
        await initialize();
        const record = await readCurrentRecord(validId(id));
        const saved = await syncManagedFile(record);
        records.set(saved.id, summary(saved));
        return saved;
      }),
    create: (value) =>
      serialize(async () => {
        await initialize();
        const incoming = validRecord({
          ...value,
          managedPath: undefined,
          fileSaveError: undefined,
        });
        if (records.has(incoming.id))
          throw new Error("历史记录已存在，未覆盖原内容。");
        const timestamp = new Date().toISOString();
        const record = {
          ...incoming,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        try {
          await atomicWrite(recordPath(record.id), record, true);
        } catch (error) {
          if (error.code === "EEXIST")
            throw new Error("历史记录已存在，未覆盖原内容。");
          throw error;
        }
        try {
          if (!config.initialized || !config.activeId)
            await writeConfig({
              ...config,
              initialized: true,
              activeId: config.activeId ?? record.id,
            });
        } catch (error) {
          await fs.unlink(recordPath(record.id)).catch(() => {});
          throw error;
        }
        const saved = summary(await syncManagedFile(record));
        records.set(record.id, saved);
        return saved;
      }),
    update: (id, changes) =>
      serialize(async () => {
        await initialize();
        validId(id);
        if (!records.has(id))
          throw new Error("历史记录已删除或不存在，未重新创建。");
        if (
          !changes ||
          typeof changes !== "object" ||
          Object.keys(changes).some(
            (key) => !["raw", "options", "extraction"].includes(key),
          )
        )
          throw new Error("历史更新参数无效，文件名需要通过重命名修改。");
        const record = await readCurrentRecord(id);
        const extraction = validExtraction(changes.extraction);
        const next = {
          ...record,
          raw: validRaw(changes.raw),
          options: validOptions(changes.options),
          updatedAt: new Date().toISOString(),
        };
        if (extraction) next.extraction = extraction;
        else delete next.extraction;
        await atomicWrite(recordPath(id), next);
        const saved = summary(
          await syncManagedFile(
            next,
            next.raw !== record.raw || Boolean(next.fileSaveError),
            next.raw !== record.raw,
          ),
        );
        records.set(id, saved);
        return saved;
      }),
    remove: (id) =>
      serialize(async () => {
        await initialize();
        validId(id);
        if (!records.has(id)) return;
        const record = await readRecord(id);
        async function managedFile() {
          if (!record.managedPath) return null;
          if (await isApplicationDataFile(record.managedPath))
            throw new Error("自动保存文件与应用数据冲突，未执行删除。");
          const information = await fs
            .lstat(record.managedPath)
            .catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (
            information &&
            (!information.isFile() || information.isSymbolicLink())
          )
            throw new Error("自动保存文件不是普通文件，未执行删除。");
          if (information && typeof trashFile !== "function")
            throw new Error("未配置系统回收站，无法安全删除 JSON 文件。");
          return information;
        }
        await managedFile();
        const previous = config;
        const nextActive =
          config.activeId === id
            ? (sortedRecords().find((record) => record.id !== id)?.id ?? null)
            : config.activeId;
        let historyRemoved = false;
        try {
          if (nextActive !== config.activeId || !config.initialized)
            await writeConfig({
              ...config,
              initialized: true,
              activeId: nextActive,
            });
          await fs.unlink(recordPath(id));
          historyRemoved = true;
          if (await managedFile()) {
            try {
              await trashFile(record.managedPath);
            } catch (error) {
              if (error.code !== "ENOENT" || (await managedFile())) throw error;
            }
          }
        } catch (error) {
          const failures = [];
          if (historyRemoved)
            await atomicWrite(recordPath(id), record, true).catch((failure) => {
              failures.push(failure.message);
            });
          if (config !== previous)
            await writeConfig(previous).catch((failure) => {
              config = previous;
              failures.push(failure.message);
            });
          if (failures.length)
            throw new Error(
              `删除失败，历史或活动项恢复失败：${failures.join("；")}；${error.message}`,
            );
          throw new Error(`删除失败，历史记录与活动项已保留：${error.message}`);
        }
        records.delete(id);
      }),
    rename: (id, value) =>
      serialize(async () => {
        await initialize();
        validId(id);
        if (!records.has(id)) throw new Error("历史记录已删除或不存在。");
        const name = validName(value, true);
        const record = await readCurrentRecord(id);
        if (name === record.name) return summary(record);
        if (
          [...records.values()].some(
            (item) =>
              item.id !== id && foldedName(item.name) === foldedName(name),
          )
        )
          throw new Error("转换历史中已有同名文件，未执行重命名。");
        const next = { ...record, name, updatedAt: new Date().toISOString() };
        let target;
        if (record.managedPath) {
          if (await isApplicationDataFile(record.managedPath))
            throw new Error("自动保存文件与应用数据冲突，未执行重命名。");
          const source = await fs.lstat(record.managedPath).catch(() => {
            throw new Error("自动保存文件不存在或不可访问，未执行重命名。");
          });
          if (!source.isFile() || source.isSymbolicLink())
            throw new Error("自动保存文件不是普通文件，未执行重命名。");
          const storageDirectory = path.dirname(record.managedPath);
          if (
            storageDirectory === config.settings.historyDirectory &&
            RECORD_PATTERN.test(name)
          )
            throw new Error("此名称与应用历史文件冲突，未执行重命名。");
          if (
            (await fs.readdir(storageDirectory)).some(
              (existing) => foldedName(existing) === foldedName(name),
            )
          )
            throw new Error("同名文件已存在，未执行重命名。");
          target = path.join(storageDirectory, name);
          await createTarget(record.managedPath, target);
          next.managedPath = target;
          if (record.sourcePath === record.managedPath)
            next.sourcePath = target;
        }
        try {
          await atomicWrite(recordPath(id), next);
        } catch (error) {
          if (target) await fs.unlink(target).catch(() => {});
          throw error;
        }
        if (target) {
          try {
            await fs.unlink(record.managedPath);
          } catch (error) {
            try {
              await atomicWrite(recordPath(id), record);
            } catch (rollbackError) {
              records.set(id, summary(next));
              throw new Error(
                `重命名回滚失败，两个文件均已保留：${rollbackError.message}`,
              );
            }
            await fs.unlink(target).catch(() => {});
            throw new Error(`无法移除旧文件，已保留原名称：${error.message}`);
          }
        }
        const saved = summary(await syncManagedFile(next));
        records.set(id, saved);
        return saved;
      }),
    updateSettings: (patch) =>
      serialize(async () => {
        if (
          !patch ||
          typeof patch !== "object" ||
          Array.isArray(patch) ||
          Object.keys(patch).some((key) => !SETTINGS_KEYS.includes(key))
        )
          throw new Error("工作区设置参数无效。");
        if (Object.hasOwn(patch, "theme")) validTheme(patch.theme);
        if (Object.hasOwn(patch, "autoCopy")) validAutoCopy(patch.autoCopy);
        if (Object.hasOwn(patch, "recursiveUnescape"))
          validRecursiveUnescape(patch.recursiveUnescape);
        if (Object.hasOwn(patch, "language")) validLanguage(patch.language);
        for (const key of DIRECTORY_KEYS)
          if (Object.hasOwn(patch, key)) validDirectory(patch[key]);
        await ensureConfig();
        const settings = { ...config.settings };
        if (Object.hasOwn(patch, "theme")) settings.theme = patch.theme;
        if (Object.hasOwn(patch, "autoCopy"))
          settings.autoCopy = patch.autoCopy;
        if (Object.hasOwn(patch, "recursiveUnescape"))
          settings.recursiveUnescape = patch.recursiveUnescape;
        if (Object.hasOwn(patch, "language"))
          settings.language = patch.language;
        if (Object.hasOwn(patch, "historyDirectory")) await initialize();
        for (const key of DIRECTORY_KEYS)
          if (Object.hasOwn(patch, key))
            settings[key] = await directory(
              patch[key],
              key !== "readDirectory",
            );
        const sameHistoryDirectory =
          !Object.hasOwn(patch, "historyDirectory") ||
          settings.historyDirectory === config.settings.historyDirectory;
        if (sameHistoryDirectory) {
          await writeConfig({ ...config, settings });
          return { ...settings };
        }
        const sourceDirectory = config.settings.historyDirectory;
        const targetRecords = await scan(settings.historyDirectory);
        for (const id of records.keys())
          if (targetRecords.has(id))
            throw new Error(
              "目标目录已有同标识历史记录，未迁移或覆盖任何文件。",
            );
        const created = [];
        try {
          for (const id of records.keys()) {
            await readRecord(id);
            const destination = recordPath(id, settings.historyDirectory);
            await fs.copyFile(
              recordPath(id),
              destination,
              constants.COPYFILE_EXCL,
            );
            created.push(destination);
          }
          await writeConfig({ ...config, settings });
        } catch (error) {
          for (const destination of created)
            await fs.unlink(destination).catch(() => {});
          throw new Error(
            `历史目录切换失败，原数据与配置已保留：${error.message}`,
          );
        }
        for (const id of records.keys())
          await fs.unlink(recordPath(id, sourceDirectory)).catch(() => {});
        for (const [id, metadata] of records) targetRecords.set(id, metadata);
        records.clear();
        for (const [id, metadata] of targetRecords) records.set(id, metadata);
        return { ...settings };
      }),
    setActive: (id) =>
      serialize(async () => {
        await initialize();
        if (id !== null) {
          validId(id);
          if (!records.has(id)) throw new Error("历史记录已删除或不存在。");
        }
        if (config.activeId !== id)
          await writeConfig({ ...config, activeId: id });
      }),
    flush: () => tail,
  };
}

module.exports = { createWorkspaceStore };
