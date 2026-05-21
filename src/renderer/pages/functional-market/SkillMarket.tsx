import { useEffect, useMemo, useState } from "react";
import type { MarketItem, MarketSettings } from "@shared/contracts";
import { useServices } from "../../services/ServicesContext";
import { registerDesktopActionProvider } from "../../services/desktopActionRegistry";
import { MarketPageFrame } from "./MarketPageFrame";
import {
  createMissingMarketApiError,
  getMarketMethod,
  normalizeError
} from "./marketPageApi";
import {
  getMarketItemStatusClass,
  MarketCardGlyph,
  marketCardDescription,
  marketItemStateLabel,
  marketSourceLabel,
  marketVersionLabel,
  skillDetailChips
} from "./marketDisplay";
import {
  DEFAULT_SKILLS_API_BASE_URL,
  MARKET_TAB_DEFINITIONS,
  createEmptyMarketResult,
  getMarketTabDefinition,
  isValidSkillsApiBaseUrl,
  matchesMarketItemQuery,
  skillSourceMatches,
  type MarketViewProps,
  type SkillScope
} from "./marketPageModel";
import "./SkillMarket.css";

interface SkillMarketToolbarProps {
  isImportingSkill: boolean;
  isLoadingMarket: boolean;
  isSavingSkillsApi: boolean;
  marketSettingsSkillsApiBaseUrl: string;
  onImportSkill: () => void;
  onRefresh: () => void;
  onSaveSkillsApiBaseUrl: () => void;
  onSkillsApiDraftChange: (value: string) => void;
  skillsApiDraft: string;
}

interface SkillMarketSectionProps {
  busyItemId: string;
  isImportingSkill: boolean;
  isLoadingMarket: boolean;
  items: MarketItem[];
  marketFeedback: string;
  marketOffline: boolean;
  marketSourceUrl: string;
  marketSettingsSkillsApiBaseUrl: string;
  onImportSkill: () => void;
  onInstallItem: (item: MarketItem) => void;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: SkillScope) => void;
  onUninstallItem: (item: MarketItem) => void;
  query: string;
  scope: SkillScope;
}

export function SkillMarket({ activeTab, onTabChange }: MarketViewProps) {
  const { refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillScope>("全部");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [isImportingSkill, setIsImportingSkill] = useState(false);
  const [marketSettings, setMarketSettings] = useState<MarketSettings>({
    skillsApiBaseUrl: DEFAULT_SKILLS_API_BASE_URL
  });
  const [skillsApiDraft, setSkillsApiDraft] = useState(DEFAULT_SKILLS_API_BASE_URL);
  const [isSavingSkillsApi, setIsSavingSkillsApi] = useState(false);
  const [marketFeedback, setMarketFeedback] = useState("");

  const items = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "skill" && matchesMarketItemQuery(item, query) && skillSourceMatches(item, scope)
    ),
    [marketResult.items, query, scope]
  );

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
      console.warn("[skill-market] failed to load market data", reason);
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
        console.warn("[skill-market] failed to load market settings", reason);
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
          onTabChange("skills");
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
  }, [activeTab, marketSettings.skillsApiBaseUrl, onTabChange, skillsApiDraft]);

  async function refreshEverything() {
    await refreshServices();
    await loadMarket(false);
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
      console.warn("[skill-market] failed to import skill", reason);
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
      console.warn("[skill-market] failed to save market settings", reason);
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
      console.warn(`[skill-market] failed to ${item.state === "update-available" ? "update" : "install"} ${item.id}`, reason);
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
      console.warn(`[skill-market] failed to uninstall ${item.id}`, reason);
    } finally {
      setBusyItemId("");
    }
  }

  const activeDefinition = getMarketTabDefinition(activeTab);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={MARKET_TAB_DEFINITIONS}
      title={activeDefinition.title}
      toolbar={(
        <SkillMarketToolbar
          isImportingSkill={isImportingSkill}
          isLoadingMarket={isLoadingMarket}
          isSavingSkillsApi={isSavingSkillsApi}
          marketSettingsSkillsApiBaseUrl={marketSettings.skillsApiBaseUrl}
          onImportSkill={() => void handleImportSkill()}
          onRefresh={() => void loadMarket(true)}
          onSaveSkillsApiBaseUrl={() => void handleSaveSkillsApiBaseUrl()}
          onSkillsApiDraftChange={setSkillsApiDraft}
          skillsApiDraft={skillsApiDraft}
        />
      )}
    >
      <SkillMarketSection
        busyItemId={busyItemId}
        isImportingSkill={isImportingSkill}
        isLoadingMarket={isLoadingMarket}
        items={items}
        marketFeedback={marketFeedback}
        marketOffline={marketResult.offline}
        marketSettingsSkillsApiBaseUrl={marketSettings.skillsApiBaseUrl}
        marketSourceUrl={marketResult.sourceUrl}
        onImportSkill={() => void handleImportSkill()}
        onInstallItem={(item) => void handleInstallItem(item)}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onUninstallItem={(item) => void handleUninstallItem(item)}
        query={query}
        scope={scope}
      />
    </MarketPageFrame>
  );
}

