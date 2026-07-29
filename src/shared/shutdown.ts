export type ShutdownMode = "user" | "installer";

export type ShutdownFailureKind =
  | "window"
  | "webapp"
  | "service"
  | "gateway"
  | "tunnel";

export type ShutdownFailurePhase = "graceful" | "force" | "verify";

export interface ShutdownFailure {
  kind: ShutdownFailureKind;
  id: string;
  phase: ShutdownFailurePhase;
  message: string;
  pids?: number[];
}

export interface ShutdownReport {
  mode: ShutdownMode;
  ok: boolean;
  timedOut: boolean;
  elapsedMs: number;
  failures: ShutdownFailure[];
  survivors: number[];
}

export type ShutdownProgressPhase =
  | "preparing"
  | "stopping"
  | "forcing"
  | "verifying"
  | "complete"
  | "failed";

export interface ShutdownProgress {
  mode: ShutdownMode;
  phase: ShutdownProgressPhase;
  percent: number;
  message: string;
  elapsedMs: number;
}

export type ShutdownProgressListener = (progress: ShutdownProgress) => void;
