import { useEffect, useState } from "react";
import type { ServiceConfigReadResult, ServiceId, ServiceState } from "@shared/contracts";
import { useServices } from "../services/ServicesContext";
import { useNavigate } from "react-router-dom";

const QUICK_START_ORDER = ["Container Hub", "智能体平台", "小宅助理", "认证服务"];

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
    case "config-required":
    case "initialization-required":
    case "dependency-missing":
      return "warning";
    case "error":
      return "danger";
    case "stopped":
    case "not-installed":
    default:
      return "idle";
  }
}

type ActionScope = "lifecycle" | "detail";
type ConfigMeta = Pick<ServiceConfigReadResult, "path" | "exists" | "source">;
type ServiceGroupKey = "core" | "market";

function shouldShowInitializeAction(service: ServiceState) {
  return service.status === "initialization-required" || service.message.startsWith("初始化失败");
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
  const [activeId, setActiveId] = useState<ServiceId | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<ServiceId | null>(null);
  const [pendingAction, setPendingAction] = useState<{ serviceId: ServiceId; scope: ActionScope } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [isBatchStarting, setIsBatchStarting] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<ServiceGroupKey | null>("core");
  const [configCache, setConfigCache] = useState<Record<string, string>>({});
  const [configMeta, setConfigMeta] = useState<Record<string, ConfigMeta>>({});

  useEffect(() => {
    if (services.length === 0) {
      setSelectedServiceId(null);
      return;
    }

    setSelectedServiceId((current) =>
      current && services.some((service) => service.id === current) ? current : services[0].id
    );
  }, [services]);

  useEffect(() => {
    if (services.length === 0) {
      return;
    }

    const missingServices = services.filter((service) => service.installed && !(service.id in configMeta));
    if (missingServices.length === 0) {
      return;
    }

    void Promise.all(
      missingServices.map(async (service) => {
        try {
          const result = await readConfig(service.id, "env");
          setConfigCache((current) => {
            if (service.id in current) {
              return current;
            }
            return { ...current, [service.id]: result.content };
          });
          setConfigMeta((current) => {
            if (service.id in current) {
              return current;
            }
            return {
              ...current,
              [service.id]: {
                path: result.path,
                exists: result.exists,
                source: result.source
              }
            };
          });
        } catch {
          setConfigCache((current) => ({ ...current, [service.id]: current[service.id] ?? "" }));
          setConfigMeta((current) => ({
            ...current,
            [service.id]: {
              path: "",
              exists: false,
              source: "missing"
            }
          }));
        }
      })
    );
  }, [configMeta, readConfig, services]);

  const serviceCounts = {
    total: services.length,
    running: services.filter((service) => service.status === "running").length
  };

  const coreServices = QUICK_START_ORDER
    .map((name) => services.find((service) => service.name === name))
    .filter((service): service is ServiceState => Boolean(service));

  const marketServices = services.filter((service) => service.kind === "plugin");

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? services[0] ?? null;
  const activeDetailService =
    expandedGroup === null
      ? null
      : expandedGroup === "core"
        ? coreServices.find((service) => service.id === selectedService?.id) ?? coreServices[0] ?? null
        : marketServices.find((service) => service.id === selectedService?.id) ?? marketServices[0] ?? null;
  const selectedConfigMeta = activeDetailService ? configMeta[activeDetailService.id] : undefined;

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
    setExpandedGroup((current) => {
      if (current === group) {
        return null;
      }

      const nextSelectedService =
        group === "core"
          ? coreServices.find((service) => service.id === selectedService?.id) ?? coreServices[0] ?? null
          : marketServices.find((service) => service.id === selectedService?.id) ?? marketServices[0] ?? null;

      if (nextSelectedService) {
        setSelectedServiceId(nextSelectedService.id);
      }

      return group;
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
      .map((name) => services.find((service) => service.name === name))
      .filter((service): service is ServiceState => Boolean(service));

    if (orderedServices.length === 0) {
      setFeedback("当前没有可一键启动的服务。");
      return;
    }

    setIsBatchStarting(true);

    const startedNames: string[] = [];
    const skippedNames: string[] = [];
    const failedMessages: string[] = [];

    try {
      for (const service of orderedServices) {
        if (service.status === "running") {
          skippedNames.push(service.name);
          continue;
        }

        try {
          const result = await start(service.id);
          if (result.ok) {
            startedNames.push(service.name);
          } else {
            failedMessages.push(`${service.name}：${result.message}`);
          }
        } catch (reason) {
          failedMessages.push(
            `${service.name}：${reason instanceof Error ? reason.message : String(reason)}`
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

  return (
    <section className="control-center-page">
      <div className="page-head control-center-hero">
        <div className="control-center-hero-copy">
          <h1>控制中心</h1>
        </div>
        <div className="control-center-hero-panel">
          <div className="summary-strip control-center-summary-strip">
            <div>
              <span className="summary-kicker">已登记</span>
              <strong>{serviceCounts.total}</strong>
              <span>已登记服务</span>
            </div>
            <div>
              <span className="summary-kicker">运行中</span>
              <strong>{serviceCounts.running}</strong>
              <span>运行中</span>
            </div>
          </div>
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}
      {error ? <div className="feedback-banner warning-banner">{error}</div> : null}
      {loading ? <div className="loading-box">正在读取服务状态…</div> : null}

      <div className="control-center-shell">
        <aside className="service-sider">
          <div className="service-accordion">
            {[
              {
                key: "core" as const,
                title: "控制中心",
                subtitle: `${coreServices.length} 个核心服务`,
                services: coreServices,
                empty: "暂无核心服务"
              },
              {
                key: "market" as const,
                title: "插件市场",
                subtitle: `${marketServices.length} 个插件`,
                services: marketServices,
                empty: "暂无已导入插件"
              }
            ].map((group) => {
              const isOpen = expandedGroup === group.key;

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
                        group.services.map((service) => {
                          const isSelected = selectedService?.id === service.id;
                          const isPendingLifecycle =
                            pendingAction?.scope === "lifecycle" && pendingAction.serviceId === service.id;

                          return (
                            <button
                              key={service.id}
                              type="button"
                              className={`service-nav-card${isSelected ? " is-active" : ""}`}
                              onClick={() => setSelectedServiceId(service.id)}
                              aria-pressed={isSelected}
                            >
                              <div className="service-nav-card-head">
                                <h3>{service.name}</h3>
                                <span
                                  className={`status-dot ${isPendingLifecycle ? "loading" : statusDotClass(service.status)}`}
                                  title={isPendingLifecycle ? "处理中" : service.statusLabel}
                                  aria-hidden="true"
                                />
                              </div>
                              <p>{service.description}</p>
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
                <p className="service-kicker">{activeDetailService.version}</p>
                <h2>{activeDetailService.name}</h2>
              </div>
              <span className={`status-pill ${statusClass(activeDetailService.status)}`}>
                {activeDetailService.statusLabel}
              </span>
            </div>

            <p className="service-description">{activeDetailService.description}</p>
            <p className="service-message">{activeDetailService.message}</p>

            <dl className="meta-grid">
              <div>
                <dt>安装目录</dt>
                <dd>{activeDetailService.installDir}</dd>
              </div>
              <div>
                <dt>日志文件</dt>
                <dd>{activeDetailService.healthMeta.logFilePath}</dd>
              </div>
              <div>
                <dt>错误日志</dt>
                <dd>{activeDetailService.healthMeta.errorLogFilePath || "无"}</dd>
              </div>
              <div>
                <dt>PID 文件</dt>
                <dd>{activeDetailService.healthMeta.pidFilePath}</dd>
              </div>
              <div>
                <dt>访问入口</dt>
                <dd>{activeDetailService.healthMeta.webUrl || "无"}</dd>
              </div>
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
                <h3>原文配置</h3>
                <span>{selectedConfigMeta?.path || "将自动创建 .env"}</span>
              </div>
              <textarea
                className="config-editor"
                value={configCache[activeDetailService.id] ?? ""}
                onChange={(event) =>
                  setConfigCache((current) => ({ ...current, [activeDetailService.id]: event.target.value }))
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
                      () => writeConfig(activeDetailService.id, "env", configCache[activeDetailService.id] ?? ""),
                      {
                        invalidateConfig: true
                      }
                    )
                  }
                  disabled={activeId === activeDetailService.id}
                >
                  保存配置
                </button>
              </div>
              {selectedConfigMeta?.source === "template" ? (
                <p className="service-message">当前内容来自模板，保存或初始化后才会写入目标文件。</p>
              ) : null}
            </div>
          </article>
        ) : (
          <div className="loading-box control-center-empty">暂无已登记服务。</div>
        )}
      </div>
    </section>
  );
}
