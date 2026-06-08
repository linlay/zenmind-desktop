import { useEffect, useMemo, useState } from "react";
import type { MarketItem } from "@shared/contracts";
import { useServices } from "../../services/ServicesContext";
import { useI18n } from "../../i18n/useI18n";
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
  createEmptyMarketResult,
  getMarketTabDefinitions,
  getMarketTabDefinition,
  matchesMarketItemQuery,
  skillSourceMatches,
  type MarketViewProps,
  type SkillScope
} from "./marketPageModel";
import "./SkillMarket.css";

interface SkillMarketToolbarProps {
  isImportingSkill: boolean;
  isLoadingMarket: boolean;
  onImportSkill: () => void;
  onRefresh: () => void;
}

interface SkillMarketSectionProps {
  busyItemId: string;
  commandDraft: string;
  isImportingSkill: boolean;
  isInstallingCommand: boolean;
  isLoadingMarket: boolean;
  items: MarketItem[];
  marketFeedback: string;
  marketOffline: boolean;
  onCommandDraftChange: (value: string) => void;
  onImportSkill: () => void;
  onInstallCommand: () => void;
  onInstallItem: (item: MarketItem) => void;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: SkillScope) => void;
  onUninstallItem: (item: MarketItem) => void;
  query: string;
  scope: SkillScope;
}

function isPackageDownloadCommand(value: string) {
  return /^(npm|npx)(\s|$)/iu.test(value.trim());
}

