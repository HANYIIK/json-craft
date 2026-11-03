import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  mkdtemp,
  open as nativeOpen,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ImportedFile } from "../../../src/shared/types";

interface FileImporter {
  importFiles(paths: string[], directory: string): Promise<ImportedFile[]>;
}

const require = createRequire(import.meta.url);
const { createFileImporter } =
  require("../../../electron/services/file-import.cjs") as {
    createFileImporter(options?: {
      io?: Record<string, unknown>;
    }): FileImporter;
  };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "json-craft-import-"));
  const sourceDirectory = path.join(directory, "source");
  const storageDirectory = path.join(directory, "storage");
  await mkdir(sourceDirectory);
  await mkdir(storageDirectory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sourceDirectory, storageDirectory };
}

test("external imports copy original UTF-8 bytes and associate only the stored file", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "payload.json");
  const text = '\ufeff  {"id":9007199254740993,"值":"原文"}\r\n';
  const bytes = Buffer.from(text, "utf8");
  await writeFile(source, bytes);
  const [result] = await createFileImporter().importFiles(
    [source],
    storageDirectory,
  );
  assert.equal(result.name, "payload.json");
  assert.equal(result.content, text);
  assert.equal(result.error, undefined);
  assert.equal(result.storageError, undefined);
  assert.equal(result.sourceFilePath, await realpath(source));
  assert.equal(
    result.filePath,
    path.join(await realpath(storageDirectory), result.name),
  );
  assert.deepEqual(await readFile(result.filePath!), bytes);
  assert.deepEqual(await readFile(source), bytes);
});

test("files already in the canonical storage directory are reused without writes", async (t) => {
  const { storageDirectory } = await fixture(t);
  const source = path.join(storageDirectory, "existing.json");
  await writeFile(source, '{"reused":true}');
  let writes = 0;
  const importer = createFileImporter({
    io: {
      open: async () => {
        writes++;
        throw new Error("unexpected write");
      },
    },
  });
  const [result] = await importer.importFiles([source], storageDirectory);
  assert.equal(writes, 0);
  assert.equal(result.filePath, await realpath(source));
  assert.equal(result.sourceFilePath, result.filePath);
  assert.equal(result.storageError, undefined);
  assert.deepEqual(await readdir(storageDirectory), ["existing.json"]);
});

test("directory symlink aliases reuse the canonical source instead of creating copies", async (t) => {
  const { directory, storageDirectory } = await fixture(t);
  const source = path.join(storageDirectory, "existing.json");
  const alias = path.join(directory, "alias");
  await writeFile(source, "[1,2,3]");
  await symlink(
    storageDirectory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const importer = createFileImporter({
    io: {
      open: async () =>
        assert.fail("canonical same-directory import must not write"),
    },
  });
  const [throughSourceAlias] = await importer.importFiles(
    [path.join(alias, "existing.json")],
    storageDirectory,
  );
  const [throughStorageAlias] = await importer.importFiles([source], alias);
  assert.equal(throughSourceAlias.filePath, await realpath(source));
  assert.equal(throughStorageAlias.filePath, await realpath(source));
  assert.equal(throughSourceAlias.sourceFilePath, await realpath(source));
  assert.deepEqual(await readdir(storageDirectory), ["existing.json"]);
});

test("case and Unicode normalization collisions receive suffixes without replacing existing files", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const caseSource = path.join(sourceDirectory, "Payload.JSON");
  const unicodeSource = path.join(sourceDirectory, "cafe\u0301.json");
  const protectedCase = path.join(storageDirectory, "PAYLOAD.json");
  const protectedUnicode = path.join(storageDirectory, "café.json");
  await writeFile(caseSource, "case source");
  await writeFile(unicodeSource, "unicode source");
  await writeFile(protectedCase, "case protected");
  await writeFile(protectedUnicode, "unicode protected");
  const results = await createFileImporter().importFiles(
    [caseSource, unicodeSource],
    storageDirectory,
  );
  assert.equal(results[0].name, "Payload-2.JSON");
  const canonicalName = path.basename(await realpath(unicodeSource));
  assert.equal(results[1].name, canonicalName.slice(0, -5) + "-2.json");
  assert.equal(await readFile(protectedCase, "utf8"), "case protected");
  assert.equal(await readFile(protectedUnicode, "utf8"), "unicode protected");
  assert.equal(await readFile(results[0].filePath!, "utf8"), "case source");
  assert.equal(await readFile(results[1].filePath!, "utf8"), "unicode source");
});

