import type { ServiceId } from "./services";

export type NavigateListener = (path: string) => void;
export type ServicesChangedListener = () => void;

export type StartupRestoreMode = "restore" | "bootstrap";
export type StartupRestorePhase = "idle" | "running" | "succeeded" | "failed" | "env-import-required";
export type StartupRestoreServicePhase =
  | "pending"
  | "installing"
  | "initializing"
  | "starting"
  | "succeeded"
  | "failed"
  | "skipped";

export interface StartupRestoreServiceState {
  serviceId: ServiceId;
  phase: StartupRestoreServicePhase;
  message?: string;
}

export interface StartupRestoreState {
  mode: StartupRestoreMode;
  phase: StartupRestorePhase;
  serviceOrder: ServiceId[];
  currentServiceId: ServiceId | null;
  failedServiceId: ServiceId | null;
  message: string;
  updatedAt: string;
  services: StartupRestoreServiceState[];
}

export type StartupRestoreStateListener = (state: StartupRestoreState) => void;