export function SkillMarket({ activeTab, onTabChange }: MarketViewProps) {
  const { t } = useI18n();
  const { refresh: refreshServices } = useServices();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillScope>("all");
  const [marketResult, setMarketResult] = useState(createEmptyMarketResult);
  const [isLoadingMarket, setIsLoadingMarket] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [isImportingSkill, setIsImportingSkill] = useState(false);
  const [isInstallingCommand, setIsInstallingCommand] = useState(false);
  const [commandDraft, setCommandDraft] = useState("");
  const [marketFeedback, setMarketFeedback] = useState("");

  const items = useMemo(
    () => marketResult.items.filter((item) =>
      item.type === "skill" && matchesMarketItemQuery(item, query, t) && skillSourceMatches(item, scope)
    ),
    [marketResult.items, query, scope, t]
  );

  async function loadMarket(force = false) {
    setIsLoadingMarket(true);
    try {
      const commandName = force ? "refresh" : "list";
      const command = getMarketMethod(commandName);
      if (!command) {
        throw createMissingMarketApiError(commandName, t);
      }
      const next = await command({ sections: ["skills"] });
      const skillMarketOffline = Boolean(next.skillOffline);
      setMarketResult(next);
      setMarketFeedback(skillMarketOffline ? next.skillMessage ?? "" : "");
    } catch (reason) {
      console.warn("[skill-market] failed to load market data", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket(false);
  }, []);

  useEffect(() => {
    return registerDesktopActionProvider(async (request) => {
      const nextCommand = typeof request.args?.skillDownloadCommand === "string"
        ? request.args.skillDownloadCommand.trim()
        : typeof (request.args?.patch as { skillDownloadCommand?: unknown } | undefined)?.skillDownloadCommand === "string"
          ? String((request.args?.patch as { skillDownloadCommand?: unknown }).skillDownloadCommand).trim()
          : commandDraft.trim();
      const validation = {
        field: "skillDownloadCommand",
        value: nextCommand,
        valid: isPackageDownloadCommand(nextCommand),
        message: isPackageDownloadCommand(nextCommand) ? t("market.skill.download.valid") : t("market.skill.download.unsupported")
      };

      switch (request.action) {
        case "desktop.page.getFormState":
          return {
            ok: true,
            result: {
              page: "market",
              activeTab,
              fields: {
                skillDownloadCommand: {
                  draft: commandDraft,
                  valid: isPackageDownloadCommand(commandDraft)
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
              fields: { skillDownloadCommand: validation }
            }
          };
        case "desktop.page.previewPatch":
          return {
            ok: true,
            preview: {
              page: "market",
              changes: [{
                field: "skillDownloadCommand",
                from: commandDraft,
                to: nextCommand,
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
          setCommandDraft(nextCommand);
          setMarketFeedback(t("market.skill.download.prefilled"));
          return {
            ok: true,
            result: {
              applied: true,
              field: "skillDownloadCommand",
              value: nextCommand
            }
          };
        default:
          return null;
      }
    });
  }, [activeTab, commandDraft, onTabChange, t]);

  async function refreshEverything() {
    await refreshServices();
    await loadMarket(false);
  }

  async function handleImportSkill() {
    setIsImportingSkill(true);
    try {
      const importSkill = getMarketMethod("importSkill");
      if (!importSkill) {
        throw createMissingMarketApiError("importSkill", t);
      }
      const result = await importSkill();
      await refreshEverything();
      setMarketFeedback(result.message);
    } catch (reason) {
      console.warn("[skill-market] failed to import skill", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsImportingSkill(false);
    }
  }

  async function handleInstallCommand() {
    const nextCommand = commandDraft.trim();
    if (!nextCommand) {
      setMarketFeedback(t("market.skill.download.required"));
      return;
    }
    if (!isPackageDownloadCommand(nextCommand)) {
      setMarketFeedback(t("market.skill.download.unsupported"));
      return;
    }
    setIsInstallingCommand(true);
    try {
      const importFromCommand = getMarketMethod("importSkillFromCommand");
      if (!importFromCommand) {
        throw createMissingMarketApiError("importSkillFromCommand", t);
      }
      const result = await importFromCommand(nextCommand);
      await refreshEverything();
      setScope("cloud");
      setMarketFeedback(result.message);
    } catch (reason) {
      console.warn("[skill-market] failed to import skill from command", reason);
      setMarketFeedback(normalizeError(reason));
    } finally {
      setIsInstallingCommand(false);
    }
  }

  async function handleInstallItem(item: MarketItem) {
    setBusyItemId(item.id);
    try {
      const commandName = item.state === "update-available" ? "update" : "install";
      const action = getMarketMethod(commandName);
      if (!action) {
        throw createMissingMarketApiError(commandName, t);
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
        throw createMissingMarketApiError("uninstall", t);
      }
      await uninstall(item.id);
      await refreshEverything();
    } catch (reason) {
      console.warn(`[skill-market] failed to uninstall ${item.id}`, reason);
    } finally {
      setBusyItemId("");
    }
  }

  const activeDefinition = getMarketTabDefinition(activeTab, t);

  return (
    <MarketPageFrame
      activeTab={activeTab}
      onTabChange={onTabChange}
      subtitle={activeDefinition.subtitle}
      tabs={getMarketTabDefinitions(t)}
      title={activeDefinition.title}
      toolbar={(
        <SkillMarketToolbar
          isImportingSkill={isImportingSkill}
          isLoadingMarket={isLoadingMarket}
          onImportSkill={() => void handleImportSkill()}
          onRefresh={() => void loadMarket(true)}
        />
      )}
    >
      <SkillMarketSection
        busyItemId={busyItemId}
        commandDraft={commandDraft}
        isImportingSkill={isImportingSkill}
        isInstallingCommand={isInstallingCommand}
        isLoadingMarket={isLoadingMarket}
        items={items}
        marketFeedback={marketFeedback}
        marketOffline={Boolean(marketResult.skillOffline)}
        onCommandDraftChange={setCommandDraft}
        onImportSkill={() => void handleImportSkill()}
        onInstallCommand={() => void handleInstallCommand()}
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
  onImportSkill,
  onRefresh
}: SkillMarketToolbarProps) {
  const { t } = useI18n();

  return (
    <>
      <button type="button" className="market-toolbar-btn" onClick={onRefresh}>
        {isLoadingMarket ? t("market.toolbar.refreshing") : t("market.toolbar.refreshMarket")}
      </button>
      <button
        type="button"
        className="market-toolbar-btn market-toolbar-btn-primary"
        onClick={onImportSkill}
        disabled={isImportingSkill}
      >
        {isImportingSkill ? t("market.toolbar.importing") : t("market.skill.localImport")}
      </button>
    </>
  );
}

export function SkillMarketSection({
  busyItemId,
  commandDraft,
  isImportingSkill,
  isInstallingCommand,
  isLoadingMarket,
  items,
  marketFeedback,
  marketOffline,
  onCommandDraftChange,
  onImportSkill,
  onInstallCommand,
  onInstallItem,
  onQueryChange,
  onScopeChange,
  onUninstallItem,
  query,
  scope
}: SkillMarketSectionProps) {
  const { t } = useI18n();

  function renderSkillAction(item: MarketItem) {
    const busy = busyItemId === item.id;
    if (item.state === "not-installed" || item.state === "update-available") {
      return (
        <button
          type="button"
          className="market-skill-action"
          disabled={busy || item.state === "incompatible"}
          onClick={() => onInstallItem(item)}
          aria-label={item.state === "update-available" ? t("market.skill.action.update", { name: item.name }) : t("market.skill.action.install", { name: item.name })}
        >
          {busy ? "..." : item.state === "update-available" ? t("market.action.update") : "+"}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="market-skill-action"
        disabled={busy}
        onClick={() => onUninstallItem(item)}
        aria-label={t("market.skill.action.uninstall", { name: item.name })}
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
            placeholder={t("market.search.skills")}
          />
        </label>

        <label className="market-select">
          <select value={scope} onChange={(event) => onScopeChange(event.target.value as SkillScope)}>
            <option value="all">{t("market.skill.scope.all")}</option>
            <option value="cloud">{t("market.skill.scope.cloud")}</option>
            <option value="local">{t("market.skill.scope.local")}</option>
          </select>
        </label>
      </div>

      <div className="market-skill-actions">
        <section className="market-skill-action-card">
          <div>
            <p className="eyebrow">{t("market.skill.localUpload.eyebrow")}</p>
            <h2>{t("market.skill.localUpload.title")}</h2>
            <p>{t("market.skill.localUpload.description")}</p>
          </div>
          <button
            type="button"
            className="market-toolbar-btn market-toolbar-btn-primary"
            onClick={onImportSkill}
            disabled={isImportingSkill}
          >
            {isImportingSkill ? t("market.toolbar.importing") : t("market.skill.localUpload.chooseFile")}
          </button>
        </section>

        <section className="market-skill-action-card market-skill-command-card">
          <div className="market-command-panel">
            <p className="eyebrow">{t("market.skill.cloudDownload.eyebrow")}</p>
            <h2>{t("market.skill.cloudDownload.title")}</h2>
            <label className="market-command-input">
              <input
                value={commandDraft}
                onChange={(event) => onCommandDraftChange(event.target.value)}
                placeholder="npx -y ..."
              />
            </label>
          </div>
          <button
            type="button"
            className="market-toolbar-btn"
            onClick={onInstallCommand}
            disabled={isInstallingCommand || !commandDraft.trim()}
          >
            {isInstallingCommand ? t("market.skill.cloudDownload.downloading") : t("market.skill.cloudDownload.run")}
          </button>
        </section>
      </div>

      {items.length > 0 ? (
        <div className="market-skill-groups">
          <section className="market-group">
            <div className="market-group-head">
              <h2>{scope === "all" ? t("market.skill.group.all") : t("market.skill.group.scoped", { scope: scope === "cloud" ? t("market.skill.scope.cloud") : t("market.skill.scope.local") })}</h2>
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
                          {marketSourceLabel(skill, t)}
                        </span>
                      </div>
                    </div>
                    {description ? <p className="market-card-description">{description}</p> : null}
                    {detailChips.length > 0 ? (
                      <div className="market-card-tags" aria-label={t("market.tags.aria", { name: skill.name })}>
                        {detailChips.map((chip) => (
                          <span key={chip} className="market-chip">{chip}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="market-plugin-meta">
                      <div className="market-card-footer-main">
                        <span className={`market-state-pill ${getMarketItemStatusClass(skill.state)}`}>
                          <span className={`market-plugin-status-dot ${getMarketItemStatusClass(skill.state)}`} aria-hidden="true" />
                          {marketItemStateLabel(skill, t)}
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
          <h2>{isLoadingMarket ? t("market.skill.empty.loading") : t("market.skill.empty.title")}</h2>
          <p>{t("market.skill.empty.description")}</p>
        </section>
      )}
    </div>
  );
}
