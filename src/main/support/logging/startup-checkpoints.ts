let nextOperationId = 0;

export async function runStartupCheckpoint<T>(serviceId: string, operation: string, stage: string, run: () => T | Promise<T>): Promise<T> {
  // The additional diagnostics target Windows startup; other platforms keep the direct operation.
  if (process.platform !== "win32") return run();
  const checkpoints = beginStartupCheckpoints(serviceId, operation);
  checkpoints.next(stage);
  try {
    const result = await run();
    checkpoints.end();
    return result;
  } catch (error) {
    checkpoints.end("failed");
    throw error;
  }
}

// Only pass fixed stage names: command arguments, env and script output can contain secrets.
export function beginStartupCheckpoints(serviceId: string, operation: string) {
  const id = ++nextOperationId;
  let active: { stage: string; startedAt: number } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const log = (status: string) => {
    if (!active) return;
    const elapsedMs = Math.max(0, Math.round(performance.now() - active.startedAt));
    console.info(`[startup-checkpoint] id=${id} serviceId=${serviceId} operation=${operation} stage=${active.stage} status=${status} elapsedMs=${elapsedMs}`);
  };
  const end = (status: "succeeded" | "failed" | "skipped" = "succeeded") => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    log(status);
    active = undefined;
  };
  return {
    next(stage: string) {
      end();
      active = { stage, startedAt: performance.now() };
      log("started");
      heartbeat = setInterval(() => log("waiting"), 5_000);
      heartbeat.unref();
    },
    end
  };
}
