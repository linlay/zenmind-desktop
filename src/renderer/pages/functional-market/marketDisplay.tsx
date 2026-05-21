import type { MarketItem, ServiceState } from "@shared/contracts";
import { marketStateLabel } from "./marketPageModel";

export function getPluginStatusClass(status: ServiceState["status"]) {
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

export function getMarketItemStatusClass(state: MarketItem["state"]) {
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

export function canOpenPlugin(service: ServiceState | null) {
  return Boolean(service && service.frontendMode !== "none" && service.status === "running");
}

export function marketSourceLabel(item: MarketItem) {
  if (item.type === "sandbox-image") {
    return "Container Hub";
  }
  return item.source === "local" ? "本地导入" : "云端市场";
}

export function marketVersionLabel(item: MarketItem) {
  const version = item.installedVersion ?? item.version;
  if (item.type === "sandbox-image") {
    return version || "latest";
  }
  return version.startsWith("v") ? version : `v${version}`;
}

export function marketItemStateLabel(item: MarketItem) {
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

export function pluginMetricLabel(service: ServiceState | null) {
  if (service?.healthMeta.port) {
    return `${service.healthMeta.port} 端口`;
  }
  if (service) {
    return frontendModeLabel(service.frontendMode);
  }
  return "待接入";
}

export function marketCardDescription(item: MarketItem) {
  const description = item.description.trim();
  if (description) {
    return description;
  }
  return item.tags.length > 0 ? item.tags.join(" / ") : "";
}

export function pluginDetailChips(item: MarketItem, service: ServiceState | null) {
  return [
    service ? frontendModeLabel(service.frontendMode) : null,
    service?.configFiles.length ? `${service.configFiles.length} 个配置` : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

export function skillDetailChips(item: MarketItem) {
  return item.tags.slice(0, 3);
}

export function sandboxDetailChips(item: MarketItem) {
  return [
    item.imageRef,
    item.buildTargetCount ? `${item.buildTargetCount} 个构建目标` : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

export function sandboxMetricLabel(item: MarketItem) {
  if (item.buildStatus) {
    return item.buildStatus;
  }
  return item.imageRef ? "镜像环境" : "environment";
}

export function MarketCardGlyph({ kind }: { kind: "plugin" | "skill" | "sandbox" }) {
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
