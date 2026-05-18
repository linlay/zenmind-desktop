import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  DesktopApi,
  MarketItem,
  MarketListResult,
  MarketSettings,
  ServiceState
} from "@shared/contracts";
import { useNavigate } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { registerDesktopActionProvider } from "../services/desktopActionRegistry";
import { getServiceDisplayName } from "../service-display";
import { MarketPageFrame } from "./market/MarketPageFrame";
import {
  DEFAULT_MARKET_TAB,
  DEFAULT_SKILLS_API_BASE_URL,
  MARKET_TAB_DEFINITIONS,
  createEmptyMarketResult,
  getMarketTabDefinition,
  isValidSkillsApiBaseUrl,
  marketStateLabel,
  matchesMarketItemQuery,
  skillSourceMatches,
  type MarketTab,
  type SkillScope
} from "./market/marketPageModel";
import "./PluginMarketPage.css";

type MarketApi = DesktopApi["market"];
type PluginApi = DesktopApi["plugins"];

const MARKET_API_UNAVAILABLE_MESSAGE = "市场功能已更新，请刷新窗口或重启 Desktop 后再试。";
const PLUGIN_API_UNAVAILABLE_MESSAGE = "插件导入功能已更新，请刷新窗口或重启 Desktop 后再试。";

interface MarketSectionAdapter {
  renderContent: () => ReactNode;
  renderToolbar: () => ReactNode;
}

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

function getMarketItemStatusClass(state: MarketItem["state"]) {
  switch (state) {
    case "installed":
    case "local-imported":
      return "is-running";
    case "update-available":
    case "incompatible":
    case "installing":
      return "is-warning";
    case "failed":
      return "is-error";
    case "not-installed":
    default:
      return "is-idle";
  }
}

function canOpenPlugin(service: ServiceState | null) {
  return Boolean(service && service.frontendMode !== "none" && service.status === "running");
}