test("duplicate basenames in one batch preserve input order and allocate distinct copies", async (t) => {
  const { directory, sourceDirectory, storageDirectory } = await fixture(t);
  const otherDirectory = path.join(directory, "other-source");
  await mkdir(otherDirectory);
  const first = path.join(sourceDirectory, "payload.json");
  const second = path.join(otherDirectory, "payload.json");
  await writeFile(first, "first");
  await writeFile(second, "second");
  const results = await createFileImporter().importFiles(
    [first, second, first],
    storageDirectory,
  );
  assert.deepEqual(
    results.map((item) => item.name),
    ["payload.json", "payload-2.json", "payload-3.json"],
  );
  assert.deepEqual(
    results.map((item) => item.content),
    ["first", "second", "first"],
  );
  assert.deepEqual(
    await Promise.all(results.map((item) => readFile(item.filePath!, "utf8"))),
    ["first", "second", "first"],
  );
});

test("concurrent importer instances avoid collisions in the same storage directory", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "payload.json");
  await writeFile(source, '{"parallel":true}');
  const importers = [createFileImporter(), createFileImporter()];
  const batches = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      importers[index % 2].importFiles([source], storageDirectory),
    ),
  );
  const results = batches.flat();
  assert.equal(new Set(results.map((item) => item.filePath)).size, 8);
  assert.equal(
    results.every((item) => !item.error && !item.storageError),
    true,
  );
  assert.equal((await readdir(storageDirectory)).length, 8);
  for (const result of results)
    assert.equal(await readFile(result.filePath!, "utf8"), '{"parallel":true}');
  assert.equal(await readFile(source, "utf8"), '{"parallel":true}');
});

test("an exclusive-create collision retries without removing the competing file", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "payload.json");
  await writeFile(source, "source bytes");
  let raced = false;
  const importer = createFileImporter({
    io: {
      open: async (target: string, flags: string, mode: number) => {
        if (!raced) {
          raced = true;
          await writeFile(target, "competing writer", { flag: "wx" });
          throw Object.assign(new Error("exclusive collision"), {
            code: "EEXIST",
          });
        }
        return nativeOpen(target, flags, mode);
      },
    },
  });
  const [result] = await importer.importFiles([source], storageDirectory);
  assert.equal(result.name, "payload-2.json");
  assert.equal(
    await readFile(path.join(storageDirectory, "payload.json"), "utf8"),
    "competing writer",
  );
  assert.equal(await readFile(result.filePath!, "utf8"), "source bytes");
  assert.equal(await readFile(source, "utf8"), "source bytes");
});

test("invalid encodings, oversized files and read failures are isolated from later imports", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const invalid = path.join(sourceDirectory, "invalid.json");
  const large = path.join(sourceDirectory, "large.json");
  const missing = path.join(sourceDirectory, "missing.json");
  const nonJson = path.join(sourceDirectory, "other.txt");
  const folder = path.join(sourceDirectory, "folder.json");
  const valid = path.join(sourceDirectory, "valid.json");
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await writeFile(large, "");
  await truncate(large, 20 * 1024 * 1024 + 1);
  await writeFile(nonJson, "{}");
  await mkdir(folder);
  await writeFile(valid, "{}");
  const results = await createFileImporter().importFiles(
    [invalid, large, missing, nonJson, folder, valid],
    storageDirectory,
  );
  assert.match(results[0].error!, /UTF-8/);
  assert.match(results[1].error!, /20 MiB/);
  assert.match(results[3].error!, /\.json/);
  assert.match(results[4].error!, /不是文件/);
  for (const result of results.slice(0, -1)) {
    assert.equal(result.content, "");
    assert.ok(result.error);
    assert.equal(result.storageError, undefined);
    assert.equal(result.filePath, undefined);
    assert.ok(path.isAbsolute(result.sourceFilePath!));
  }
  assert.equal(results.at(-1)?.content, "{}");
  assert.equal(results.at(-1)?.error, undefined);
  assert.deepEqual(await readdir(storageDirectory), ["valid.json"]);
});

