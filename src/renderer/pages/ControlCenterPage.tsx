import { useEffect, useMemo, useState } from "react";
import type {
  ServiceConfigFile,
  ServiceConfigReadResult,
  ServiceId,
  ServiceLogTarget,
  ServiceState
} from "@shared/contracts";
import { useServices } from "../services/ServicesContext";
import { useLocation, useNavigate } from "react-router-dom";
import { AGENT_WEBCLIENT_DISPLAY_NAME, getServiceDisplayName } from "../service-display";

const CORE_MODULES = [
  {
    id: "agent-container-hub",
    name: "容器仓库",
    description: "宿主机容器服务，负责为后续智能体运行时提供沙箱能力。"
  },
  {
    id: "agent-platform",
    name: "智能体平台",
    description: "AI Agent 运行时，提供对话、工具执行和沙箱能力。"
  },
  {
    id: "agent-webclient",
    name: AGENT_WEBCLIENT_DISPLAY_NAME,
    description: "独立进程模式的 AGENT Web 客户端，负责静态资源托管并代理 API 请求。"
  },
  {
    id: "zenmind-app-server",
    name: "认证服务",
    description: "认证与管理服务，提供 OAuth2/OIDC、管理后台、App 访问令牌和设备管理。"
  }
] as const;

const QUICK_START_ORDER = [
  "zenmind-app-server",
  "agent-platform",
  "agent-webclient"
] as const;
const FEEDBACK_AUTO_CLOSE_MS = 3200;

function statusClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "config-required":
    case "initialization-required":
      return "warning";
    case "dependency-missing":
      return "warning";
    case "error":
      return "danger";
    case "stopped":
    case "not-installed":
      return "idle";
    default:
      return "muted";
  }
}

function statusDotClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "error":
      return "danger";
    case "config-required":
    case "initialization-required":
    case "dependency-missing":
    case "stopped":
    case "not-installed":
    default:
      return "idle";
  }
}

type ActionScope = "lifecycle" | "detail";
type ConfigMeta = Pick<ServiceConfigReadResult, "path" | "exists" | "source">;
type ConfigCache = Record<ServiceId, Record<string, string>>;
type ConfigMetaCache = Record<ServiceId, Record<string, ConfigMeta>>;
type ServiceGroupKey = "core" | "market";
type CoreModuleEntry = (typeof CORE_MODULES)[number] & {
  service: ServiceState | null;
};
type MetaItem = {
  key: string;
  label: string;
  value: string;
  title?: string;
  actionLabel?: string;
  disabled?: boolean;
  onAction?: () => void;
};

function shouldShowInitializeAction(service: ServiceState) {
  return service.status === "initialization-required" || service.message.startsWith("初始化失败");
}

function getErrorLogDisplay(service: ServiceState) {
  if (service.healthMeta.errorLogFilePath) {
    return service.healthMeta.errorLogFilePath;
  }
  if (service.healthMeta.logFilePath) {
    return "无独立错误日志，stderr 已并入日志文件";
  }
  return "未声明";
}

function getConfigSourceLabel(configFile: ServiceConfigFile, meta?: ConfigMeta) {
  if (meta?.source === "file") {
    return "已创建";
  }
  if (meta?.source === "template") {
    return "来自模板";
  }
  if (meta?.source === "missing") {
    return "未创建";
  }
  if (configFile.exists) {
    return "已创建";
  }
  return "未读取";
}

function getConfigSourceClass(configFile: ServiceConfigFile, meta?: ConfigMeta) {
  if (meta?.source === "file") {
    return "is-file";
  }
  if (meta?.source === "template") {
    return "is-template";
  }
  if (meta?.source === "missing") {
    return "is-missing";
  }
  if (configFile.exists) {
    return "is-file";
  }
  return "is-pending";
}