function normalizeError(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function marketSourceLabel(item: MarketItem) {
  if (item.type === "sandbox-image") {
    return "Container Hub";
  }
  return item.source === "local" ? "本地导入" : "云端市场";
}

function marketVersionLabel(item: MarketItem) {
  const version = item.installedVersion ?? item.version;
  if (item.type === "sandbox-image") {
    return version || "latest";
  }
  return version.startsWith("v") ? version : `v${version}`;
}

function marketItemStateLabel(item: MarketItem) {
  if (item.type !== "sandbox-image") {
    return marketStateLabel(item.state);
  }
  switch (item.state) {
    case "installed":
      return "可用";
    case "installing":
      return "构建中";
    case "failed":
      return "构建失败";
    case "not-installed":
      return "待构建";
    default:
      return marketStateLabel(item.state);
  }
}

function frontendModeLabel(mode: ServiceState["frontendMode"]) {
  switch (mode) {
    case "standalone":
      return "独立前端";
    case "embedded":
      return "内嵌前端";
    case "none":
    default:
      return "无前端";
  }
}

function pluginMetricLabel(service: ServiceState | null) {
  if (service?.healthMeta.port) {
    return `${service.healthMeta.port} 端口`;
  }
  if (service) {
    return frontendModeLabel(service.frontendMode);
  }
  return "待接入";
}

function marketCardDescription(item: MarketItem) {
  const description = item.description.trim();
  if (description) {
    return description;
  }
  return item.tags.length > 0 ? item.tags.join(" / ") : "";
}

function pluginDetailChips(item: MarketItem, service: ServiceState | null) {
  return [
    service ? frontendModeLabel(service.frontendMode) : null,
    service?.configFiles.length ? `${service.configFiles.length} 个配置` : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

function skillDetailChips(item: MarketItem) {
  return item.tags.slice(0, 3);
}

function sandboxDetailChips(item: MarketItem) {
  return [
    item.imageRef,
    item.buildTargetCount ? `${item.buildTargetCount} 个构建目标` : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

function sandboxMetricLabel(item: MarketItem) {
  if (item.buildStatus) {
    return item.buildStatus;
  }
  return item.imageRef ? "镜像环境" : "environment";
}

function MarketCardGlyph({ kind }: { kind: "plugin" | "skill" | "sandbox" }) {
  if (kind === "sandbox") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l7 4v8l-7 4-7-4V7z" />
        <path d="M12 11l7-4" />
        <path d="M12 11v8" />
        <path d="M12 11L5 7" />
      </svg>
    );
  }

  if (kind === "skill") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4h7l3 3v13H7z" />
        <path d="M14 4v4h4" />
        <path d="M9 12h6M9 15h6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 7l-5 5 5 5" />
      <path d="M15 7l5 5-5 5" />
    </svg>
  );
}

export function PluginMarketPage() {
  const navigate = useNavigate();
  const { services, refresh: refreshServices } = useServices();
  const [activeTab, setActiveTab] = useState<MarketTab>(DEFAULT_MARKET_TAB);
  const [pluginQuery, setPluginQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [sandboxQuery, setSandboxQuery] = useState("");
  const [skillScope, setSkillScope] = useState<SkillScope>("全部");
  const [marketResult, setMarketResult] = useState<MarketListResult>(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [isImportingPlugin, setIsImportingPlugin] = useState(false);
  const [isImportingSkill, setIsImportingSkill] = useState(false);
  const [marketSettings, setMarketSettings] = useState<MarketSettings>({
    skillsApiBaseUrl: DEFAULT_SKILLS_API_BASE_URL
  });
  const [skillsApiDraft, setSkillsApiDraft] = useState(DEFAULT_SKILLS_API_BASE_URL);
  const [isSavingSkillsApi, setIsSavingSkillsApi] = useState(false);
  const [marketFeedback, setMarketFeedback] = useState("");

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
      setMarketFeedback(next.offline ? next.message : "");
    } catch (reason) {
      console.warn("[market-page] failed to load market data", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    async function loadSettings() {
      try {
        const getSettings = getMarketMethod("getSettings");
        if (!getSettings) {
          throw createMissingMarketApiError("getSettings");
        }
        const next = await getSettings();
        setMarketSettings(next);
        setSkillsApiDraft(next.skillsApiBaseUrl);
      } catch (reason) {
        console.warn("[market-page] failed to load market settings", reason);
        setMarketFeedback(normalizeError(reason));
      }
    }
    void loadSettings();
    void loadMarket(false);
  }, []);

  useEffect(() => {
    return registerDesktopActionProvider(async (request) => {
      const nextUrl = typeof request.args?.skillsApiBaseUrl === "string"
        ? request.args.skillsApiBaseUrl.trim()
        : typeof (request.args?.patch as { skillsApiBaseUrl?: unknown } | undefined)?.skillsApiBaseUrl === "string"
          ? String((request.args?.patch as { skillsApiBaseUrl?: unknown }).skillsApiBaseUrl).trim()
          : skillsApiDraft.trim();
      const validation = {
        field: "skillsApiBaseUrl",
        value: nextUrl,
        valid: isValidSkillsApiBaseUrl(nextUrl),
        message: isValidSkillsApiBaseUrl(nextUrl)
          ? "技能市场地址格式正确。"
          : "技能市场地址请输入 http/https 服务根地址，或以 /api/v1 结尾。"
      };

      switch (request.action) {
        case "desktop.page.getFormState":
          return {
            ok: true,
            result: {
              page: "market",
              activeTab,
              fields: {
                skillsApiBaseUrl: {
                  draft: skillsApiDraft,
                  saved: marketSettings.skillsApiBaseUrl,
                  valid: isValidSkillsApiBaseUrl(skillsApiDraft)
                }
              }
            }
          };
        case "desktop.page.validateForm":
          return {
            ok: true,
            result: {
              valid: validation.valid,
              issues: validation.valid ? [] : [validation],
              fields: { skillsApiBaseUrl: validation }
            }
          };
        case "desktop.page.previewPatch":
          return {
            ok: true,
            preview: {
              page: "market",
              changes: [{
                field: "skillsApiBaseUrl",
                from: skillsApiDraft,
                to: nextUrl,
                valid: validation.valid
              }]
            }
          };
        case "desktop.page.applyPatch":
          if (!validation.valid) {
            return {
              ok: false,
              error: {
                code: "invalid_form_patch",
                message: validation.message,
                details: validation
              }
            };
          }
          setActiveTab("skills");
          setSkillsApiDraft(nextUrl);
          setMarketFeedback("已填入技能市场地址，保存前请确认。");
          return {
            ok: true,
            result: {
              applied: true,
              field: "skillsApiBaseUrl",
              value: nextUrl
            }
          };
        default:
          return null;
      }
    });
  }, [activeTab, marketSettings.skillsApiBaseUrl, skillsApiDraft]);

  const pluginItems = useMemo(
    () => marketResult.items.filter((item) => item.type === "plugin" && matchesMarketItemQuery(item, pluginQuery)),
    [marketResult.items, pluginQuery]
  );

  const skillItems = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "skill" && matchesMarketItemQuery(item, skillQuery) && skillSourceMatches(item, skillScope)
    ),
    [marketResult.items, skillQuery, skillScope]
  );

  const sandboxItems = useMemo(
    () => marketResult.items.filter((item) => item.type === "sandbox-image" && matchesMarketItemQuery(item, sandboxQuery)),
    [marketResult.items, sandboxQuery]
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
      await install();
      await refreshEverything();
    } catch (reason) {
      console.warn("[market-page] failed to import plugin", reason);
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
      await importSkill();
      await refreshEverything();
    } catch (reason) {
      console.warn("[market-page] failed to import skill", reason);
    } finally {
      setIsImportingSkill(false);
    }
  }

  async function handleSaveSkillsApiBaseUrl() {
    const nextUrl = skillsApiDraft.trim();
    if (!isValidSkillsApiBaseUrl(nextUrl)) {
      setMarketFeedback("技能市场地址请输入 http/https 服务根地址，或以 /api/v1 结尾。");
      return;
    }
    setIsSavingSkillsApi(true);
    try {
      const saveSettings = getMarketMethod("saveSettings");
      if (!saveSettings) {
        throw createMissingMarketApiError("saveSettings");
      }
      const next = await saveSettings({ skillsApiBaseUrl: nextUrl });
      setMarketSettings(next);
      setSkillsApiDraft(next.skillsApiBaseUrl);
      setMarketFeedback("技能市场地址已保存。");
      await loadMarket(true);
    } catch (reason) {
      console.warn("[market-page] failed to save market settings", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsSavingSkillsApi(false);
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
      await action(item.id);
      await refreshEverything();
    } catch (reason) {
      console.warn(`[market-page] failed to ${item.state === "update-available" ? "update" : "install"} ${item.id}`, reason);
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
      await uninstall(item.id);
      await refreshEverything();
    } catch (reason) {
      console.warn(`[market-page] failed to uninstall ${item.id}`, reason);
    } finally {
      setBusyItemId("");
    }
  }

  async function handleBuildSandboxImage(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const buildSandboxImage = getMarketMethod("buildSandboxImage");
      if (!buildSandboxImage) {
        throw createMissingMarketApiError("buildSandboxImage");
      }
      const result = await buildSandboxImage(item.environmentName ?? item.id);
      setMarketFeedback(result.message);
      await loadMarket(true);
    } catch (reason) {
      console.warn(`[market-page] failed to build sandbox image ${item.id}`, reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setBusyItemId("");
    }
  }

  function handleOpenPlugin(item: MarketItem) {
    const service = serviceById.get(item.id) ?? null;
    if (canOpenPlugin(service)) {
      navigate(`/service/${item.id}`);
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

  function renderSandboxAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    return (
      <button
        type="button"
        className="market-item-action"
        disabled={busy || item.state === "installing"}
        onClick={() => void handleBuildSandboxImage(item)}
      >
        {busy || item.state === "installing" ? "构建中" : item.state === "installed" ? "重新构建" : "构建"}
      </button>
    );
  }

  function renderRefreshButton() {
    return (
      <button type="button" className="market-toolbar-btn" onClick={() => void loadMarket(true)}>
        {isLoadingMarket ? "刷新中" : "刷新市场"}
      </button>
    );
  }

  function renderPluginToolbar() {
    return (
      <>
        {renderRefreshButton()}
        <button
          type="button"
          className="market-toolbar-btn market-toolbar-btn-primary"
          onClick={() => void handleImportPlugin()}
          disabled={isImportingPlugin}
        >
          {isImportingPlugin ? "导入中" : "导入插件"}
        </button>
      </>
    );
  }

  function renderSkillToolbar() {
    return (
      <>
        <label className="market-api-config">
          <span>技能 API</span>
          <input
            value={skillsApiDraft}
            onChange={(event) => setSkillsApiDraft(event.target.value)}
            placeholder={DEFAULT_SKILLS_API_BASE_URL}
          />
        </label>
        {renderRefreshButton()}
        <button
          type="button"
          className="market-toolbar-btn"
          onClick={() => void handleSaveSkillsApiBaseUrl()}
          disabled={isSavingSkillsApi || skillsApiDraft.trim() === marketSettings.skillsApiBaseUrl}
        >
          {isSavingSkillsApi ? "保存中" : "保存地址"}
        </button>
        <button
          type="button"
          className="market-toolbar-btn market-toolbar-btn-primary"
          onClick={() => void handleImportSkill()}
          disabled={isImportingSkill}
        >
          {isImportingSkill ? "导入中" : "本地导入"}
        </button>
      </>
    );
  }

  function renderSandboxToolbar() {
    return (
      <>
        {renderRefreshButton()}
        <button
          type="button"
          className="market-toolbar-btn market-toolbar-btn-primary"
          onClick={() => navigate("/control-center", { state: { selectedServiceId: "agent-container-hub" } })}
        >
          管理 Container Hub
        </button>
      </>
    );
  }

  function renderPluginMarket() {
    return (
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
              const displayName = getServiceDisplayName(plugin.id, plugin.name);
              const description = marketCardDescription(plugin);
              const detailChips = pluginDetailChips(plugin, service);
              return (
                <article
                  key={`${plugin.type}:${plugin.id}`}
                  className="market-plugin-feature"
                  onClick={() => handleOpenPlugin(plugin)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleOpenPlugin(plugin);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="market-plugin-feature-head">
                    <div className="market-card-icon" aria-hidden="true">
                      <MarketCardGlyph kind="plugin" />
                    </div>
                    <div className="market-card-heading">
                      <div className="market-card-title-row">
                        <h2>{displayName}</h2>
                            <span className="market-card-more" aria-hidden="true">...</span>
                      </div>
                      <span className="market-provider-pill">
                        <span className="market-provider-dot" aria-hidden="true" />
                        {marketSourceLabel(plugin)}
                      </span>
                    </div>
                  </div>
                  {description ? <p className="market-card-description">{description}</p> : null}
                  {detailChips.length > 0 ? (
                    <div className="market-card-tags" aria-label={`${displayName} 标签`}>
                      {detailChips.map((chip) => (
                        <span key={chip} className="market-chip">{chip}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="market-plugin-meta">
                    <div className="market-card-footer-main">
                      <span className={`market-state-pill ${getMarketItemStatusClass(plugin.state)}`}>
                        <span
                          className={`market-plugin-status-dot ${service ? getPluginStatusClass(service.status) : getMarketItemStatusClass(plugin.state)}`}
                          aria-hidden="true"
                        />
                        {marketItemStateLabel(plugin)}
                      </span>
                      <span className="market-meta-pill">{marketVersionLabel(plugin)}</span>
                      <span className="market-meta-pill">{pluginMetricLabel(service)}</span>
                    </div>
                    <div className="market-card-footer-action">
                      {renderPluginAction(plugin)}
                    </div>
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
    );
  }

  function renderSkillMarket() {
    return (
      <div className="market-content">
        {marketFeedback ? (
          <div className={marketResult.offline ? "market-status is-warning" : "market-status"} aria-live="polite">
            {marketFeedback}
          </div>
        ) : null}
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
              <p>{marketResult.sourceUrl || marketSettings.skillsApiBaseUrl}</p>
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
                {skillItems.map((skill) => {
                  const description = marketCardDescription(skill);
                  const detailChips = skillDetailChips(skill);
                  return (
                    <article key={`${skill.type}:${skill.id}`} className="market-skill-card">
                      <div className="market-plugin-feature-head">
                        <div className="market-card-icon" aria-hidden="true">
                          <MarketCardGlyph kind="skill" />
                        </div>
                        <div className="market-card-heading">
                          <div className="market-card-title-row">
                            <h3>{skill.name}</h3>
                            <span className="market-card-footer-action">
                              {renderSkillAction(skill)}
                            </span>
                          </div>
                          <span className="market-provider-pill">
                            <span className="market-provider-dot" aria-hidden="true" />
                            {marketSourceLabel(skill)}
                          </span>
                        </div>
                      </div>
                      {description ? <p className="market-card-description">{description}</p> : null}
                      {detailChips.length > 0 ? (
                        <div className="market-card-tags" aria-label={`${skill.name} 标签`}>
                          {detailChips.map((chip) => (
                            <span key={chip} className="market-chip">{chip}</span>
                          ))}
                        </div>
                      ) : null}
                      <div className="market-plugin-meta">
                        <div className="market-card-footer-main">
                          <span className={`market-state-pill ${getMarketItemStatusClass(skill.state)}`}>
                            <span className={`market-plugin-status-dot ${getMarketItemStatusClass(skill.state)}`} aria-hidden="true" />
                            {marketItemStateLabel(skill)}
                          </span>
                          <span className="market-meta-pill">{marketVersionLabel(skill)}</span>
                        </div>
                      </div>
                    </article>
                  );
                })}
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
    );
  }

  function renderSandboxMarket() {
    const hubService = serviceById.get("agent-container-hub") ?? null;
    const sandboxStatus = marketResult.sandboxMessage || (
      hubService?.status && hubService.status !== "running"
        ? "沙箱镜像市场需要先启动 Container Hub。"
        : ""
    );

    return (
      <div className="market-content">
        {sandboxStatus ? (
          <div className={marketResult.sandboxOffline ? "market-status is-warning" : "market-status"} aria-live="polite">
            {sandboxStatus}
          </div>
        ) : null}

        <div className="market-filter-bar market-filter-bar-single">
          <label className="market-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4" />
            </svg>
            <input
              value={sandboxQuery}
              onChange={(event) => setSandboxQuery(event.target.value)}
              placeholder="搜索 environment / 镜像"
            />
          </label>
        </div>

        {sandboxItems.length > 0 ? (
          <div className="market-plugin-panel">
            {sandboxItems.map((image) => {
              const description = marketCardDescription(image);
              const detailChips = sandboxDetailChips(image);
              return (
                <article key={`${image.type}:${image.id}`} className="market-skill-card">
                  <div className="market-plugin-feature-head">
                    <div className="market-card-icon" aria-hidden="true">
                      <MarketCardGlyph kind="sandbox" />
                    </div>
                    <div className="market-card-heading">
                      <div className="market-card-title-row">
                        <h2>{image.name}</h2>
                        <div className="market-card-footer-action">
                          {renderSandboxAction(image)}
                        </div>
                      </div>
                      <span className="market-provider-pill">
                        <span className="market-provider-dot" aria-hidden="true" />
                        {marketSourceLabel(image)}
                      </span>
                    </div>
                  </div>
                  {description ? <p className="market-card-description">{description}</p> : null}
                  {detailChips.length > 0 ? (
                    <div className="market-card-tags" aria-label={`${image.name} 标签`}>
                      {detailChips.map((chip) => (
                        <span key={chip} className="market-chip">{chip}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="market-plugin-meta">
                    <div className="market-card-footer-main">
                      <span className={`market-state-pill ${getMarketItemStatusClass(image.state)}`}>
                        <span className={`market-plugin-status-dot ${getMarketItemStatusClass(image.state)}`} aria-hidden="true" />
                        {marketItemStateLabel(image)}
                      </span>
                      <span className="market-meta-pill">{marketVersionLabel(image)}</span>
                      <span className="market-meta-pill">{sandboxMetricLabel(image)}</span>
                    </div>
                    
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="market-empty-state">
            <h2>{isLoadingMarket ? "正在加载沙箱镜像" : "暂无沙箱镜像"}</h2>
            <p>请先启动 Container Hub，或在 Container Hub 内新增 environment。</p>
          </section>
        )}
      </div>
    );
  }

  const marketSections = {
    plugins: {
      renderContent: renderPluginMarket,
      renderToolbar: renderPluginToolbar
    },
    skills: {
      renderContent: renderSkillMarket,
      renderToolbar: renderSkillToolbar
    },
    sandboxImages: {
      renderContent: renderSandboxMarket,
      renderToolbar: renderSandboxToolbar
    }
  } satisfies Record<MarketTab, MarketSectionAdapter>;
  const activeSection = marketSections[activeTab];
  const activeDefinition = getMarketTabDefinition(activeTab);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={setActiveTab}
      subtitle={activeDefinition.subtitle}
      tabs={MARKET_TAB_DEFINITIONS}
      title={activeDefinition.title}
      toolbar={activeSection.renderToolbar()}
    >
      {activeSection.renderContent()}
    </MarketPageFrame>
  );
}