test("the size limit is checked again after reading if a source grows", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "growing.json");
  await writeFile(source, "{}");
  const importer = createFileImporter({
    io: { readFile: async () => Buffer.alloc(20 * 1024 * 1024 + 1) },
  });
  const [result] = await importer.importFiles([source], storageDirectory);
  assert.match(result.error!, /20 MiB/);
  assert.equal(result.content, "");
  assert.equal(result.filePath, undefined);
  assert.deepEqual(await readdir(storageDirectory), []);
});

test("a partial write failure preserves readable content and deletes only its incomplete copy", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "payload.json");
  const protectedFile = path.join(storageDirectory, "protected.json");
  const content = '{"preserved":"原文"}\r\n';
  await writeFile(source, content);
  await writeFile(protectedFile, "untouched");
  const importer = createFileImporter({
    io: {
      open: async (target: string, flags: string, mode: number) => {
        const handle = await nativeOpen(target, flags, mode);
        return {
          writeFile: async (buffer: Buffer) => {
            await handle.writeFile(buffer.subarray(0, 3));
            throw new Error("disk full");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    },
  });
  const [result] = await importer.importFiles([source], storageDirectory);
  assert.equal(result.content, content);
  assert.equal(result.error, undefined);
  assert.match(result.storageError!, /disk full/);
  assert.equal(result.filePath, undefined);
  assert.equal(result.sourceFilePath, await realpath(source));
  assert.deepEqual(await readdir(storageDirectory), ["protected.json"]);
  assert.equal(await readFile(protectedFile, "utf8"), "untouched");
  assert.equal(await readFile(source, "utf8"), content);
});

test("a missing storage directory reports a storage error without associating or changing the source", async (t) => {
  const { directory, sourceDirectory } = await fixture(t);
  const source = path.join(sourceDirectory, "payload.json");
  const destination = path.join(directory, "not-created");
  await writeFile(source, "[1,2]");
  const [result] = await createFileImporter().importFiles(
    [source],
    destination,
  );
  assert.equal(result.content, "[1,2]");
  assert.equal(result.error, undefined);
  assert.ok(result.storageError);
  assert.equal(result.filePath, undefined);
  assert.equal(result.sourceFilePath, await realpath(source));
  assert.equal(await readFile(source, "utf8"), "[1,2]");
  await assert.rejects(access(destination));
});

test("storage failures do not prevent subsequent files in the same batch from being stored", async (t) => {
  const { sourceDirectory, storageDirectory } = await fixture(t);
  const first = path.join(sourceDirectory, "first.json");
  const second = path.join(sourceDirectory, "second.json");
  await writeFile(first, "first");
  await writeFile(second, "second");
  let failed = false;
  const importer = createFileImporter({
    io: {
      open: async (target: string, flags: string, mode: number) => {
        if (!failed) {
          failed = true;
          throw new Error("permission denied");
        }
        return nativeOpen(target, flags, mode);
      },
    },
  });
  const results = await importer.importFiles([first, second], storageDirectory);
  assert.equal(results[0].content, "first");
  assert.match(results[0].storageError!, /permission denied/);
  assert.equal(results[0].filePath, undefined);
  assert.equal(results[1].storageError, undefined);
  assert.equal(await readFile(results[1].filePath!, "utf8"), "second");
  assert.deepEqual(await readdir(storageDirectory), ["second.json"]);
});

test("the dropped-file API rejects malformed and non-absolute paths before copying anything", async (t) => {
  const { storageDirectory } = await fixture(t);
  const importer = createFileImporter();
  for (const invalid of [
    null,
    "file.json",
    {},
    ["relative.json"],
    [42],
    ["/invalid\0.json"],
    new Array(1),
  ])
    await assert.rejects(
      importer.importFiles(invalid as string[], storageDirectory),
      /绝对文件路径数组/,
    );
  await assert.rejects(
    importer.importFiles([], "relative-directory"),
    /存储目录无效/,
  );
  assert.deepEqual(await importer.importFiles([], storageDirectory), []);
  assert.deepEqual(await readdir(storageDirectory), []);
});
