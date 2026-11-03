import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const { createElectronSupervisor } = await import(
  new URL("../../../scripts/dev/dev-electron.mjs", import.meta.url).href
);

class Child extends EventEmitter {
  connected = true;
  pid = 123;
  exitCode: number | null = null;
  messages: string[] = [];
  send(message: { type: string }, callback: (error?: Error) => void) {
    this.messages.push(message.type);
    callback();
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function fixture() {
  const children: Child[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const timers = new Map<number, { at: number; action: () => void }>();
  let now = 0;
  let timer = 0;
  const supervisor = createElectronSupervisor({
    launch: () => {
      const child = new Child();
      children.push(child);
      return child;
    },
    onExit: (code: number) => exits.push(code),
    log: (message: string) => logs.push(message),
    setTimer: (action: () => void, delay: number) => {
      timers.set(++timer, { at: now + delay, action });
      return timer;
    },
    clearTimer: (id: number) => timers.delete(id),
    debounceMs: 100,
    blockedMs: 1_000,
  });
  function tick(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, value]) => value.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].action();
    }
    now = until;
  }
  supervisor.start();
  return { supervisor, children, exits, logs, tick };
}

test("native changes debounce and wait for the old Electron process to exit", () => {
  const { supervisor, children, tick } = fixture();
  supervisor.changed();
  tick(60);
  supervisor.changed();
  tick(99);
  assert.deepEqual(children[0].messages, []);
  tick(1);
  assert.deepEqual(children[0].messages, ["json-craft:dev-restart"]);
  assert.equal(children.length, 1);
  children[0].exit();
  assert.equal(children.length, 2);
});

test("changes during shutdown launch only the latest code after the debounce", () => {
  const { supervisor, children, tick } = fixture();
  supervisor.changed();
  tick(100);
  supervisor.changed();
  children[0].exit();
  tick(99);
  assert.equal(children.length, 1);
  tick(1);
  assert.equal(children.length, 2);
  children[0].emit("exit", 0);
  assert.equal(children.length, 2);
});

test("blocked saves keep the existing process alive and warn instead of forcing a restart", () => {
  const { supervisor, children, exits, logs, tick } = fixture();
  supervisor.changed();
  tick(1_100);
  assert.equal(children.length, 1);
  assert.deepEqual(exits, []);
  assert.ok(logs.some((line) => line.includes("不会强制结束")));
  supervisor.changed();
  tick(2_000);
  assert.deepEqual(children[0].messages, ["json-craft:dev-restart"]);
  children[0].exit();
  assert.equal(children.length, 2);
});

test("stopping cancels pending restarts and waits for graceful exit before closing Vite", () => {
  const { supervisor, children, exits, tick } = fixture();
  supervisor.changed();
  tick(100);
  supervisor.stop();
  supervisor.changed();
  tick(10_000);
  assert.deepEqual(exits, []);
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].messages, [
    "json-craft:dev-restart",
    "json-craft:dev-stop",
  ]);
  children[0].exit();
  assert.deepEqual(exits, [0]);
  supervisor.start();
  assert.equal(children.length, 1);
});

test("normal user exit closes the runner and IPC errors never orphan a live child", () => {
  const normal = fixture();
  normal.children[0].exit(3);
  assert.deepEqual(normal.exits, [3]);
  const failure = fixture();
  failure.children[0].send = (_message, callback) =>
    callback(new Error("closed"));
  failure.supervisor.changed();
  failure.tick(100);
  assert.equal(failure.children.length, 1);
  assert.deepEqual(failure.exits, []);
  failure.children[0].emit("error", new Error("send failed"));
  assert.deepEqual(failure.exits, []);
  failure.supervisor.stop();
  failure.children[0].exit();
  assert.deepEqual(failure.exits, [0]);
});

const mainPath = new URL("../../../electron/main.cjs", import.meta.url);
const mainSource = await readFile(mainPath, "utf8");
const require = createRequire(mainPath);

function mainProcess(dev: boolean, connected: boolean) {
  const process = Object.assign(new EventEmitter(), {
    env: dev ? { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" } : {},
    connected,
  });
  let quits = 0;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    setName() {},
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    quit: () => {
      quits++;
      app.emit("before-quit");
    },
  });
  const electron = {
    app,
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle() {} },
  };
  vm.runInNewContext(mainSource, {
    require: (name: string) => (name === "electron" ? electron : require(name)),
    process,
    __dirname: new URL("../../../electron", import.meta.url).pathname,
  });
  return { process, quits: () => quits };
}

test("native restart and stop use app.quit only in a development process with parent IPC", () => {
  for (const [dev, connected] of [
    [true, true],
    [false, true],
    [true, false],
  ]) {
    const main = mainProcess(dev, connected);
    main.process.emit("message", { type: "unrelated" });
    assert.equal(main.quits(), 0);
    main.process.emit("message", { type: "json-craft:dev-restart" });
    main.process.emit("message", { type: "json-craft:dev-stop" });
    assert.equal(main.quits(), dev && connected ? 2 : 0);
    if (dev && connected) {
      main.process.emit("SIGINT");
      main.process.emit("disconnect");
      assert.equal(main.quits(), 4);
    }
  }
});
