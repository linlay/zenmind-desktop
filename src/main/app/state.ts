import type { StartupPhase } from "./lifecycle/startup-phases";
import type { ShutdownMode, ShutdownReport } from "../../shared/shutdown";

export interface MainAppState {
  isHandlingQuit: boolean;
  desktopSsoWebviewCompletionInFlight: boolean;
  shutdownCleanupPromise: Promise<ShutdownReport> | null;
  shutdownCleanupComplete: boolean;
  shutdownMode: ShutdownMode;
  shutdownAckPaths: Set<string>;
  shutdownReport: ShutdownReport | null;
  startupPhase: StartupPhase;
}

export function createMainAppState(initialState: Partial<MainAppState> = {}): MainAppState {
  return {
    isHandlingQuit: initialState.isHandlingQuit ?? false,
    desktopSsoWebviewCompletionInFlight: initialState.desktopSsoWebviewCompletionInFlight ?? false,
    shutdownCleanupPromise: initialState.shutdownCleanupPromise ?? null,
    shutdownCleanupComplete: initialState.shutdownCleanupComplete ?? false,
    shutdownMode: initialState.shutdownMode ?? "user",
    shutdownAckPaths: initialState.shutdownAckPaths ?? new Set(),
    shutdownReport: initialState.shutdownReport ?? null,
    startupPhase: initialState.startupPhase ?? "booting"
  };
}
