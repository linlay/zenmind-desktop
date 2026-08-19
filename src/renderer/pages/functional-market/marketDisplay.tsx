import type { MarketItem, ServiceState } from "@shared/contracts";
import type { TranslateFunction } from "@shared/i18n";
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

function frontendModeLabel(mode: ServiceState["frontendMode"], t: TranslateFunction) {
  switch (mode) {
    case "standalone":
      return t("market.frontend.standalone");
    case "embedded":
      return t("market.frontend.embedded");
    case "none":
    default:
      return t("market.frontend.none");
  }
}

export function pluginMetricLabel(service: ServiceState | null, t: TranslateFunction) {
  if (service?.healthMeta.port) {
    return t("market.metric.port", { port: service.healthMeta.port });
  }
  if (service) {
    return frontendModeLabel(service.frontendMode, t);
  }
  return t("market.metric.pendingIntegration");
}

export function marketCardDescription(item: MarketItem) {
  const description = item.description.trim();
  if (description) {
    return description;
  }
  return item.tags.length > 0 ? item.tags.join(" / ") : "";
}

export function pluginDetailChips(item: MarketItem, service: ServiceState | null, t: TranslateFunction) {
  return [
    service ? frontendModeLabel(service.frontendMode, t) : null,
    service?.configFiles.length ? t("market.detail.configCount", { count: service.configFiles.length }) : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

export function skillDetailChips(item: MarketItem) {
  return item.tags.slice(0, 3);
}

export function sandboxDetailChips(item: MarketItem, t: TranslateFunction) {
  return [
    item.imageRef,
    item.containerEngine ? t("market.detail.engine", { engine: item.containerEngine }) : null,
    item.imageSize ? t("market.detail.size", { size: item.imageSize }) : null,
    ...item.tags
  ].filter((chip): chip is string => Boolean(chip)).slice(0, 3);
}

export function sandboxMetricLabel(item: MarketItem, t: TranslateFunction) {
  if (item.imageSize) {
    return item.imageSize;
  }
  if (item.containerEngine) {
    return item.containerEngine;
  }
  return item.imageRef ? t("market.source.localImage") : t("market.metric.imagePackage");
}

export function MarketCardGlyph({ kind }: { kind: "plugin" | "skill" | "sandbox" }) {
  if (kind === "sandbox") {
    return (
      <svg className="market-sandbox-image-symbol" viewBox="0 -960 960 960" aria-hidden="true">
        <path d="M40-120v-80h42l35-525q2-32 25-53.5t55-21.5h245q32 0 55 21.5t25 53.5l36 525h162v-246q-52-14-86-56t-34-98q0-34 13-63.5t36-51.5q-5-11-7-22t-2-23q0-50 35-85t85-35q50 0 85 35t35 85q0 12-2 23t-7 22q23 22 36 51.5t13 63.5q0 56-34 98t-86 56v246h120v80H40Zm123-80h314l-35-520h-32v360h30v80H200v-80h30v-360h-32l-35 520Zm127-160h60v-360h-60v360Zm470-160q33 0 56.5-23.5T840-600q0-28-13-43t-27-29v-88q0-17-11.5-28.5T760-800q-17 0-28.5 11.5T720-760v88q-14 14-27 29t-13 43q0 33 23.5 56.5T760-520Zm0-80Z" />
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