export function ControlCenterPage() {
  const {
    services,
    loading,
    error,
    installBuiltinFromBundle,
    installBuiltin,
    initialize,
    start,
    stop,
    restart,
    readConfig,
    writeConfig,
    refresh,
    installPlugin,
    uninstallPlugin
  } = useServices();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeId, setActiveId] = useState<ServiceId | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<ServiceId | null>(null);
  const [pendingAction, setPendingAction] = useState<{ serviceId: ServiceId; scope: ActionScope } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [isBatchStarting, setIsBatchStarting] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<ServiceGroupKey | null>(null);
  const [configCache, setConfigCache] = useState<ConfigCache>({});
  const [configMeta, setConfigMeta] = useState<ConfigMetaCache>({});
  const [activeConfigKeyByService, setActiveConfigKeyByService] = useState<Record<ServiceId, string>>({});

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const coreModules = useMemo<CoreModuleEntry[]>(
    () =>
      CORE_MODULES.map((module) => ({
        ...module,
        service: serviceById.get(module.id) ?? null
      })),
    [serviceById]
  );
  const coreServices = useMemo(
    () => coreModules.map((module) => module.service).filter((service): service is ServiceState => Boolean(service)),
    [coreModules]
  );
  const marketServices = useMemo(() => services.filter((service) => service.kind === "plugin"), [services]);
  const navigationState = location.state as {
    startupFailure?: {
      serviceId: ServiceId | null;
      message: string;
    };
    selectedServiceId?: ServiceId;
  } | null;
  const startupFailure = navigationState?.startupFailure;
  const selectedServiceIdFromNavigation = navigationState?.selectedServiceId;

  useEffect(() => {
    const currentGroupIds = [...coreModules.map((module) => module.id), ...marketServices.map((service) => service.id)];

    if (currentGroupIds.length === 0) {
      setSelectedServiceId(null);
      return;
    }

    setSelectedServiceId((current) => (current && currentGroupIds.includes(current) ? current : currentGroupIds[0]));
  }, [coreModules, marketServices]);

  useEffect(() => {
    if (!startupFailure) {
      return;
    }

    if (startupFailure.serviceId) {
      setSelectedServiceId(startupFailure.serviceId);
    }
    if (startupFailure.message) {
      setFeedback(startupFailure.message);
    }
  }, [startupFailure]);

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setFeedback((current) => (current === feedback ? "" : current));
    }, FEEDBACK_AUTO_CLOSE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [feedback]);

  useEffect(() => {
    if (!selectedServiceIdFromNavigation) {
      return;
    }
    setSelectedServiceId(selectedServiceIdFromNavigation);
  }, [selectedServiceIdFromNavigation]);

  const serviceCounts = {
    total: services.length,
    running: services.filter((service) => service.status === "running").length
  };
  const selectedCoreModule = coreModules.find((module) => module.id === selectedServiceId) ?? coreModules[0] ?? null;
  const selectedMarketService =
    marketServices.find((service) => service.id === selectedServiceId) ?? null;
  const activeDetailService = selectedMarketService ?? selectedCoreModule?.service ?? null;
  const activeCoreModule = selectedMarketService ? null : selectedCoreModule;
  const selectedConfigKey = activeDetailService ? activeConfigKeyByService[activeDetailService.id] : undefined;
  const selectedConfigFile =
    activeDetailService?.configFiles.find((configFile) => configFile.key === selectedConfigKey) ??
    activeDetailService?.configFiles[0] ??
    null;
  const serviceConfigCache = activeDetailService ? configCache[activeDetailService.id] ?? {} : {};
  const serviceConfigMeta = activeDetailService ? configMeta[activeDetailService.id] ?? {} : {};
  const selectedConfigMeta = selectedConfigFile ? serviceConfigMeta[selectedConfigFile.key] : undefined;
  const selectedConfigContent = selectedConfigFile ? serviceConfigCache[selectedConfigFile.key] ?? "" : "";
  const selectedConfigPathLabel =
    selectedConfigMeta?.path ||
    (selectedConfigFile ? `将自动创建 ${selectedConfigFile.relativePath}` : "未声明配置文件");
  const activeDetailServiceId = activeDetailService?.id ?? "";
  const selectedConfigKeyForRead = selectedConfigFile?.key ?? "";
  const selectedConfigMetaLoaded = Boolean(
    activeDetailService && selectedConfigFile && configMeta[activeDetailService.id]?.[selectedConfigFile.key]
  );
  const errorLogDisplay = activeDetailService ? getErrorLogDisplay(activeDetailService) : "未声明";
  const detailEndpoint = activeDetailService?.healthMeta.webUrl ?? "";

  useEffect(() => {
    if (!activeDetailServiceId || !selectedConfigKeyForRead || selectedConfigMetaLoaded) {
      return;
    }

    let cancelled = false;
    void readConfig(activeDetailServiceId, selectedConfigKeyForRead)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setConfigCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: result.content
          }
        }));
        setConfigMeta((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: {
              path: result.path,
              exists: result.exists,
              source: result.source
            }
          }
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setConfigCache((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: current[activeDetailServiceId]?.[selectedConfigKeyForRead] ?? ""
          }
        }));
        setConfigMeta((current) => ({
          ...current,
          [activeDetailServiceId]: {
            ...(current[activeDetailServiceId] ?? {}),
            [selectedConfigKeyForRead]: {
              path: "",
              exists: false,
              source: "missing"
            }
          }
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [activeDetailServiceId, readConfig, selectedConfigKeyForRead, selectedConfigMetaLoaded]);

  async function openLogViewer(service: ServiceState, target: ServiceLogTarget, title: string) {
    await window.electronAPI.services.openLogViewer({
      serviceId: service.id,
      target,
      title
    });
  }

  function invalidateConfig(serviceId: ServiceId) {
    setConfigCache((current) => {
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
    setConfigMeta((current) => {
      const next = { ...current };
      delete next[serviceId];
      return next;
    });
  }

  function toggleGroup(group: ServiceGroupKey) {
    if (group === "core") {
      const nextSelectedCore = coreModules.find((module) => module.id === selectedServiceId) ?? coreModules[0] ?? null;
      if (nextSelectedCore) {
        setSelectedServiceId(nextSelectedCore.id);
      }
      return;
    }

    setExpandedGroup((current) => {
      const nextExpanded = current === "market" ? null : "market";
      if (nextExpanded === "market") {
        const nextSelectedMarket =
          marketServices.find((service) => service.id === selectedServiceId) ?? marketServices[0] ?? null;
        if (nextSelectedMarket) {
          setSelectedServiceId(nextSelectedMarket.id);
        }
      }
      return nextExpanded;
    });
  }

  async function runAction(
    serviceId: ServiceId,
    scope: ActionScope,
    action: () => Promise<{ ok: boolean; message: string }>,
    options: { invalidateConfig?: boolean } = {}
  ) {
    setActiveId(serviceId);
    if (scope === "lifecycle") {
      setPendingAction({ serviceId, scope });
    }
    try {
      const result = await action();
      setFeedback(result.message);
      if (result.ok && options.invalidateConfig) {
        invalidateConfig(serviceId);
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActiveId((current) => (current === serviceId ? null : current));
      setPendingAction((current) => (current?.serviceId === serviceId ? null : current));
      await refresh();
    }
  }

  async function handleInstallPlugin() {
    try {
      const result = await installPlugin();
      setFeedback(result.message);
      if (result.ok && result.serviceId) {
        invalidateConfig(result.serviceId);
        setSelectedServiceId(result.serviceId);
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function handleQuickStart() {
    const orderedServices = QUICK_START_ORDER
      .map((serviceId) => serviceById.get(serviceId))
      .filter((service): service is ServiceState => Boolean(service));

    if (orderedServices.length === 0) {
      setFeedback("当前没有可一键启动的服务。容器仓库需要手动启动。");
      return;
    }

    setIsBatchStarting(true);

    const startedNames: string[] = [];
    const skippedNames: string[] = [];
    const failedMessages: string[] = [];

    try {
      for (const service of orderedServices) {
        if (service.status === "running") {
          skippedNames.push(getServiceDisplayName(service.id, service.name));
          continue;
        }

        try {
          const result = await start(service.id);
          if (result.ok) {
            startedNames.push(getServiceDisplayName(service.id, service.name));
          } else {
            failedMessages.push(`${getServiceDisplayName(service.id, service.name)}：${result.message}`);
          }
        } catch (reason) {
          failedMessages.push(
            `${getServiceDisplayName(service.id, service.name)}：${reason instanceof Error ? reason.message : String(reason)}`
          );
        }
      }

      const summary = [
        startedNames.length > 0 ? `已启动 ${startedNames.join("、")}` : "",
        skippedNames.length > 0 ? `已跳过运行中的 ${skippedNames.join("、")}` : "",
        failedMessages.length > 0 ? failedMessages.join("；") : ""
      ]
        .filter(Boolean)
        .join("。");

      setFeedback(summary || "一键启动完成。");
    } finally {
      setIsBatchStarting(false);
    }
  }

  const metaItems: MetaItem[] = activeDetailService
    ? [
        {
          key: "installDir",
          label: "安装目录",
          value: activeDetailService.installDir || "未声明",
          title: activeDetailService.installDir || "未声明"
        },
        {
          key: "logFile",
          label: "日志文件",
          value: activeDetailService.healthMeta.logFilePath || "未声明",
          title: activeDetailService.healthMeta.logFilePath || "未声明",
          actionLabel: activeDetailService.healthMeta.logFilePath ? "查看日志" : undefined,
          onAction: activeDetailService.healthMeta.logFilePath
            ? () =>
                void openLogViewer(
                  activeDetailService,
                  "main",
                  `${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} · 日志文件`
                )
            : undefined
        },
        {
          key: "errorLog",
          label: "错误日志",
          value: errorLogDisplay,
          title: errorLogDisplay,
          actionLabel: activeDetailService.healthMeta.errorLogFilePath ? "查看日志" : undefined,
          onAction: activeDetailService.healthMeta.errorLogFilePath
            ? () =>
                void openLogViewer(
                  activeDetailService,
                  "error",
                  `${getServiceDisplayName(activeDetailService.id, activeDetailService.name)} · 错误日志`
                )
            : undefined
        },
        {
          key: "pidFile",
          label: "PID 文件",
          value: activeDetailService.healthMeta.pidFilePath || "未声明",
          title: activeDetailService.healthMeta.pidFilePath || "未声明"
        }
      ]
    : [];

  return (
    <section className="control-center-page">
      <div className="page-head control-center-hero">
        <div className="control-center-hero-copy">
          <h1>控制中心</h1>
        </div>
        <div className="control-center-hero-panel">
            <div className="summary-strip control-center-summary-strip">
              <div>
                <span className="summary-kicker">服务总数</span>
                <strong>{serviceCounts.total}</strong>
              </div>
              <div>
                <span className="summary-kicker">运行实例</span>
                <strong>{serviceCounts.running}</strong>
              </div>
            </div>
          </div>
      </div>

      {feedback || error ? (
        <div className="control-center-feedback-anchor">
          <div className="control-center-feedback-layer" aria-live="polite">
            {feedback ? (
              <div className="feedback-banner control-center-feedback-toast" role="status">
                {feedback}
              </div>
            ) : null}
            {error ? (
              <div className="feedback-banner warning-banner control-center-feedback-toast" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {loading ? <div className="loading-box">正在读取服务状态…</div> : null}

      <div className="control-center-shell">
        <aside className="service-sider">
          <div className="service-accordion">
            {[
              {
                key: "core" as const,
                title: "控制中心",
                subtitle: `${coreModules.length} 个核心服务`,
                services: coreModules,
                empty: "暂无核心服务"
              },
              {
                key: "market" as const,
                title: "功能市场",
                subtitle: `${marketServices.length} 个插件`,
                services: marketServices,
                empty: "暂无已导入插件"
              }
            ].map((group) => {
              const isOpen = group.key === "core" ? true : expandedGroup === group.key;

              return (
                <section
                  key={group.key}
                  className={`service-group${isOpen ? " is-open" : ""}`}
                >
                  <div className="service-group-head">
                    <button
                      type="button"
                      className="service-group-trigger"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={isOpen}
                    >
                      <div className="service-group-copy">
                        <h2>{group.title}</h2>
                        <span>{group.subtitle}</span>
                      </div>
                    </button>
                    {group.key === "core" ? (
                      <button
                        type="button"
                        className="action-button service-group-action"
                        onClick={() => void handleQuickStart()}
                        disabled={isBatchStarting}
                      >
                        {isBatchStarting ? "启动中..." : "一键启动"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="action-button service-group-action service-group-action-primary"
                        onClick={() => void handleInstallPlugin()}
                      >
                        导入插件
                      </button>
                    )}
                  </div>

                  {isOpen ? (
                    <div className="service-nav-list">
                      {group.services.length > 0 ? (
                        group.services.map((item) => {
                          const service = "service" in item ? item.service : item;
                          const cardId = "service" in item ? item.id : item.id;
                          const cardName =
                            "service" in item && service
                              ? getServiceDisplayName(service.id, item.name)
                              : item.name;
                          const cardDescription = "service" in item ? item.description : item.description;
                          const isSelected = selectedServiceId === cardId;
                          const isPendingLifecycle =
                            Boolean(service) &&
                            pendingAction?.scope === "lifecycle" &&
                            pendingAction.serviceId === service.id;
                          const statusLabel = service ? service.statusLabel : "待接入";
                          const statusClassName = isPendingLifecycle
                            ? "loading"
                            : service
                              ? statusDotClass(service.status)
                              : "idle";

                          return (
                            <button
                              key={cardId}
                              type="button"
                              className={`service-nav-card${isSelected ? " is-active" : ""}`}
                              onClick={() => setSelectedServiceId(cardId)}
                              aria-pressed={isSelected}
                            >
                              <div className="service-nav-card-head">
                                <h3>{cardName}</h3>
                                {service ? (
                                  <span
                                    className="service-nav-version-status"
                                    title={isPendingLifecycle ? "处理中" : `${service.version} · ${statusLabel}`}
                                  >
                                    <span className="service-nav-version">{service.version}</span>
                                    <span className={`status-dot ${statusClassName}`} aria-hidden="true" />
                                  </span>
                                ) : (
                                  <span
                                    className={`status-dot ${statusClassName}`}
                                    title={statusLabel}
                                    aria-hidden="true"
                                  />
                                )}
                              </div>
                              <p>{cardDescription}</p>
                            </button>
                          );
                        })
                      ) : (
                        <div className="service-group-empty">{group.empty}</div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </aside>

        {activeDetailService ? (
          <article className="service-card control-center-detail">
            <div className="service-card-head">
              <div>
                <h2>{getServiceDisplayName(activeDetailService.id, activeDetailService.name)}</h2>
              </div>
              <div className="service-card-badges">
                <span className="status-pill muted">{activeDetailService.version}</span>
                <span className={`status-pill ${statusClass(activeDetailService.status)}`}>
                  {activeDetailService.statusLabel}
                </span>
              </div>
            </div>

            {detailEndpoint ? (
              <div className="service-inline-meta">
                <span className="service-inline-meta-label">访问入口</span>
                <div className="service-inline-meta-main">
                  <span
                    className="service-inline-meta-value truncated-hover-value"
                    data-full-value={detailEndpoint}
                  >
                    <span className="truncated-hover-text">{detailEndpoint}</span>
                  </span>
                  {activeDetailService.frontendMode !== "none" && activeDetailService.status === "running" ? (
                    <button
                      type="button"
                      className="text-button control-center-link-action service-inline-meta-open"
                      onClick={() => navigate(`/plugin/${activeDetailService.id}`)}
                    >
                      查看
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <dl className="meta-grid">
              {metaItems.map((item) => (
                <div
                  key={item.key}
                  className={`meta-grid-item${item.actionLabel && item.onAction ? " has-action" : ""}`}
                >
                  <div className="meta-grid-head">
                    <dt>{item.label}</dt>
                    {item.actionLabel && item.onAction ? (
                      <button
                        type="button"
                        className="text-button control-center-link-action meta-grid-action"
                        onClick={item.onAction}
                        disabled={item.disabled}
                      >
                        {item.actionLabel}
                      </button>
                    ) : null}
                  </div>
                  <dd
                    className="truncated-hover-value"
                    data-full-value={item.title || item.value}
                  >
                    <span className="truncated-hover-text">{item.value}</span>
                  </dd>
                </div>
              ))}
            </dl>

            {activeDetailService.healthMeta.prerequisites.length > 0 ? (
              <div className="prereq-box">
                {activeDetailService.healthMeta.prerequisites.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : null}

            <div className="action-row">
              {activeDetailService.kind === "builtin" && activeDetailService.status === "not-installed" ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction(activeDetailService.id, "lifecycle", () => installBuiltinFromBundle(activeDetailService.id), {
                      invalidateConfig: true
                    })
                  }
                  className="action-button primary"
                  disabled={activeId === activeDetailService.id}
                >
                  安装
                </button>
              ) : null}
              {shouldShowInitializeAction(activeDetailService) ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction(activeDetailService.id, "lifecycle", () => initialize(activeDetailService.id), {
                      invalidateConfig: true
                    })
                  }
                  className="action-button primary"
                  disabled={activeId === activeDetailService.id}
                >
                  {activeDetailService.status === "initialization-required" ? "初始化" : "重新初始化"}
                </button>
              ) : null}
              {activeDetailService.kind === "builtin" &&
              (activeDetailService.status === "not-installed" ||
                activeDetailService.status === "stopped" ||
                activeDetailService.status === "error") ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction(activeDetailService.id, "lifecycle", () => installBuiltin(activeDetailService.id), {
                      invalidateConfig: true
                    })
                  }
                  className="action-button ghost"
                  disabled={activeId === activeDetailService.id}
                >
                  重新安装
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => runAction(activeDetailService.id, "lifecycle", () => start(activeDetailService.id))}
                className="action-button primary"
                disabled={activeId === activeDetailService.id}
              >
                启动
              </button>
              <button
                type="button"
                onClick={() => runAction(activeDetailService.id, "lifecycle", () => stop(activeDetailService.id))}
                className="action-button"
                disabled={activeId === activeDetailService.id}
              >
                停止
              </button>
              <button
                type="button"
                onClick={() => runAction(activeDetailService.id, "lifecycle", () => restart(activeDetailService.id))}
                className="action-button"
                disabled={activeId === activeDetailService.id}
              >
                重启
              </button>
              {activeDetailService.frontendMode !== "none" && activeDetailService.status === "running" ? (
                <button
                  type="button"
                  onClick={() => navigate(`/plugin/${activeDetailService.id}`)}
                  className="action-button primary"
                >
                  打开前端
                </button>
              ) : null}
              {activeDetailService.kind === "plugin" ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction(
                      activeDetailService.id,
                      "lifecycle",
                      async () => {
                        const r = await uninstallPlugin(activeDetailService.id);
                        return { ok: r.ok, message: r.message };
                      },
                      { invalidateConfig: true }
                    )
                  }
                  className="action-button ghost"
                  disabled={activeId === activeDetailService.id}
                >
                  卸载插件
                </button>
              ) : null}
            </div>

            <div className="config-panel">
              <div className="config-head">
                <h3>配置文件</h3>
                <span>{selectedConfigPathLabel}</span>
              </div>
              {activeDetailService.configFiles.length > 0 && selectedConfigFile ? (
                <>
                  {activeDetailService.configFiles.length > 1 ? (
                    <div className="config-file-tabs" role="tablist" aria-label="配置文件">
                      {activeDetailService.configFiles.map((configFile) => {
                        const fileMeta = serviceConfigMeta[configFile.key];
                        const isActive = configFile.key === selectedConfigFile.key;
                        return (
                          <button
                            key={configFile.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={`config-file-tab${isActive ? " is-active" : ""}`}
                            onClick={() =>
                              setActiveConfigKeyByService((current) => ({
                                ...current,
                                [activeDetailService.id]: configFile.key
                              }))
                            }
                          >
                            <span>{configFile.label || configFile.relativePath}</span>
                            <span className={`config-file-source ${getConfigSourceClass(configFile, fileMeta)}`}>
                              {getConfigSourceLabel(configFile, fileMeta)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <textarea
                    className="config-editor"
                    value={selectedConfigContent}
                    onChange={(event) =>
                      setConfigCache((current) => ({
                        ...current,
                        [activeDetailService.id]: {
                          ...(current[activeDetailService.id] ?? {}),
                          [selectedConfigFile.key]: event.target.value
                        }
                      }))
                    }
                    spellCheck={false}
                  />
                  <div className="config-footer">
                    <button
                      type="button"
                      className="action-button primary"
                      onClick={() =>
                        runAction(
                          activeDetailService.id,
                          "detail",
                          () => writeConfig(activeDetailService.id, selectedConfigFile.key, selectedConfigContent),
                          {
                            invalidateConfig: true
                          }
                        )
                      }
                      disabled={activeId === activeDetailService.id}
                    >
                      {activeDetailService.kind === "builtin" && activeDetailService.status === "not-installed"
                        ? "保存配置并安装"
                        : "保存配置"}
                    </button>
                  </div>
                  {selectedConfigMeta?.source === "template" ? (
                    <p className="service-message">当前内容来自模板，保存或初始化后才会写入目标文件。</p>
                  ) : null}
                  {selectedConfigMeta?.source === "missing" ? (
                    <p className="service-message">当前文件尚未创建，保存后会写入目标路径。</p>
                  ) : null}
                </>
              ) : (
                <p className="service-message">该服务未声明可编辑配置文件。</p>
              )}
            </div>
          </article>
        ) : activeCoreModule ? (
          <article className="service-card control-center-detail">
            <div className="service-card-head">
              <div>
                <p className="service-kicker">默认集成模块</p>
                <h2>{activeCoreModule.name}</h2>
              </div>
              <span className="status-pill idle">待接入</span>
            </div>

            <p className="service-description">{activeCoreModule.description}</p>
            <p className="service-message">
              该模块会默认展示在控制中心中。当前运行时还没有读到对应服务清单，请确认内置资源已同步到应用后再进行配置和安装。
            </p>
          </article>
        ) : (
          <div className="loading-box control-center-empty">暂无已登记服务。</div>
        )}
      </div>

    </section>
  );
}
