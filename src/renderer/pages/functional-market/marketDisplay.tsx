import type { MarketItem, ServiceState } from "@shared/contracts";
import type { TranslateFunction } from "@shared/i18n";
import { marketStateLabel } from "./marketPageModel";

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

export function marketSourceLabel(item: MarketItem, t: TranslateFunction) {
  if (item.type === "sandbox-image") {
    return item.containerEngine ? item.containerEngine : t("market.source.localImage");
  }
  return item.marketplaceAvailable || item.source === "cloud"
    ? t("market.source.cloud")
    : t("market.source.localImport");
}

export function marketVersionLabel(item: MarketItem) {
  const rawVersion = String(
    item.state === "update-available" ? item.version : (item.installedVersion ?? item.version ?? "")
  ).trim();
  const version = /^[vV]\d/u.test(rawVersion) ? rawVersion.slice(1) : rawVersion;
  if (!version) {
    return item.type === "sandbox-image" ? "latest" : "";
  }
  return `v${version}`;
}

export function marketItemStateLabel(item: MarketItem, t: TranslateFunction) {
  if (item.type !== "sandbox-image") {
    return marketStateLabel(item.state, t);
  }
  switch (item.state) {
    case "installed":
      return t("market.sandbox.state.available");
    case "installing":
      return t("market.sandbox.state.processing");
    case "failed":
      return t("market.sandbox.state.failed");
    case "not-installed":
      return t("market.sandbox.state.notImported");
    default:
      return marketStateLabel(item.state, t);
  }
}

export function marketCardDescription(item: MarketItem) {
  const description = item.description.trim();
  if (description) {
    return description;
  }
  return item.tags.length > 0 ? item.tags.join(" / ") : "";
}
