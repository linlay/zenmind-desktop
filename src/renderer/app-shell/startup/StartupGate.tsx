import type {
  ServiceId,
  ServiceState,
  StartupRestoreServicePhase,
  StartupRestoreState
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";

export function StartupLoadingScreen({
  servicesLoading,
  servicesError,
  startupServices,
  startupRestoreState,
  timedOut,
  onRefresh,
  onOpenControlCenter
}: {
  servicesLoading: boolean;
  servicesError: string;
  startupServices: Array<ServiceState | null>;
  startupRestoreState: StartupRestoreState;
  timedOut: boolean;
  onRefresh: () => void;
  onOpenControlCenter: () => void;
}) {
  const { t } = useI18n();
  const completedButNotReady =
    startupRestoreState.phase === "succeeded" &&
    !servicesLoading &&
    startupServices.some((service) => service?.status !== "running");
  const displayedPhases = startupRestoreState.serviceOrder.map((serviceId, index) => {
    if (completedButNotReady) {
      return startupServices[index]?.status === "running" ? "succeeded" : "failed";
    }
    return startupRestoreState.services.find((service) => service.serviceId === serviceId)?.phase ?? "pending";
  });
  const readyCount = displayedPhases.filter((phase) => phase === "succeeded").length;
  const totalCount = startupRestoreState.serviceOrder.length;
  const hasFailure = startupRestoreState.phase === "failed" || completedButNotReady;
  const activeAction = startupRestoreState.services.find((service) =>
    service.phase === "installing" || service.phase === "initializing" || service.phase === "starting"
  );
  const activeService = activeAction
    ? startupServices[startupRestoreState.serviceOrder.indexOf(activeAction.serviceId)] ?? null
    : null;
  const activeServiceName = activeAction
    ? getStartupServiceDisplayName(
      activeAction.serviceId,
      activeService?.name ?? activeAction.serviceId,
      t
    )
    : "";
  const title = hasFailure
    ? t("startup.title.failed")
    : timedOut
      ? t("startup.title.slow")
      : t("startup.title.starting");
  const statusText = hasFailure
    ? t("startup.status.failed")
    : timedOut
      ? t("startup.status.slow")
      : activeAction
        ? t("startup.status.active", {
          name: activeServiceName,
          phase: getActiveStartupPhaseLabel(activeAction.phase, t)
        })
        : t("startup.status.preparing");

  return (
    <div className="startup-loading-screen">
      <div className="startup-loading-card" role="dialog" aria-labelledby="startup-loading-title">
        <h1 id="startup-loading-title">{title}</h1>
        <p className="startup-loading-status" aria-live="polite">{statusText}</p>

        <div className="startup-loading-progress" aria-hidden="true">
          <span
            className="startup-loading-progress-bar"
            style={{ width: `${(readyCount / Math.max(totalCount, 1)) * 100}%` }}
          />
        </div>

        <div className="startup-loading-summary">
          <strong>{readyCount}/{totalCount}</strong>
          <span>{t("startup.summary.ready")}</span>
        </div>

        <div className="startup-loading-list">
          {startupRestoreState.serviceOrder.map((serviceId, index) => {
            const fallbackId = serviceId as ServiceId;
            const service = startupServices[index] ?? null;
            const displayName = getStartupServiceDisplayName(fallbackId, service?.name ?? fallbackId, t);
            const startupPhase = displayedPhases[index] ?? "pending";
            const identityCenterStartupPhase = startupRestoreState.services.find((item) =>
              item.serviceId === "identity-center"
            )?.phase;
            const waitingForStartupDependency =
              startupRestoreState.mode === "bootstrap" &&
              startupPhase === "pending" &&
              fallbackId !== "identity-center" &&
              identityCenterStartupPhase === "starting";
            const isActiveStartupService =
              !timedOut && (
                startupPhase === "installing" ||
                startupPhase === "initializing" ||
                startupPhase === "starting"
              );
            const isReady = startupPhase === "succeeded";
            const isFailed = startupPhase === "failed";
            const statusLabel = getStartupListPhaseLabel(
              startupPhase,
              waitingForStartupDependency,
              servicesLoading,
              startupRestoreState.phase,
              t
            );

            return (
              <div className="startup-loading-item" key={fallbackId}>
                <span
                  className={[
                    "startup-loading-dot",
                    isReady ? "is-ready" : "",
                    isActiveStartupService && !isReady ? "is-active" : "",
                    isFailed ? "is-failed" : ""
                  ].filter(Boolean).join(" ")}
                  aria-hidden="true"
                />
                <div className="startup-loading-copy">
                  <strong>{displayName}</strong>
                  <span>{statusLabel}</span>
                </div>
              </div>
            );
          })}
        </div>

        {startupRestoreState.phase === "failed" && startupRestoreState.message ? (
          <div className="startup-loading-error" role="alert">{startupRestoreState.message}</div>
        ) : null}
        {servicesError ? <div className="startup-loading-error" role="alert">{servicesError}</div> : null}

        {timedOut || hasFailure ? (
          <div className="startup-loading-actions">
            <button type="button" className="action-button" onClick={onRefresh}>
              {t("startup.action.refresh")}
            </button>
            <button type="button" className="text-button" onClick={onOpenControlCenter}>
              {t("startup.action.openControlCenter")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getStartupServiceDisplayName(serviceId: ServiceId, serviceName: string, t: TranslateFunction) {
  switch (serviceId) {
    case "identity-center":
      return t("startup.service.authentication");
    case "agent-platform":
      return t("startup.service.agentPlatform");
    case "agent-webclient":
      return t("startup.service.agentWebclient");
    default:
      return serviceName;
  }
}

function getActiveStartupPhaseLabel(phase: StartupRestoreServicePhase, t: TranslateFunction) {
  switch (phase) {
    case "installing":
      return t("startup.phase.installing");
    case "initializing":
      return t("startup.phase.initializing");
    case "starting":
    default:
      return t("startup.phase.starting");
  }
}

function getStartupListPhaseLabel(
  phase: StartupRestoreServicePhase,
  waitingForStartupDependency: boolean,
  servicesLoading: boolean,
  startupPhase: StartupRestoreState["phase"],
  t: TranslateFunction
) {
  switch (phase) {
    case "succeeded":
      return t("startup.phase.ready");
    case "failed":
      return t("startup.phase.failed");
    case "installing":
      return t("startup.phase.installing");
    case "initializing":
      return t("startup.phase.initializing");
    case "starting":
      return t("startup.phase.starting");
    default:
      if (waitingForStartupDependency) {
        return t("startup.phase.waitingPrevious");
      }
      if (servicesLoading && startupPhase === "idle") {
        return t("startup.phase.reading");
      }
      return t("startup.phase.waiting");
  }
}
