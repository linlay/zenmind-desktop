import { useEffect, useState } from "react";
import type { ServiceId } from "@shared/contracts";
import { useServices } from "../services/ServicesContext";

function statusClass(status: string) {
  switch (status) {
    case "running":
      return "running";
    case "config-required":
      return "warning";
    case "error":
      return "danger";
    case "dependency-missing":
      return "danger";
    case "stopped":
      return "idle";
    default:
      return "muted";
  }
}

export function ControlCenterPage() {
  const { services, loading, error, installBuiltin, start, stop, restart, readConfig, writeConfig, importFile, refresh } =
    useServices();
  const [activeId, setActiveId] = useState<ServiceId | null>(null);
  const [feedback, setFeedback] = useState("");
  const [configCache, setConfigCache] = useState<Record<string, string>>({});
  const [configPaths, setConfigPaths] = useState<Record<string, string>>({});

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

  async function runAction(serviceId: ServiceId, action: () => Promise<{ ok: boolean; message: string }>) {
    setActiveId(serviceId);
    try {
      const result = await action();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActiveId(null);
      await refresh();
    }
  }

  return (
    <section className="control-center-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">CONTROL CENTER</p>
          <h1>内置服务控制中心</h1>
          <p className="page-copy">
            管理 ZenMind Desktop 内置核心能力的安装、配置、启动和日志路径。本期先装配 Container Hub 和网盘。
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
        </div>
      </div>

      {feedback ? <div className="feedback-banner">{feedback}</div> : null}
      {error ? <div className="feedback-banner warning-banner">{error}</div> : null}
      {loading ? <div className="loading-box">正在读取服务状态…</div> : null}

      <div className="service-grid">
        {services.map((service) => (
          <article key={service.id} className="service-card">
            <div className="service-card-head">
              <div>
                <p className="service-kicker">{service.version}</p>
                <h2>{service.name}</h2>
              </div>
              <span className={`status-pill ${statusClass(service.status)}`}>{service.statusLabel}</span>
            </div>

            <p className="service-description">{service.description}</p>
            <p className="service-message">{service.message}</p>

            <dl className="meta-grid">
              <div>
                <dt>安装目录</dt>
                <dd>{service.installDir}</dd>
              </div>
              <div>
                <dt>日志文件</dt>
                <dd>{service.healthMeta.logFilePath}</dd>
              </div>
              <div>
                <dt>PID 文件</dt>
                <dd>{service.healthMeta.pidFilePath}</dd>
              </div>
              <div>
                <dt>访问入口</dt>
                <dd>{service.healthMeta.webUrl || "无"}</dd>
              </div>
            </dl>

            {service.healthMeta.prerequisites.length > 0 ? (
              <div className="prereq-box">
                {service.healthMeta.prerequisites.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            ) : null}

            <div className="action-row">
              <button
                type="button"
                onClick={() =>
                  runAction(service.id, () => installBuiltin(service.id))
                }
                className="action-button ghost"
                disabled={activeId === service.id}
              >
                安装
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(service.id, () => start(service.id))
                }
                className="action-button primary"
                disabled={activeId === service.id}
              >
                启动
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(service.id, () => stop(service.id))
                }
                className="action-button"
                disabled={activeId === service.id}
              >
                停止
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(service.id, () => restart(service.id))
                }
                className="action-button"
                disabled={activeId === service.id}
              >
                重启
              </button>
            </div>

            {service.id === "pan-webclient" ? (
              <div className="action-row compact-actions">
                <button
                  type="button"
                  onClick={() =>
                    runAction(service.id, () => importFile(service.id, "local-public-key"))
                  }
                  className="action-button ghost"
                  disabled={activeId === service.id}
                >
                  导入 RSA 公钥
                </button>
              </div>
            ) : null}

            <div className="config-panel">
              <div className="config-head">
                <h3>原文配置</h3>
                <span>{configPaths[service.id] ?? "将自动创建 .env"}</span>
              </div>
              <textarea
                className="config-editor"
                value={configCache[service.id] ?? ""}
                onChange={(event) =>
                  setConfigCache((current) => ({ ...current, [service.id]: event.target.value }))
                }
                spellCheck={false}
              />
              <div className="config-footer">
                <button
                  type="button"
                  className="action-button primary"
                  onClick={() =>
                    runAction(service.id, () => writeConfig(service.id, "env", configCache[service.id] ?? ""))
                  }
                  disabled={activeId === service.id}
                >
                  保存配置
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
