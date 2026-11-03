import { processStructuredJson } from "./json/extracted-json";
import { findKeyValues } from "./json/extract";
import type { WorkerRequest, WorkerResponse } from "../shared/worker";
import type { ProcessingResult } from "../shared/types";

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id, raw, options, kind } = request;
  try {
    const response: WorkerResponse =
      kind === "find-key"
        ? { id, kind, result: findKeyValues(raw, request.key, options) }
        : {
            id,
            kind,
            result: processStructuredJson(
              raw,
              options,
              request.recursiveUnescape ?? true,
            ),
          };
    worker.postMessage(response);
  } catch (error) {
    const failed: ProcessingResult = {
      success: false,
      output: "",
      decodedLayers: 0,
      stages: [],
      changeCount: 0,
      error: {
        message: error instanceof Error ? error.message : "处理失败，请重试。",
      },
    };
    const response: WorkerResponse =
      kind === "find-key"
        ? {
            id,
            kind,
            result: {
              key: request.key,
              preparation: failed,
              matches: [],
              truncated: false,
              error: failed.error?.message,
            },
          }
        : { id, kind, result: failed };
    worker.postMessage(response);
  }
};
