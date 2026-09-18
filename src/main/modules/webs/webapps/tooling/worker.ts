import { randomBytes } from "node:crypto";
import fs from "node:fs";
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
  options: { workerPath: string; timeoutMs?: number },
): Promise<WebappToolingResult> {
  return new Promise((resolve, reject) => {
    const workerTask = {
      ...task,
      _temporaryToken: randomBytes(16).toString("hex"),
      _retainBuildTemporary: true,
    } satisfies WebappToolingTask;
    let worker: Worker;
    try {
      if (!fs.statSync(options.workerPath).isFile()) throw Object.assign(new Error("Worker entry is not a file"), { code: "WRONG_FILE_TYPE" });
      worker = new Worker(options.workerPath, { workerData: workerTask });
    } catch (error) {
      const causeCode = (error as NodeJS.ErrnoException).code || "UNKNOWN";
      reject(new WebappToolingError("internal", "tooling_worker_unavailable", `Desktop cannot load its WebApp Tooling Worker (${causeCode}).`, {
        category: "internal", executionState: "not_started",
        cause: { code: causeCode, message: "Desktop Worker entry could not be opened or started." },
        context: { workerEntry: "dist-electron/main/webapp-tooling-worker.js", operation: task.operation },
        recovery: { strategy: "repair_host", message: "Rebuild the Desktop Main and Worker together, or repair the installed Desktop package. Do not change projectPath or invoke internal scripts." },
      }));
      return;
    }
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
      { category: "timeout", executionState: "unknown", recovery: { strategy: "inspect", message: "Inspect the project and output after Worker termination before retrying; initialization may have partially completed." } },
    )), true), options.timeoutMs ?? WEBAPP_TOOLING_WORKER_TIMEOUT_MS);
    worker.once("message", (response: WebappToolingWorkerResponse) => void finish(() => {
      if (response.ok) resolve(response.result);
      else reject(deserializeWebappToolingError(response.error));
    }, !response.ok));
    worker.once("error", (error) => void finish(() => reject(new WebappToolingError(
      "internal",
      "tooling_worker_failed",
      `Desktop WebApp Tooling worker failed: ${error.message}`,
      {
        cause: serializeWebappToolingError(error).details.cause,
        executionState: "unknown",
        recovery: { strategy: "repair_host", message: "Repair the Desktop Worker build or runtime before retrying. Changing projectPath does not repair a Worker failure." },
      },
    )), true));
    worker.once("exit", (code) => {
      if (!settled) void finish(() => reject(new WebappToolingError(
        "internal",
        "tooling_worker_failed",
        `Desktop WebApp Tooling worker exited before completing the request${code === 0 ? "" : ` (code ${code})`}.`,
        { exitCode: code, executionState: "unknown", recovery: { strategy: "inspect", message: "Inspect the Desktop Worker failure and project output before retrying; the task may have partially executed." } },
      )), true);
    });
  });
}
