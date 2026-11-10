import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { FormatClient } from "../../../src/renderer/services/format-client";
import type { LogExtractionResult } from "../../../src/core/json/log-extract";
import { defaultOptions } from "../../../src/shared/types";
import type { WorkerRequest, WorkerResponse } from "../../../src/shared/worker";

const extracted: LogExtractionResult = {
  items: [],
  truncated: false,
  elapsedMs: 1.25,
};

function fixture(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    messages: WorkerRequest[] = [];
    terminations = 0;
    constructor(
      readonly url: URL,
      readonly options: WorkerOptions,
    ) {
      workers.push(this);
    }
    postMessage(message: WorkerRequest) {
      this.messages.push(message);
    }
    terminate() {
      this.terminations++;
    }
    respond(message: WorkerResponse) {
      this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
    }
    error() {
      this.onerror?.(new Event("error") as ErrorEvent);
    }
    messageError() {
      this.onmessageerror?.(new Event("messageerror") as MessageEvent);
    }
  }
  Object.defineProperty(globalThis, "Worker", {
    value: MockWorker,
    configurable: true,
    writable: true,
  });
  const client = new FormatClient();
  t.after(() => {
    client.dispose();
    if (original) Object.defineProperty(globalThis, "Worker", original);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  return { client, workers };
}

test("extractLog sends the original source and all formatting options to a module worker", async (t) => {
  const { client, workers } = fixture(t);
  const raw = 'INFO payload="{\\"id\\":900719925474099312345}"';
  const options = { ...defaultOptions, indent: "4" as const, repair: false };
  const pending = client.extractLog(raw, options, false);
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.match(worker.url.pathname, /\/src\/core\/worker\.ts$/);
  assert.deepEqual(worker.options, { type: "module" });
  assert.deepEqual(worker.messages, [
    {
      kind: "extract-log",
      id: 1,
      raw,
      options,
      recursiveUnescape: false,
    },
  ]);
  worker.respond({ kind: "extract-log", id: 1, result: extracted });
  assert.equal(await pending, extracted);
  assert.equal(worker.terminations, 0);
});

test("extractLog defaults recursive unescaping to true and reuses its worker", async (t) => {
  const { client, workers } = fixture(t);
  const first = client.extractLog("INFO {}", defaultOptions);
  const second = client.extractLog("WARN []", defaultOptions);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 2);
  assert.deepEqual(
    workers[0].messages.map((message) => message.id),
    [1, 2],
  );
  for (const message of workers[0].messages) {
    assert.equal(message.kind, "extract-log");
    if (message.kind === "extract-log")
      assert.equal(message.recursiveUnescape, true);
  }
  workers[0].respond({ kind: "extract-log", id: 2, result: extracted });
  workers[0].respond({ kind: "extract-log", id: 1, result: extracted });
  assert.deepEqual(await Promise.all([first, second]), [extracted, extracted]);
});

test("cancel terminates the worker and rejects every pending request kind", async (t) => {
  const { client, workers } = fixture(t);
  const pending = [
    client.extractLog("INFO {}", defaultOptions),
    client.format('{"id":1}', defaultOptions),
    client.findKey('{"id":1}', "id", defaultOptions),
    client.alignKeys('{"id":1}', '{"id":2}', "2"),
  ];
  const rejections = Promise.all(
    pending.map((promise) => assert.rejects(promise, /处理已取消/)),
  );
  client.cancel();
  await rejections;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
  client.cancel();
  assert.equal(workers[0].terminations, 1);
});

test("a request after cancel starts a new worker with a fresh increasing id", async (t) => {
  const { client, workers } = fixture(t);
  const previous = client.extractLog("INFO {}", defaultOptions);
  const rejected = assert.rejects(previous, /处理已取消/);
  client.cancel();
  await rejected;
  const next = client.extractLog("INFO []", defaultOptions, false);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminations, 1);
  assert.equal(workers[1].terminations, 0);
  assert.equal(workers[1].messages[0].id, 2);
  workers[1].respond({ kind: "extract-log", id: 2, result: extracted });
  assert.equal(await next, extracted);
});

test("late errors from a canceled worker cannot terminate a replacement worker", async (t) => {
  const { client, workers } = fixture(t);
  const previous = client.extractLog("INFO {}", defaultOptions);
  const rejected = assert.rejects(previous, /处理已取消/);
  client.cancel();
  await rejected;
  const next = client.extractLog("INFO []", defaultOptions);
  workers[0].error();
  workers[0].messageError();
  assert.equal(workers[1].terminations, 0);
  workers[1].respond({ kind: "extract-log", id: 2, result: extracted });
  assert.equal(await next, extracted);
  assert.equal(workers[1].terminations, 0);
});

test("late responses for canceled ids cannot resolve the current extraction", async (t) => {
  const { client, workers } = fixture(t);
  const previous = client.extractLog("INFO {}", defaultOptions);
  const rejected = assert.rejects(previous, /处理已取消/);
  client.cancel();
  await rejected;
  let resolved = false;
  const next = client.extractLog("INFO []", defaultOptions).then((result) => {
    resolved = true;
    return result;
  });
  workers[0].respond({
    kind: "extract-log",
    id: 1,
    result: { ...extracted, error: "stale response" },
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  workers[1].respond({ kind: "extract-log", id: 2, result: extracted });
  assert.equal(await next, extracted);
});

test("active worker errors reject outstanding work and allow a fresh retry", async (t) => {
  const { client, workers } = fixture(t);
  const first = client.extractLog("INFO {}", defaultOptions);
  const firstRejection = assert.rejects(first, /处理进程意外退出/);
  workers[0].error();
  await firstRejection;
  assert.equal(workers[0].terminations, 1);
  const second = client.extractLog("INFO []", defaultOptions);
  const secondRejection = assert.rejects(second, /无法读取处理结果/);
  workers[1].messageError();
  await secondRejection;
  assert.equal(workers[1].terminations, 1);
  const retry = client.extractLog("INFO {}", defaultOptions);
  workers[2].respond({ kind: "extract-log", id: 3, result: extracted });
  assert.equal(await retry, extracted);
});

test("dispose rejects pending extraction and terminates exactly the current worker", async (t) => {
  const { client, workers } = fixture(t);
  const pending = client.extractLog("INFO {}", defaultOptions);
  const rejection = assert.rejects(pending, /工作区已关闭/);
  client.dispose();
  await rejection;
  assert.equal(workers[0].terminations, 1);
  client.dispose();
  assert.equal(workers[0].terminations, 1);
});

test("cancel and dispose are harmless before the first request", (t) => {
  const { client, workers } = fixture(t);
  client.cancel();
  client.dispose();
  assert.deepEqual(workers, []);
});
