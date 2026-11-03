export function createElectronSupervisor({
  launch,
  onExit,
  log = console.log,
  debounceMs = 180,
  blockedMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let child;
  let debounce;
  let warning;
  let restartPending = false;
  let quitting = false;
  let stopping = false;
  let finished = false;
  let stopCode = 0;

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimer(debounce);
    clearTimer(warning);
    onExit(code);
  }

  function requestClose(reason) {
    if (!child || quitting) return;
    quitting = true;
    const target = child;
    const failed = (error) => {
      if (error && child === target)
        log(
          `[dev] 无法发送安全退出请求：${error.message}；请在应用中退出，开发进程会继续等待。`,
        );
    };
    if (target.connected) {
      try {
        target.send({ type: `json-craft:dev-${reason}` }, failed);
      } catch (error) {
        failed(error);
      }
    } else {
      failed(new Error("Electron IPC 已断开"));
    }
    warning = setTimer(() => {
      if (child === target)
        log(
          `[dev] Electron 仍在等待自动保存或退出确认；保留当前进程，不会强制结束。${stopping ? "请解决应用内保存错误后退出。" : "退出完成后会自动重启。"}`,
        );
    }, blockedMs);
  }

  function start() {
    if (child || finished || stopping) return;
    restartPending = false;
    quitting = false;
    try {
      const target = launch();
      child = target;
      target.once("error", (error) => {
        if (child !== target) return;
        log(`[dev] Electron 启动失败：${error.message}`);
        if (target.pid && target.exitCode === null) return;
        child = undefined;
        finish(1);
      });
      target.once("exit", (code) => {
        if (child !== target) return;
        child = undefined;
        quitting = false;
        clearTimer(warning);
        if (stopping) finish(stopCode);
        else if (restartPending) advance();
        else finish(code ?? 1);
      });
    } catch (error) {
      log(`[dev] Electron 启动失败：${error.message}`);
      finish(1);
    }
  }

  function advance() {
    if (finished) return;
    if (stopping) {
      if (child) requestClose("stop");
      else finish(stopCode);
    } else if (restartPending && !debounce) {
      if (child) requestClose("restart");
      else start();
    }
  }

  return {
    start,
    changed() {
      if (stopping || finished) return;
      restartPending = true;
      clearTimer(debounce);
      debounce = setTimer(() => {
        debounce = undefined;
        log("[dev] Electron 代码已更新，等待自动保存后重启…");
        advance();
      }, debounceMs);
    },
    stop(code = 0) {
      if (finished) return;
      stopping = true;
      stopCode = code;
      restartPending = false;
      clearTimer(debounce);
      debounce = undefined;
      if (quitting) {
        log("[dev] 正在等待 Electron 安全退出；请在应用中解决尚未保存的内容。");
        quitting = false;
        clearTimer(warning);
      }
      advance();
    },
  };
}
