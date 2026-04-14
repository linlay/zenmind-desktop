import { useEffect, useState } from "react";
import type { ServiceId, ServiceState } from "@shared/contracts";
import { useServices } from "../services/ServicesContext";
import { useNavigate } from "react-router-dom";

function statusClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "running";
    case "config-required":
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

export function ControlCenterPage() {
  const {
    services,
    loading,
    error,
    installBuiltinFromBundle,
    installBuiltin,
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
  const [configCache, setConfigCache] = useState<Record<string, string>>({});
  const [configPaths, setConfigPaths] = useState<Record<string, string>>({});

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

    const missingServices = services.filter((service) => service.installed && !(service.id in configCache));
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
          setConfigPaths((current) => ({ ...current, [service.id]: result.path }));
        } catch {
          setConfigCache((current) => ({ ...current, [service.id]: current[service.id] ?? "" }));
        }
      })
    );
  }, [configCache, readConfig, services]);

  const serviceCounts = {
    total: services.length,
    running: services.filter((service) => service.status === "running").length,
    pending: services.filter(
      (service) => service.status === "config-required" || service.status === "dependency-missing"
    ).length
  };

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? services[0] ?? null;

  async function runAction(
    serviceId: ServiceId,
    scope: ActionScope,
    action: () => Promise<{ ok: boolean; message: string }>
  ) {
    setActiveId(serviceId);
    if (scope === "lifecycle") {
      setPendingAction({ serviceId, scope });
    }
    try {
      const result = await action();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActiveId((current) => (current === serviceId ? null : current));
      setPendingAction((current) => (current?.serviceId === serviceId ? null : current));
      await refresh();
    }
  }

  return (
    <section className="control-center-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">CONTROL CENTER</p>
          <h1>服务控制中心</h1>
          <p className="page-copy">
            管理 ZenMind Desktop 内置服务与插件的安装、配置、启动和日志。
          </p>
        </div>
        <div className="summary-strip">
          <div>
            <strong>{serviceCounts.total}</strong>
            <span>已登记服务</span>
          </div>
          <div>
            <strong>{serviceCounts.running}</strong>
            <span>运行中</span>
          </div>
          <div>
            <strong>{serviceCounts.pending}</strong>
            <span>待处理</span>
          </div>
          <button
            type="button"
            className="action-button ghost"
            onClick={() => installPlugin()}
          >
            安装插件
          </button>
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}
      {error ? <div className="feedback-banner warning-banner">{error}</div> : null}
      {loading ? <div className="loading-box">正在读取服务状态…</div> : null}

      <div className="control-center-shell">
        <aside className="service-sider">
          <div className="service-nav-list">
            {services.map((service) => {
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
                    <h2>{service.name}</h2>
                    <span
                      className={`status-dot ${isPendingLifecycle ? "loading" : statusDotClass(service.status)}`}
                      title={isPendingLifecycle ? "处理中" : service.statusLabel}
                      aria-hidden="true"
                    />
                  </div>
                  <p>{service.description}</p>
                </button>
              );
            })}
          </div>
        </aside>

        {selectedService ? (
          <article className="service-card control-center-detail">
            <div className="service-card-head">
              <div>
                <p className="service-kicker">{selectedService.version}</p>
                <h2>{selectedService.name}</h2>
              </div>
              <span className={`status-pill ${statusClass(selectedService.status)}`}>
                {selectedService.statusLabel}
              </span>
            </div>

            <p className="service-description">{selectedService.description}</p>
            <p className="service-message">{selectedService.message}</p>

            <dl className="meta-grid">
              <div>
                <dt>安装目录</dt>
                <dd>{selectedService.installDir}</dd>
              </div>
              <div>
                <dt>日志文件</dt>
                <dd>{selectedService.healthMeta.logFilePath}</dd>
              </div>
              <div>
                <dt>错误日志</dt>
                <dd>{selectedService.healthMeta.errorLogFilePath || "无"}</dd>
              </div>
              <div>
                <dt>PID 文件</dt>
                <dd>{selectedService.healthMeta.pidFilePath}</dd>
              </div>
              <div>
                <dt>访问入口</dt>
                <dd>{selectedService.healthMeta.webUrl || "无"}</dd>
              </div>
            </dl>

            {selectedService.healthMeta.prerequisites.length > 0 ? (
              <div className="prereq-box">
                {selectedService.healthMeta.prerequisites.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : null}

            <div className="action-row">
              {selectedService.kind === "builtin" && selectedService.status === "not-installed" ? (
                <button
                  type="button"
                  onClick={() =>
                    runAction(selectedService.id, "lifecycle", () => installBuiltinFromBundle(selectedService.id))
                  }
                  className="action-button primary"
                  disabled={activeId === selectedService.id}
                >
                  安装
                </button>
              ) : null}
              {selectedService.kind === "builtin" &&
              (selectedService.status === "not-installed" ||
                selectedService.status === "stopped" ||
                selectedService.status === "error") ? (
                <button
                  type="button"
                  onClick={() => runAction(selectedService.id, "lifecycle", () => installBuiltin(selectedService.id))}
                  className="action-button ghost"
                  disabled={activeId === selectedService.id}
                >
                  重新安装
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => runAction(selectedService.id, "lifecycle", () => start(selectedService.id))}
                className="action-button primary"
                disabled={activeId === selectedService.id}
              >
                启动
              </button>
              <button
                type="button"
                onClick={() => runAction(selectedService.id, "lifecycle", () => stop(selectedService.id))}
                className="action-button"
                disabled={activeId === selectedService.id}
              >
                停止
              </button>
              <button
                type="button"
                onClick={() => runAction(selectedService.id, "lifecycle", () => restart(selectedService.id))}
                className="action-button"
                disabled={activeId === selectedService.id}
              >
                重启
              </button>
              {selectedService.frontendMode !== "none" && selectedService.status === "running" ? (
                <button
                  type="button"
                  onClick={() => navigate(`/plugin/${selectedService.id}`)}
                  className="action-button primary"
                >
                  打开前端
                </button>
              ) : null}
              {selectedService.kind === "plugin" ? (
                <button
                  type="button"
                  onClick={() => runAction(selectedService.id, "lifecycle", async () => {
                    const r = await uninstallPlugin(selectedService.id);
                    return { ok: r.ok, message: r.message };
                  })}
                  className="action-button ghost"
                  disabled={activeId === selectedService.id}
                >
                  卸载插件
                </button>
              ) : null}
            </div>

            <div className="config-panel">
              <div className="config-head">
                <h3>原文配置</h3>
                <span>{configPaths[selectedService.id] ?? "将自动创建 .env"}</span>
              </div>
              <textarea
                className="config-editor"
                value={configCache[selectedService.id] ?? ""}
                onChange={(event) =>
                  setConfigCache((current) => ({ ...current, [selectedService.id]: event.target.value }))
                }
                spellCheck={false}
              />
              <div className="config-footer">
                <button
                  type="button"
                  className="action-button primary"
                  onClick={() =>
                    runAction(selectedService.id, "detail", () =>
                      writeConfig(selectedService.id, "env", configCache[selectedService.id] ?? "")
                    )
                  }
                  disabled={activeId === selectedService.id}
                >
                  保存配置
                </button>
              </div>
            </div>
          </article>
        ) : (
          <div className="loading-box control-center-empty">暂无已登记服务。</div>
        )}
      </div>
    </section>
  );
}
