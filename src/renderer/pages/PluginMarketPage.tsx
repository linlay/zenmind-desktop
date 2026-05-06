import { useEffect, useMemo, useState } from "react";
import type {
  DesktopApi,
  MarketItem,
  MarketInstallState,
  MarketListResult,
  ServiceState
} from "@shared/contracts";
import { useNavigate } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { getServiceDisplayName } from "../service-display";
import "./PluginMarketPage.css";

type MarketTab = "plugins" | "skills";
type SkillScope = "全部" | "云端" | "本地";
type MarketApi = DesktopApi["market"];
type PluginApi = DesktopApi["plugins"];

const MARKET_API_UNAVAILABLE_MESSAGE = "市场功能已更新，请刷新窗口或重启 Desktop 后再试。";
const PLUGIN_API_UNAVAILABLE_MESSAGE = "插件导入功能已更新，请刷新窗口或重启 Desktop 后再试。";

function getMarketApi(): Partial<MarketApi> | null {
  return ((window.electronAPI as Partial<DesktopApi> | undefined)?.market ?? null) as Partial<MarketApi> | null;
}

function getPluginApi(): Partial<PluginApi> | null {
  return ((window.electronAPI as Partial<DesktopApi> | undefined)?.plugins ?? null) as Partial<PluginApi> | null;
}

function getMarketMethod<K extends keyof MarketApi>(method: K): MarketApi[K] | null {
  const api = getMarketApi();
  const command = api?.[method];
  return typeof command === "function" ? command as MarketApi[K] : null;
}

function getPluginMethod<K extends keyof PluginApi>(method: K): PluginApi[K] | null {
  const api = getPluginApi();
  const command = api?.[method];
  return typeof command === "function" ? command as PluginApi[K] : null;
}

function createMissingMarketApiError(method: keyof MarketApi) {
  return new Error(`${MARKET_API_UNAVAILABLE_MESSAGE}（缺少 market.${method}）`);
}

function createMissingPluginApiError(method: keyof PluginApi) {
  return new Error(`${PLUGIN_API_UNAVAILABLE_MESSAGE}（缺少 plugins.${method}）`);
}

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

function canOpenPlugin(service: ServiceState | null) {
  return Boolean(service && service.frontendMode !== "none" && service.status === "running");
}

function marketStateLabel(state: MarketInstallState) {
  switch (state) {
    case "installed":
      return "已安装";
    case "update-available":
      return "可更新";
    case "local-imported":
      return "本地已导入";
    case "incompatible":
      return "不兼容";
    case "installing":
      return "安装中";
    case "failed":
      return "失败";
    case "not-installed":
    default:
      return "未安装";
  }
}

function matchesQuery(item: MarketItem, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return `${item.name} ${item.description} ${item.version} ${item.tags.join(" ")} ${marketStateLabel(item.state)}`
    .toLowerCase()
    .includes(normalized);
}

function skillSourceMatches(item: MarketItem, scope: SkillScope) {
  if (scope === "云端") {
    return item.source === "cloud";
  }
  if (scope === "本地") {
    return item.source === "local";
  }
  return true;
}

function createEmptyMarketResult(): MarketListResult {
  return {
    ok: true,
    sourceUrl: "",
    offline: false,
    message: "",
    items: []
  };
}

