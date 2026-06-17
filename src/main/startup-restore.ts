import type {
  ServiceId,
  StartupRestoreMode,
  StartupRestoreServiceState,
  StartupRestoreState
} from "../shared/contracts";
import { t } from "./i18n/main-i18n";

export const STARTUP_RESTORE_SERVICE_ORDER = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;

export type StartupRestoreControllerOptions = {
  serviceOrder?: readonly ServiceId[];
  onChange?: (state: StartupRestoreState) => void;
};

export type StartupRestoreController = {
  getState(): StartupRestoreState;
  beginSession(mode: StartupRestoreMode): StartupRestoreState;
  updateService(serviceId: ServiceId, phase: StartupRestoreServiceState["phase"], message?: string): StartupRestoreState;
  finishSession(mode: StartupRestoreMode, failures: string[]): StartupRestoreState;
  failCurrentSession(message: string): StartupRestoreState;
  setEnvImportRequired(message?: string): StartupRestoreState;
};

export function createStartupRestoreState(
  phase: StartupRestoreState["phase"] = "idle",
  mode: StartupRestoreMode = "restore",
  serviceOrder: readonly ServiceId[] = STARTUP_RESTORE_SERVICE_ORDER
): StartupRestoreState {
  return {
    mode,
    phase,
    serviceOrder: [...serviceOrder],
    currentServiceId: null,
    failedServiceId: null,
    message: "",
    updatedAt: new Date().toISOString(),
    services: serviceOrder.map<StartupRestoreServiceState>((serviceId) => ({
      serviceId,
      phase: "pending"
    }))
  };
}

export function cloneStartupRestoreState(state: StartupRestoreState) {
  return {
    ...state,
    serviceOrder: [...state.serviceOrder],
    services: state.services.map((service) => ({ ...service }))
  } satisfies StartupRestoreState;
}

export function createStartupRestoreController(
  options: StartupRestoreControllerOptions = {}
): StartupRestoreController {
  const serviceOrder = options.serviceOrder ?? STARTUP_RESTORE_SERVICE_ORDER;
  let currentState = createStartupRestoreState("idle", "restore", serviceOrder);

  function commitState(nextState: StartupRestoreState) {
    currentState = {
      ...cloneStartupRestoreState(nextState),
      updatedAt: new Date().toISOString()
    };
    options.onChange?.(cloneStartupRestoreState(currentState));
    return cloneStartupRestoreState(currentState);
  }

  return {
    getState() {
      return cloneStartupRestoreState(currentState);
    },
    beginSession(mode) {
      return commitState(createStartupRestoreState("running", mode, serviceOrder));
    },
    updateService(serviceId, phase, message = "") {
      const state = cloneStartupRestoreState(currentState);
      if (!state.serviceOrder.includes(serviceId)) {
        console.warn(`[startup] Ignoring non-core startup progress for ${serviceId}: ${phase}${message ? ` - ${message}` : ""}`);
        return state;
      }

      const nextServices = state.services.map((service) =>
        service.serviceId === serviceId
          ? {
              ...service,
              phase,
              message
            }
          : service
      );

      if (phase === "installing" || phase === "initializing" || phase === "starting") {
        return commitState({
          ...state,
          phase: "running",
          currentServiceId: serviceId,
          message,
          services: nextServices
        });
      }

      const allCompleted = nextServices.every((service) =>
        service.phase === "succeeded" || service.phase === "skipped"
      );
      return commitState({
        ...state,
        phase: allCompleted ? "succeeded" : "running",
        currentServiceId: null,
        failedServiceId: phase === "failed" ? serviceId : state.failedServiceId,
        message: allCompleted ? t("startup.summary.ready") : message,
        services: nextServices
      });
    },
    finishSession(mode, failures) {
      const state = cloneStartupRestoreState(currentState);
      const failedServiceId = failures.length > 0
        ? state.services.find((service) => service.phase === "failed")?.serviceId ?? state.failedServiceId
        : null;
      return commitState({
        ...state,
        mode,
        phase: failures.length > 0 ? "failed" : "succeeded",
        currentServiceId: null,
        failedServiceId,
        message: failures.length > 0 ? failures.join(t("common.listSeparator")) : t("startup.summary.ready")
      });
    },
    failCurrentSession(message) {
      const state = cloneStartupRestoreState(currentState);
      if (state.phase !== "running") {
        return state;
      }
      return commitState({
        ...state,
        phase: "failed",
        currentServiceId: null,
        failedServiceId: state.currentServiceId,
        message
      });
    },
    setEnvImportRequired(message = t("dialog.envZipRequired.title")) {
      const state = cloneStartupRestoreState(currentState);
      return commitState({
        ...state,
        phase: "env-import-required",
        message
      });
    }
  };
}
