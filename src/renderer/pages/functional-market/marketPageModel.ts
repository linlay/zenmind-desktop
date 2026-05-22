import type {
  MarketInstallState,
  MarketItem,
  MarketListResult
} from "@shared/contracts";

export type MarketTab = "plugins" | "skills" | "sandboxImages";
export type SkillScope = "全部" | "云端" | "本地";

export interface MarketTabDefinition {
  id: MarketTab;
  label: string;
  title: string;
  subtitle: string;
}

export interface MarketViewProps {
  activeTab: MarketTab;
  onTabChange: (tab: MarketTab) => void;
}

export const DEFAULT_MARKET_TAB: MarketTab = "plugins";
export const DEFAULT_SKILLS_API_BASE_URL = "http://127.0.0.1:8080";

export const MARKET_TAB_DEFINITIONS: MarketTabDefinition[] = [
  {
    id: "plugins",
    label: "插件",
    title: "功能市场",
    subtitle: "从云端安装插件，或继续导入本地插件包。"
  },
  {
    id: "skills",
    label: "技能",
    title: "技能市场",
    subtitle: "支持本地导入，或输入 npm/npx 指令下载安装到 Desktop 技能目录。"
  },
  {
    id: "sandboxImages",
    label: "沙箱镜像",
    title: "沙箱镜像市场",
    subtitle: "管理本机 Docker / Podman 中已有的沙箱镜像包。"
  }
];

export function getMarketTabDefinition(tab: MarketTab) {
  return MARKET_TAB_DEFINITIONS.find((definition) => definition.id === tab) ?? MARKET_TAB_DEFINITIONS[0];
}

export function marketStateLabel(state: MarketInstallState) {
  switch (state) {
    case "installed":
      return "已安装";
    case "update-available":
      return "可更新";
    case "local-imported":
      return "已导入";
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

export function matchesMarketItemQuery(item: MarketItem, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return `${item.name} ${item.description} ${item.version} ${item.tags.join(" ")} ${marketStateLabel(item.state)} ${item.imageRef ?? ""} ${item.environmentName ?? ""}`
    .toLowerCase()
    .includes(normalized);
}

export function skillSourceMatches(item: MarketItem, scope: SkillScope) {
  if (scope === "云端") {
    return item.source === "cloud";
  }
  if (scope === "本地") {
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
    sandboxMessage: "",
    sandboxOffline: false
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
