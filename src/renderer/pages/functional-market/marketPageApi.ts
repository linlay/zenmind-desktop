import type { DesktopApi } from "@shared/contracts";
import type { TranslateFunction } from "@shared/i18n";

type MarketApi = DesktopApi["market"];
type PluginApi = DesktopApi["plugins"];

function getMarketApi(): Partial<MarketApi> | null {
  return ((window.electronAPI as Partial<DesktopApi> | undefined)?.market ?? null) as Partial<MarketApi> | null;
}

function getPluginApi(): Partial<PluginApi> | null {
  return ((window.electronAPI as Partial<DesktopApi> | undefined)?.plugins ?? null) as Partial<PluginApi> | null;
}

export function getMarketMethod<K extends keyof MarketApi>(method: K): MarketApi[K] | null {
  const api = getMarketApi();
  const command = api?.[method];
  return typeof command === "function" ? command as MarketApi[K] : null;
}

export function getPluginMethod<K extends keyof PluginApi>(method: K): PluginApi[K] | null {
  const api = getPluginApi();
  const command = api?.[method];
  return typeof command === "function" ? command as PluginApi[K] : null;
}

export function createMissingMarketApiError(method: keyof MarketApi, t: TranslateFunction) {
  return new Error(t("market.error.marketApiUnavailable", { method }));
}

export function createMissingPluginApiError(method: keyof PluginApi, t: TranslateFunction) {
  return new Error(t("market.error.pluginApiUnavailable", { method }));
}

export function normalizeError(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
