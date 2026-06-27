import type { CSSProperties } from "react";
import { PRODUCT_NAME } from "../../../shared/brand";
import type { ServiceId, ServiceState, StartupRestoreServicePhase, StartupRestoreState } from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  getDesktopPetStateAsset
} from "../../../shared/desktop-pet";
import type { TranslateFunction } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";

const STARTUP_PET_STATUS = "idle";
const STARTUP_PET_APPEARANCE = DESKTOP_PET_APPEARANCE_OPTIONS.find((appearance) =>
  appearance.id === DEFAULT_DESKTOP_PET_APPEARANCE_ID
) ?? DESKTOP_PET_APPEARANCE_OPTIONS[0];
const STARTUP_PET_IDLE_ASSET = getDesktopPetStateAsset(STARTUP_PET_APPEARANCE?.states, STARTUP_PET_STATUS);
const STARTUP_PET_FRAME_COUNT = Math.max(1, Math.round(Number(STARTUP_PET_IDLE_ASSET?.frameCount) || 1));
const STARTUP_PET_DURATION_MS = Math.max(100, Math.round(Number(STARTUP_PET_IDLE_ASSET?.durationMs) || 900));
const STARTUP_PET_ASSET_PATH = STARTUP_PET_IDLE_ASSET
  ? joinStartupPetAssetPath(STARTUP_PET_APPEARANCE?.assetBasePath ?? "./desktop-pet", STARTUP_PET_IDLE_ASSET.path)
  : "";

const STARTUP_PET_SPRITE_STYLE = {
  "--startup-pet-state-duration": `${STARTUP_PET_DURATION_MS}ms`,
  "--startup-pet-state-frames": String(STARTUP_PET_FRAME_COUNT),
  backgroundImage: `url("${STARTUP_PET_ASSET_PATH}")`
} as CSSProperties;

type StartupRoutePlaceholderProps = {
  showPetGreeting?: boolean;
};

export function StartupRoutePlaceholder({ showPetGreeting = false }: StartupRoutePlaceholderProps) {
  return (
    <div
      className={[
        "startup-route-placeholder",
        showPetGreeting ? "has-pet-greeting" : ""
      ].filter(Boolean).join(" ")}
      aria-hidden={showPetGreeting ? undefined : true}
    >
      {showPetGreeting ? <StartupPetGreeting /> : null}
    </div>
  );
}

function StartupPetGreeting() {
  const { t } = useI18n();
  const greeting = t("startup.placeholderPetGreeting", { name: PRODUCT_NAME });
  if (!STARTUP_PET_IDLE_ASSET || !STARTUP_PET_ASSET_PATH) {
    return null;
  }

  return (
    <section className="startup-pet-greeting" aria-label={greeting}>
      <p className="startup-pet-greeting-bubble">{greeting}</p>
      <div className="startup-pet-greeting-track" aria-hidden="true">
        <span className="startup-pet-greeting-sprite" style={STARTUP_PET_SPRITE_STYLE} />
      </div>
    </section>
  );
}

function joinStartupPetAssetPath(basePath: string, assetPath: string) {
  const normalizedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${normalizedBasePath}${assetPath.replace(/^\/+/u, "")}`;
}

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
  const readyCount = startupRestoreState.services.filter((service) => service.phase === "succeeded").length;
  const totalCount = startupRestoreState.serviceOrder.length;
  const hasFailure = startupRestoreState.phase === "failed";
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
      <div className="startup-loading-card">
        <h1>{title}</h1>
        <p className="startup-loading-status">{statusText}</p>

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
            const startupServiceState = startupRestoreState.services.find((item) => item.serviceId === fallbackId);
            const displayName = getStartupServiceDisplayName(fallbackId, service?.name ?? fallbackId, t);
            const startupPhase = startupServiceState?.phase ?? "pending";
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
          <div className="startup-loading-error">{startupRestoreState.message}</div>
        ) : null}
        {servicesError ? <div className="startup-loading-error">{servicesError}</div> : null}

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
