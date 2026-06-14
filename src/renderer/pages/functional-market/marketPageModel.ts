import type {
  MarketInstallState,
  MarketItem,
  MarketItemType,
  MarketListResult
} from "@shared/contracts";
import type { TranslateFunction, TranslationKey } from "@shared/i18n";

export type MarketTab = "plugins" | "skills" | "agents" | "sandboxImages" | "pets" | "cli" | "websiteApps";
export type SkillScope = "all" | "cloud" | "local";

export interface MarketTabDefinition {
  id: MarketTab;
  label: string;
  count?: number;
  title: string;
  subtitle: string;
}

export interface MarketViewProps {
  activeTab: MarketTab;
  onTabChange: (tab: MarketTab) => void;
}

export const DEFAULT_MARKET_TAB: MarketTab = "plugins";

const MARKET_TAB_KEYS: Record<MarketTab, { label: TranslationKey; title: TranslationKey; subtitle: TranslationKey }> = {
  plugins: {
    label: "market.tab.plugins.label",
    title: "market.tab.plugins.title",
    subtitle: "market.tab.plugins.subtitle"
  },
  skills: {
    label: "market.tab.skills.label",
    title: "market.tab.skills.title",
    subtitle: "market.tab.skills.subtitle"
  },
  agents: {
    label: "market.tab.agents.label",
    title: "market.tab.agents.title",
    subtitle: "market.tab.agents.subtitle"
  },
  sandboxImages: {
    label: "market.tab.sandboxImages.label",
    title: "market.tab.sandboxImages.title",
    subtitle: "market.tab.sandboxImages.subtitle"
  },
  pets: {
    label: "market.tab.pets.label",
    title: "market.tab.pets.title",
    subtitle: "market.tab.pets.subtitle"
  },
  cli: {
    label: "market.tab.cli.label",
    title: "market.tab.cli.title",
    subtitle: "market.tab.cli.subtitle"
  },
  websiteApps: {
    label: "market.tab.websiteApps.label",
    title: "market.tab.websiteApps.title",
    subtitle: "market.tab.websiteApps.subtitle"
  }
};

export const MARKET_TAB_ITEM_TYPES: Record<MarketTab, MarketItemType> = {
  plugins: "plugin",
  skills: "skill",
  agents: "agent",
  sandboxImages: "sandbox-image",
  pets: "pet",
  cli: "cli",
  websiteApps: "website-app"
};

export function getMarketTabDefinitions(t: TranslateFunction): MarketTabDefinition[] {
  return (Object.keys(MARKET_TAB_KEYS) as MarketTab[]).map((id) => ({
    id,
    label: t(MARKET_TAB_KEYS[id].label),
    title: t(MARKET_TAB_KEYS[id].title),
    subtitle: t(MARKET_TAB_KEYS[id].subtitle)
  }));
}

export function getMarketTabDefinition(tab: MarketTab, t: TranslateFunction) {
  return getMarketTabDefinitions(t).find((definition) => definition.id === tab) ?? getMarketTabDefinitions(t)[0];
}

export function marketStateLabel(state: MarketInstallState, t: TranslateFunction) {
  switch (state) {
    case "installed":
      return t("market.state.installed");
    case "update-available":
      return t("market.state.updateAvailable");
    case "local-imported":
      return t("market.state.localImported");
    case "incompatible":
      return t("market.state.incompatible");
    case "installing":
      return t("market.state.installing");
    case "failed":
      return t("market.state.failed");
    case "not-installed":
    default:
      return t("market.state.notInstalled");
  }
}

export function matchesMarketItemQuery(item: MarketItem, query: string, t: TranslateFunction) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return `${item.name} ${item.type} ${item.description} ${item.version} ${item.tags.join(" ")} ${Object.values(item.metadata ?? {}).join(" ")} ${marketStateLabel(item.state, t)} ${item.imageRef ?? ""} ${item.environmentName ?? ""}`
    .toLowerCase()
    .includes(normalized);
}

export function skillSourceMatches(item: MarketItem, scope: SkillScope) {
  if (scope === "cloud") {
    return item.source === "cloud";
  }
  if (scope === "local") {
    return item.source === "local";
  }
  return true;
}

export function createEmptyMarketResult(): MarketListResult {
  return {
    ok: true,
    sourceUrl: "",
    offline: false,
    message: "",
    items: [],
    pluginMessage: "",
    pluginOffline: false,
    skillMessage: "",
    skillOffline: false,
    agentMessage: "",
    agentOffline: false,
    sandboxMessage: "",
    sandboxOffline: false,
    petMessage: "",
    petOffline: false,
    cliMessage: "",
    cliOffline: false,
    websiteAppMessage: "",
    websiteAppOffline: false
  };
}

export function isValidSkillsApiBaseUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.search &&
      !parsed.hash &&
      (pathname === "/" || pathname === "/api/v1")
    );
  } catch {
    return false;
  }
}
