import { asString } from "./catalog-values";
import { DEFAULT_MARKET_API_BASE_URL, MARKET_API_VERSION_PATH, MARKET_DESKTOP_CATALOG_PATH } from "./market-model";
import { t } from "../../support/i18n/main-i18n";
import type { App } from "electron";
import type { MarketplaceOptions } from "./market-model";
import type { MarketSettings, MarketSettingsInput } from "../../../shared/contracts";
import { readJsonFile, writeJsonFile, marketplaceSettingsPath } from "./market-paths";
import fs from "node:fs";

export function isLoopbackHostname(value: unknown) {
  const hostname = asString(value).trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function normalizeMarketApiBaseUrl(value: unknown) {
  const input = asString(value).trim() || DEFAULT_MARKET_API_BASE_URL;
  if (!input) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(t("market.main.marketApiInvalidUrl"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("market.main.marketApiUnsupportedProtocol"));
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(t("market.main.marketApiSecureUrlRequired"));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(t("market.main.marketApiNoSearch"));
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  if (pathname === MARKET_API_VERSION_PATH || pathname.endsWith(MARKET_API_VERSION_PATH)) {
    return `${parsed.origin}${pathname}`;
  }
  throw new Error(t("market.main.marketApiInvalidPath"));
}

export function catalogUrlFromApiBaseUrl(value: unknown) {
  const baseUrl = normalizeMarketApiBaseUrl(value).replace(/\/+$/u, "");
  return baseUrl ? `${baseUrl}${MARKET_DESKTOP_CATALOG_PATH}` : "";
}

export function getMarketplaceCatalogUrl(app: App, options: MarketplaceOptions = {}) {
  if (options.catalogUrl) {
    return options.catalogUrl;
  }
  if (options.apiBaseUrl !== undefined) {
    return options.marketEnabled === false ? "" : catalogUrlFromApiBaseUrl(options.apiBaseUrl);
  }
  const settings = getMarketSettings(app);
  if (settings.enabled !== true) {
    return "";
  }
  return catalogUrlFromApiBaseUrl(settings.apiBaseUrl);
}

export function getMarketApiBaseUrl(app: App, options: MarketplaceOptions = {}) {
  if (options.apiBaseUrl !== undefined) {
    return options.marketEnabled === false ? "" : normalizeMarketApiBaseUrl(options.apiBaseUrl);
  }
  const settings = getMarketSettings(app);
  return settings.enabled === true ? settings.apiBaseUrl : "";
}

export function normalizeContainerHubBaseUrl(value: unknown) {
  const input = asString(value).trim().replace(/\/+$/u, "");
  if (!input) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(t("market.main.containerHubInvalidUrl"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("market.main.containerHubUnsupportedProtocol"));
  }
  if (parsed.search || parsed.hash) {
    throw new Error(t("market.main.containerHubNoSearch"));
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

export function getMarketSettings(app: App): MarketSettings {
  const saved = readJsonFile<Partial<MarketSettings>>(marketplaceSettingsPath(app), {});
  try {
    const apiBaseUrl = normalizeMarketApiBaseUrl(saved.apiBaseUrl);
    return {
      enabled: saved.enabled === true,
      apiBaseUrl
    };
  } catch {
    return {
      enabled: false,
      apiBaseUrl: DEFAULT_MARKET_API_BASE_URL
    };
  }
}

export function saveMarketSettings(
  app: App,
  input: MarketSettingsInput,
  platform: NodeJS.Platform = process.platform
): MarketSettings {
  const apiBaseUrl = normalizeMarketApiBaseUrl(input.apiBaseUrl);
  const settings = {
    enabled: input.enabled === true,
    apiBaseUrl
  };
  writeJsonFile(marketplaceSettingsPath(app, platform), settings);
  return settings;
}

export function writeMarketSettingsIfAbsent(app: App, input: MarketSettingsInput) {
  const settingsPath = marketplaceSettingsPath(app);
  if (fs.existsSync(settingsPath)) {
    return false;
  }
  saveMarketSettings(app, input);
  return true;
}
