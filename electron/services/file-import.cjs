const nativeFs = require("node:fs/promises");
const path = require("node:path");

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const directoryQueues = new Map();

function foldedName(value) {
  return value.normalize("NFC").toLowerCase();
}

function serializeDirectory(directory, action) {
  const previous = directoryQueues.get(directory) ?? Promise.resolve();
  const result = previous.then(action);
  const tail = result.catch(() => {});
  directoryQueues.set(directory, tail);
  void tail.then(() => {
    if (directoryQueues.get(directory) === tail)
      directoryQueues.delete(directory);
  });
  return result;
}

function candidateName(name, attempt) {
  if (attempt === 1) return name;
  const extension = name.slice(-5);
  const suffix = `-${attempt}${extension}`;
  const stem = Array.from(name.slice(0, -5));
  while (Buffer.byteLength(stem.join("") + suffix, "utf8") > 255) stem.pop();
  return stem.join("") + suffix;
}

function createFileImporter({ io = nativeFs } = {}) {
  const fs = { ...nativeFs, ...io };

  async function storeCopy(directory, name, buffer) {
    return serializeDirectory(directory, async () => {
      for (let attempt = 1; ; attempt++) {
        const candidate = candidateName(name, attempt);
        const names = await fs.readdir(directory);
        if (
          names.some(
            (existing) => foldedName(existing) === foldedName(candidate),
          )
        )
          continue;
        const target = path.join(directory, candidate);
        let handle;
        let created = false;
        try {
          handle = await fs.open(target, "wx", 0o600);
          created = true;
          await handle.writeFile(buffer);
          await handle.sync();
          await handle.close();
          handle = undefined;
          return { name: candidate, filePath: target };
        } catch (error) {
          await handle?.close().catch(() => {});
          if (created) {
            await fs.unlink(target).catch((cleanupError) => {
              throw new Error(
                `${error.message}；未能清理不完整副本 ${target}：${cleanupError.message}`,
              );
            });
          }
          if (!created && error.code === "EEXIST") continue;
          throw error;
        }
      }
    });
  }

  async function importFile(filePath, storageDirectory) {
    let sourceFilePath = path.resolve(filePath);
    let name = path.basename(sourceFilePath);
    let buffer;
    let content;
    try {
      if (!/\.json$/i.test(name)) throw new Error("请选择 .json 文件。");
      sourceFilePath = await fs.realpath(sourceFilePath);
      name = path.basename(sourceFilePath);
      if (!/\.json$/i.test(name)) throw new Error("请选择 .json 文件。");
      const information = await fs.stat(sourceFilePath);
      if (!information.isFile()) throw new Error("所选项目不是文件。");
      if (information.size > MAX_FILE_BYTES)
        throw new Error("文件超过 20 MiB，请拆分后导入。");
      buffer = await fs.readFile(sourceFilePath);
      if (buffer.byteLength > MAX_FILE_BYTES)
        throw new Error("文件超过 20 MiB，请拆分后导入。");
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer);
      } catch {
        throw new Error("文件不是有效的 UTF-8 编码。");
      }
    } catch (error) {
      return {
        name,
        content: "",
        sourceFilePath,
        error: error.message || "无法读取文件。",
      };
    }

    try {
      const directory = await fs.realpath(storageDirectory);
      if (!(await fs.stat(directory)).isDirectory())
        throw new Error("文件存储路径不是目录。");
      if (path.dirname(sourceFilePath) === directory)
        return { name, content, filePath: sourceFilePath, sourceFilePath };
      const saved = await storeCopy(directory, name, buffer);
      return { ...saved, content, sourceFilePath };
    } catch (error) {
      return {
        name,
        content,
        sourceFilePath,
        storageError: `无法存储 JSON 文件：${error.message || "写入失败。"}`,
      };
    }
  }

  return {
    async importFiles(paths, storageDirectory) {
      if (
        !Array.isArray(paths) ||
        Array.from(paths).some(
          (value) =>
            typeof value !== "string" ||
            !path.isAbsolute(value) ||
            value.includes("\0"),
        )
      )
        throw new Error("拖入文件参数无效，请提供绝对文件路径数组。");
      if (
        typeof storageDirectory !== "string" ||
        !path.isAbsolute(storageDirectory) ||
        storageDirectory.includes("\0")
      )
        throw new Error("文件存储目录无效。");
      const files = [];
      for (const filePath of [...paths])
        files.push(await importFile(filePath, storageDirectory));
      return files;
    },
  };
}

module.exports = { createFileImporter };