export function PluginMarketPage() {
  const navigate = useNavigate();
  const { services, refresh: refreshServices } = useServices();
  const [activeTab, setActiveTab] = useState<MarketTab>("plugins");
  const [pluginQuery, setPluginQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillScope, setSkillScope] = useState<SkillScope>("全部");
  const [feedback, setFeedback] = useState("");
  const [marketResult, setMarketResult] = useState<MarketListResult>(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [isImportingPlugin, setIsImportingPlugin] = useState(false);
  const [isImportingSkill, setIsImportingSkill] = useState(false);

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName);
      }
      const next = await command();
      setMarketResult(next);
      if (next.offline || force) {
        setFeedback(next.message);
      }
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  const pluginItems = useMemo(
    () => marketResult.items.filter((item) => item.type === "plugin" && matchesQuery(item, pluginQuery)),
    [marketResult.items, pluginQuery]
  );

  const skillItems = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "skill" && matchesQuery(item, skillQuery) && skillSourceMatches(item, skillScope)
    ),
    [marketResult.items, skillQuery, skillScope]
  );

  async function refreshEverything() {
    await refreshServices();
    await loadMarket(false);
  }

  async function handleImportPlugin() {
    setIsImportingPlugin(true);
    try {
      const install = getPluginMethod("install");
      if (!install) {
        throw createMissingPluginApiError("install");
      }
      const result = await install();
      setFeedback(result.message);
      await refreshEverything();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsImportingPlugin(false);
    }
  }

  async function handleImportSkill() {
    setIsImportingSkill(true);
    try {
      const importSkill = getMarketMethod("importSkill");
      if (!importSkill) {
        throw createMissingMarketApiError("importSkill");
      }
      const result = await importSkill();
      setFeedback(result.message);
      await refreshEverything();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsImportingSkill(false);
    }
  }

  async function handleInstallItem(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const commandName = item.state === "update-available" ? "update" : "install";
      const action = getMarketMethod(commandName);
      if (!action) {
        throw createMissingMarketApiError(commandName);
      }
      const result = await action(item.id);
      setFeedback(result.message);
      await refreshEverything();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyItemId("");
    }
  }

  async function handleUninstallItem(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const uninstall = getMarketMethod("uninstall");
      if (!uninstall) {
        throw createMissingMarketApiError("uninstall");
      }
      const result = await uninstall(item.id);
      setFeedback(result.message);
      await refreshEverything();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyItemId("");
    }
  }

  function handleOpenPlugin(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    if (canOpenPlugin(service)) {
      navigate(`/plugin/${item.id}`);
      return;
    }
    navigate("/control-center", {
      state: {
        selectedServiceId: item.id
      }
    });
  }

  function renderPluginAction(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    const busy = busyItemId === item.id;
    if (item.state === "not-installed" || item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-item-action"
          disabled={busy || item.state === "incompatible"}
          onClick={(event) => {
            event.stopPropagation();
            void handleInstallItem(item);
          }}
        >
          {busy ? "安装中" : item.state === "update-available" ? "更新" : "安装"}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="market-item-action"
        onClick={(event) => {
          event.stopPropagation();
          handleOpenPlugin(item);
        }}
      >
        {canOpenPlugin(service) ? "打开" : "管理"}
      </button>
    );
  }

  function renderSkillAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    if (item.state === "not-installed" || item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-skill-action"
          disabled={busy || item.state === "incompatible"}
          onClick={() => void handleInstallItem(item)}
          aria-label={`${item.state === "update-available" ? "更新" : "安装"} ${item.name}`}
        >
          {busy ? "..." : item.state === "update-available" ? "更新" : "+"}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="market-skill-action"
        disabled={busy}
        onClick={() => void handleUninstallItem(item)}
        aria-label={`卸载 ${item.name}`}
      >
        {busy ? "..." : "✓"}
      </button>
    );
  }

  const currentTitle = activeTab === "plugins" ? "插件市场" : "技能市场";
  const currentSubtitle = activeTab === "plugins"
    ? "从云端安装插件，或继续导入本地插件包。"
    : "支持本地导入或从云端下载技能包。";

  return (
    <section className="market-page">
      <div className="market-shell">
        <div className="market-topbar">
          <div className="market-tabs" role="tablist" aria-label="市场页签">
            <button
              type="button"
              className={activeTab === "plugins" ? "market-tab is-active" : "market-tab"}
              onClick={() => {
                setActiveTab("plugins");
                setFeedback("");
              }}
            >
              插件
            </button>
            <button
              type="button"
              className={activeTab === "skills" ? "market-tab is-active" : "market-tab"}
              onClick={() => {
                setActiveTab("skills");
                setFeedback("");
              }}
            >
              技能
            </button>
          </div>

          <div className="market-toolbar">
            <button type="button" className="market-toolbar-btn" onClick={() => void loadMarket(true)}>
              {isLoadingMarket ? "刷新中" : "刷新市场"}
            </button>
            {activeTab === "plugins" ? (
              <button
                type="button"
                className="market-toolbar-btn market-toolbar-btn-primary"
                onClick={() => void handleImportPlugin()}
                disabled={isImportingPlugin}
              >
                {isImportingPlugin ? "导入中" : "导入插件"}
              </button>
            ) : (
              <button
                type="button"
                className="market-toolbar-btn market-toolbar-btn-primary"
                onClick={() => void handleImportSkill()}
                disabled={isImportingSkill}
              >
                {isImportingSkill ? "导入中" : "本地导入"}
              </button>
            )}
          </div>
        </div>

        <div className="market-body">
          <header className="market-hero">
            <h1>{currentTitle}</h1>
            <p>{currentSubtitle}</p>
          </header>

          {feedback ? <div className="market-feedback">{feedback}</div> : null}

          {activeTab === "plugins" ? (
            <div className="market-content">
              <div className="market-filter-bar market-filter-bar-single">
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

              {pluginItems.length > 0 ? (
                <div className="market-plugin-panel">
                  {pluginItems.map((plugin) => {
                    const service = serviceById.get(plugin.id) ?? null;
                    return (
                      <article
                        key={`${plugin.type}:${plugin.id}`}
                        className="market-plugin-feature"
                        onClick={() => handleOpenPlugin(plugin)}
                      >
                        <div className="market-plugin-feature-head">
                          <h2>{getServiceDisplayName(plugin.id, plugin.name)}</h2>
                          <span className="market-plugin-version">
                            {plugin.installedVersion ?? plugin.version}
                            <span
                              className={`market-plugin-status-dot ${service ? getPluginStatusClass(service.status) : "is-idle"}`}
                              aria-hidden="true"
                            />
                          </span>
                        </div>
                        <p>{plugin.description}</p>
                        <div className="market-plugin-meta">
                          <span>{marketStateLabel(plugin.state)}</span>
                          {renderPluginAction(plugin)}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <section className="market-empty-state">
                  <h2>{isLoadingMarket ? "正在加载市场" : "暂无插件"}</h2>
                  <p>可以刷新云端市场，或从本地导入插件包。</p>
                </section>
              )}
            </div>
          ) : (
            <div className="market-content">
              <div className="market-filter-bar">
                <label className="market-search">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="M16 16l4 4" />
                  </svg>
                  <input
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                    placeholder="搜索技能"
                  />
                </label>

                <label className="market-select">
                  <select value={skillScope} onChange={(event) => setSkillScope(event.target.value as SkillScope)}>
                    <option value="全部">全部</option>
                    <option value="云端">云端</option>
                    <option value="本地">本地</option>
                  </select>
                </label>
              </div>

              <div className="market-skill-actions">
                <section className="market-skill-action-card">
                  <div>
                    <p className="eyebrow">本地上传</p>
                    <h2>从本地导入技能</h2>
                    <p>支持 `.zip`、`.tar.gz`、`.skill` 和 `SKILL.md` 文件。</p>
                  </div>
                  <button
                    type="button"
                    className="market-toolbar-btn market-toolbar-btn-primary"
                    onClick={() => void handleImportSkill()}
                    disabled={isImportingSkill}
                  >
                    {isImportingSkill ? "导入中" : "选择文件"}
                  </button>
                </section>

                <section className="market-skill-action-card">
                  <div>
                    <p className="eyebrow">云端下载</p>
                    <h2>从云端技能库下载</h2>
                    <p>{marketResult.sourceUrl || "http://47.100.131.144:9001/marketplace/index.json"}</p>
                  </div>
                  <button type="button" className="market-toolbar-btn" onClick={() => setSkillScope("云端")}>
                    浏览云端
                  </button>
                </section>
              </div>

              {skillItems.length > 0 ? (
                <div className="market-skill-groups">
                  <section className="market-group">
                    <div className="market-group-head">
                      <h2>{skillScope === "全部" ? "技能" : `${skillScope}技能`}</h2>
                    </div>

                    <div className="market-skill-grid">
                      {skillItems.map((skill) => (
                        <article key={`${skill.type}:${skill.id}`} className="market-skill-card">
                          <div className="market-skill-icon" aria-hidden="true">
                            {skill.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="market-skill-copy">
                            <div className="market-skill-title-row">
                              <h3>{skill.name}</h3>
                              <span className={skill.source === "local" ? "market-badge market-badge-local" : "market-badge"}>
                                {marketStateLabel(skill.state)}
                              </span>
                            </div>
                            <p>{skill.description || skill.tags.join(" / ") || skill.version}</p>
                          </div>
                          {renderSkillAction(skill)}
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <section className="market-empty-state">
                  <h2>{isLoadingMarket ? "正在加载技能" : "暂无技能"}</h2>
                  <p>可以刷新云端市场，或从本地导入 Skill 包。</p>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
