import type {
  FormatOptions,
  KeySearchResult,
  ProcessingResult,
} from "../../shared/types";
import type { WorkerRequest, WorkerResponse } from "../../shared/worker";

export class FormatClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private requests = new Map<
    number,
    {
      resolve: (result: WorkerResponse["result"]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("../../core/worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = this.requests.get(event.data.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.requests.delete(event.data.id);
      request.resolve(event.data.result);
    };
    worker.onerror = () =>
      this.reset(new Error("处理进程意外退出，请重新格式化。"));
    worker.onmessageerror = () =>
      this.reset(new Error("无法读取处理结果，请重试。"));
    this.worker = worker;
    return worker;
  }

  format(
    raw: string,
    options: FormatOptions,
    recursiveUnescape = true,
  ): Promise<ProcessingResult> {
    return this.request({ kind: "format", raw, options, recursiveUnescape });
  }

  findKey(
    raw: string,
    key: string,
    options: FormatOptions,
  ): Promise<KeySearchResult> {
    return this.request({ kind: "find-key", raw, key, options });
  }

  private request(
    request: Omit<Extract<WorkerRequest, { kind: "format" }>, "id">,
  ): Promise<ProcessingResult>;
  private request(
    request: Omit<Extract<WorkerRequest, { kind: "find-key" }>, "id">,
  ): Promise<KeySearchResult>;
  private request(
    request: Omit<WorkerRequest, "id"> & { key?: string },
  ): Promise<WorkerResponse["result"]> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.reset(new Error("处理超时，请减少文件大小后重试。")),
        60_000,
      );
      this.requests.set(id, { resolve, reject, timer });
      try {
        this.start().postMessage({ ...request, id });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(
          error instanceof Error ? error : new Error("无法启动处理进程。"),
        );
      }
    });
  }

  private reset(error: Error) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.requests.clear();
  }

  dispose() {
    this.reset(new Error("工作区已关闭。"));
  }
}
