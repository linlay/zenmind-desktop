import { randomBytes } from "node:crypto";
import path from "node:path";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import {
  deserializeWebappToolingError,
  serializeWebappToolingError,
  WebappToolingError,
  type SerializedWebappToolingError,
} from "./errors";
import {
  cleanupWebappToolingTemporaryArtifacts,
  executeWebappToolingTask,
  type WebappToolingResult,
  type WebappToolingTask,
} from "./service";

export const WEBAPP_TOOLING_WORKER_TIMEOUT_MS = 10 * 60 * 1_000;

type WebappToolingWorkerResponse =
  | { ok: true; result: WebappToolingResult }
  | { ok: false; error: SerializedWebappToolingError };

if (!isMainThread && parentPort) {
  const workerPort = parentPort;
  void executeWebappToolingTask(workerData as WebappToolingTask)
    .then((result) => workerPort.postMessage({ ok: true, result } satisfies WebappToolingWorkerResponse))
    .catch((error) => workerPort.postMessage({
      ok: false,
      error: serializeWebappToolingError(error),
    } satisfies WebappToolingWorkerResponse));
}

export function executeWebappToolingInWorker(
  task: WebappToolingTask,
  options: { workerPath?: string; timeoutMs?: number } = {},
): Promise<WebappToolingResult> {
  return new Promise((resolve, reject) => {
    const workerTask = {
      ...task,
      _temporaryToken: randomBytes(16).toString("hex"),
      _retainBuildTemporary: true,
    } satisfies WebappToolingTask;
    const worker = new Worker(
      options.workerPath || path.join(__dirname, "webapp-tooling-worker.js"),
      { workerData: workerTask },
    );
    let settled = false;
    const finish = async (callback: () => void, rollbackCommittedOutput = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await worker.terminate().catch(() => undefined);
      cleanupWebappToolingTemporaryArtifacts(workerTask, { rollbackCommittedOutput });
      callback();
    };
    const timeout = setTimeout(() => void finish(() => reject(new WebappToolingError(
      "internal",
      "tooling_timeout",
      "Desktop WebApp Tooling timed out.",
    )), true), options.timeoutMs ?? WEBAPP_TOOLING_WORKER_TIMEOUT_MS);
    worker.once("message", (response: WebappToolingWorkerResponse) => void finish(() => {
      if (response.ok) resolve(response.result);
      else reject(deserializeWebappToolingError(response.error));
    }, !response.ok));
    worker.once("error", () => void finish(() => reject(new WebappToolingError(
      "internal",
      "tooling_worker_failed",
      "Desktop WebApp Tooling worker failed.",
    )), true));
    worker.once("exit", (code) => {
      if (!settled) void finish(() => reject(new WebappToolingError(
        "internal",
        "tooling_worker_failed",
        `Desktop WebApp Tooling worker exited before completing the request${code === 0 ? "" : ` (code ${code})`}.`,
      )), true);
    });
  });
}
