import { isStartupPhaseAtLeast } from "./startup-phases";
import type { MainAppState } from "../state";
import type { ShutdownReport } from "../../../shared/shutdown";
import type { RuntimeEnvResetResult } from "../../infrastructure/filesystem/runtime-env-contracts";

export function createRuntimeResetCoordinator(options: {
  state: MainAppState;
  prepare: () => Promise<{ id: string; result: RuntimeEnvResetResult }>;
  arm: (id: string) => void;
  cancel: (id: string) => void;
  beginShutdown: () => void;
  cleanup: () => Promise<ShutdownReport>;
  flushLogs: () => Promise<void>;
  relaunch: () => void;
  quit: () => void;
  scheduleQuit?: (quit: () => void) => void;
}) {
  return async () => {
    if (options.state.isHandlingQuit) throw new Error("Desktop is already shutting down.");
    if (!isStartupPhaseAtLeast(options.state.startupPhase, "core-ready")) {
      throw new Error("Wait for Desktop startup to finish before resetting the environment.");
    }
    options.state.isHandlingQuit = true;
    let prepared: Awaited<ReturnType<typeof options.prepare>> | undefined;
    try {
      prepared = await options.prepare();
      options.beginShutdown();
      // Use the full process-verification budget also used by app replacement.
      options.state.shutdownMode = "installer";
      const report = await options.cleanup();
      if (!report.ok || report.survivors.length > 0) throw new Error("Runtime reset cancelled: service cleanup failed. Restart Desktop before retrying.");
      await options.flushLogs();
      options.arm(prepared.id);
      options.relaunch();
      (options.scheduleQuit ?? ((quit) => setImmediate(quit)))(options.quit);
      return { ...prepared.result, restartScheduled: true as const };
    } catch (error) {
      let cancellationError: unknown;
      try { if (prepared) options.cancel(prepared.id); }
      catch (failure) { cancellationError = failure; }
      options.state.isHandlingQuit = false;
      options.state.shutdownMode = "user";
      options.state.shutdownCleanupPromise = null;
      options.state.shutdownCleanupComplete = false;
      options.state.shutdownReport = null;
      if (cancellationError) throw new AggregateError([error, cancellationError], "Runtime reset failed; the pending request requires recovery.");
      throw error;
    }
  };
}