export function SkillMarketToolbar({
  isImportingSkill,
  isLoadingMarket,
  isSavingSkillsApi,
  marketSettingsSkillsApiBaseUrl,
  onImportSkill,
  onRefresh,
  onSaveSkillsApiBaseUrl,
  onSkillsApiDraftChange,
  skillsApiDraft
}: SkillMarketToolbarProps) {
  return (
    <>
      <label className="market-api-config">
        <span>技能 API</span>
        <input
          value={skillsApiDraft}
          onChange={(event) => onSkillsApiDraftChange(event.target.value)}
          placeholder={DEFAULT_SKILLS_API_BASE_URL}
        />
      </label>
      <button type="button" className="market-toolbar-btn" onClick={onRefresh}>
        {isLoadingMarket ? "刷新中" : "刷新市场"}
      </button>
      <button
        type="button"
        className="market-toolbar-btn"
        onClick={onSaveSkillsApiBaseUrl}
        disabled={isSavingSkillsApi || skillsApiDraft.trim() === marketSettingsSkillsApiBaseUrl}
      >
        {isSavingSkillsApi ? "保存中" : "保存地址"}
      </button>
      <button
        type="button"
        className="market-toolbar-btn market-toolbar-btn-primary"
        onClick={onImportSkill}
        disabled={isImportingSkill}
      >
        {isImportingSkill ? "导入中" : "本地导入"}
      </button>
    </>
  );
}

export function SkillMarketSection({
  busyItemId,
  isImportingSkill,
  isLoadingMarket,
  items,
  marketFeedback,
  marketOffline,
  marketSettingsSkillsApiBaseUrl,
  marketSourceUrl,
  onImportSkill,
  onInstallItem,
  onQueryChange,
  onScopeChange,
  onUninstallItem,
  query,
  scope
}: SkillMarketSectionProps) {
  function renderSkillAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    if (item.state === "not-installed" || item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-skill-action"
          disabled={busy || item.state === "incompatible"}
          onClick={() => onInstallItem(item)}
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
        onClick={() => onUninstallItem(item)}
        aria-label={`卸载 ${item.name}`}
      >
        {busy ? "..." : "✓"}
      </button>
    );
  }

  return (
    <div className="market-content">
      {marketFeedback ? (
        <div className={marketOffline ? "market-status is-warning" : "market-status"} aria-live="polite">
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
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索技能"
          />
        </label>

        <label className="market-select">
          <select value={scope} onChange={(event) => onScopeChange(event.target.value as SkillScope)}>
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
            onClick={onImportSkill}
            disabled={isImportingSkill}
          >
            {isImportingSkill ? "导入中" : "选择文件"}
          </button>
        </section>

        <section className="market-skill-action-card">
          <div>
            <p className="eyebrow">云端下载</p>
            <h2>从云端技能库下载</h2>
            <p>{marketSourceUrl || marketSettingsSkillsApiBaseUrl}</p>
          </div>
          <button type="button" className="market-toolbar-btn" onClick={() => onScopeChange("云端")}>
            浏览云端
          </button>
        </section>
      </div>

      {items.length > 0 ? (
        <div className="market-skill-groups">
          <section className="market-group">
            <div className="market-group-head">
              <h2>{scope === "全部" ? "技能" : `${scope}技能`}</h2>
            </div>

            <div className="market-skill-grid">
              {items.map((skill) => {
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
