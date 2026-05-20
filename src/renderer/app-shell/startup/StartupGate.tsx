import { Navigate } from "react-router-dom";
import type { ServiceId, ServiceState, StartupRestoreState } from "../../../shared/contracts";
import { resolveStartupRootPath } from "../../../shared/startup-gate";
import { formatStartupStatusText } from "../../../shared/startup-status";
import { AGENT_WEBCLIENT_DISPLAY_NAME, getServiceDisplayName } from "../../service-display";

export function RootRouteRedirect({
  startupRestoreState,
  startupAllReady
}: {
  startupRestoreState: StartupRestoreState | null;
  startupAllReady: boolean;
}) {
  const targetPath = resolveStartupRootPath(startupRestoreState, startupAllReady);
  if (!targetPath) {
    return null;
  }

  return <Navigate to={targetPath} replace />;
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
    ? activeService
      ? getServiceDisplayName(activeService.id, activeService.name)
      : getStartupServiceFallbackName(activeAction.serviceId)
    : "";
  const title = hasFailure ? "服务未就绪" : timedOut ? "启动较慢" : "正在启动";
  const statusText = hasFailure
    ? "有核心服务需要处理"
    : timedOut
      ? "核心服务仍在响应中"
      : activeAction
        ? formatStartupStatusText(activeServiceName, activeAction.message)
        : "正在准备核心服务";

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
          <span>已就绪</span>
        </div>

        <div className="startup-loading-list">
          {startupRestoreState.serviceOrder.map((serviceId, index) => {
            const fallbackId = serviceId as ServiceId;
            const service = startupServices[index] ?? null;
            const startupServiceState = startupRestoreState.services.find((item) => item.serviceId === fallbackId);
            const displayName = service
              ? getServiceDisplayName(service.id, service.name)
              : getStartupServiceFallbackName(fallbackId);
            const previousServicesReady = startupRestoreState.serviceOrder
              .slice(0, index)
              .every((previousServiceId) => {
                const previousServiceState = startupRestoreState.services.find((item) => item.serviceId === previousServiceId);
                return previousServiceState?.phase === "succeeded";
              });
            const startupPhase = startupServiceState?.phase ?? "pending";
            const isActiveStartupService =
              !timedOut && (
                startupPhase === "installing" ||
                startupPhase === "initializing" ||
                startupPhase === "starting"
              );
            const isReady = startupPhase === "succeeded";
            const isFailed = startupPhase === "failed";
            const statusLabel = isReady
              ? "已就绪"
              : isFailed
                ? "启动失败"
                : startupPhase === "installing"
                  ? "安装中..."
                  : startupPhase === "initializing"
                    ? "初始化中..."
                : isActiveStartupService
                  ? "启动中..."
                  : !previousServicesReady
                    ? "等待前序服务"
                    : servicesLoading && startupRestoreState.phase === "idle"
                      ? "读取中..."
                      : "等待启动";

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
              重新检查
            </button>
            <button type="button" className="text-button" onClick={onOpenControlCenter}>
              进入控制中心
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getStartupServiceFallbackName(serviceId: ServiceId) {
  switch (serviceId) {
    case "zenmind-app-server":
      return "认证服务";
    case "agent-platform":
      return "智能体平台";
    case "agent-webclient":
      return AGENT_WEBCLIENT_DISPLAY_NAME;
    default:
      return serviceId;
  }
}
