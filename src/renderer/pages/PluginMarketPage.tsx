import { useDeferredValue, useMemo, useState } from "react";
import type { ServiceState } from "@shared/contracts";
import { useNavigate } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { getServiceDisplayName } from "../service-display";
import "./PluginMarketPage.css";

function getPluginStatusClass(status: ServiceState["status"]) {
  switch (status) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "config-required":
    case "initialization-required":
    case "dependency-missing":
      return "is-warning";
    case "stopped":
    case "not-installed":
    default:
      return "is-idle";
  }
}

function canOpenPlugin(service: ServiceState) {
  return service.frontendMode !== "none" && service.status === "running";
}

export function PluginMarketPage() {
  const navigate = useNavigate();
  const { services, installPlugin } = useServices();
  const [pluginQuery, setPluginQuery] = useState("");
  const deferredPluginQuery = useDeferredValue(pluginQuery);
  const [feedback, setFeedback] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const marketServices = useMemo(
    () => services.filter((service) => service.kind === "plugin"),
    [services]
  );

  const filteredPlugins = useMemo(() => {
    const normalized = deferredPluginQuery.trim().toLowerCase();
    if (!normalized) {
      return marketServices;
    }

    return marketServices.filter((service) =>
      `${getServiceDisplayName(service.id, service.name)} ${service.description} ${service.version} ${service.statusLabel}`
        .toLowerCase()
        .includes(normalized)
    );
  }, [deferredPluginQuery, marketServices]);

  async function handleImportPlugin() {
    setIsImporting(true);
    try {
      const result = await installPlugin();
      setFeedback(result.message);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsImporting(false);
    }
  }

  function handleOpenPlugin(service: ServiceState) {
    if (canOpenPlugin(service)) {
      navigate(`/plugin/${service.id}`);
      return;
    }

    navigate("/control-center", {
      state: {
        selectedServiceId: service.id
      }
    });
  }

  return (
    <section className="market-page">
      <div className="market-shell">
        <header className="market-header">
          <div className="market-header-copy">
            <h1>插件市场</h1>
            <p>{marketServices.length} 个插件</p>
          </div>

          <div className="market-header-actions">
            <button type="button" className="market-action" onClick={() => navigate("/control-center")}>
              管理插件
            </button>
            <button
              type="button"
              className="market-action market-action-primary"
              onClick={() => void handleImportPlugin()}
              disabled={isImporting}
            >
              {isImporting ? "导入中..." : "导入插件"}
            </button>
          </div>
        </header>

        {feedback ? <div className="market-feedback">{feedback}</div> : null}

        <div className="market-search-row">
          <label className="market-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4" />
            </svg>
            <input
              value={pluginQuery}
              onChange={(event) => setPluginQuery(event.target.value)}
              placeholder="搜索插件"
            />
          </label>
        </div>

        {filteredPlugins.length > 0 ? (
          <div className="market-plugin-grid">
            {filteredPlugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className="market-plugin-card"
                onClick={() => handleOpenPlugin(plugin)}
              >
                <div className="market-plugin-card-head">
                  <h2>{getServiceDisplayName(plugin.id, plugin.name)}</h2>
                  <span className="market-plugin-version">
                    <span>{plugin.version}</span>
                    <span
                      className={`market-plugin-status-dot ${getPluginStatusClass(plugin.status)}`}
                      aria-hidden="true"
                    />
                  </span>
                </div>
                <p className="market-plugin-description">{plugin.description}</p>
                <div className="market-plugin-meta">
                  <span>{plugin.statusLabel}</span>
                  <span>{canOpenPlugin(plugin) ? "点击打开" : "点击查看详情"}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <section className="market-empty-state">
            <h2>暂无插件</h2>
            <p>当前还没有已导入插件，可以先从本地导入插件包。</p>
            <button
              type="button"
              className="market-action market-action-primary"
              onClick={() => void handleImportPlugin()}
              disabled={isImporting}
            >
              {isImporting ? "导入中..." : "导入插件"}
            </button>
          </section>
        )}
      </div>
    </section>
  );
}
