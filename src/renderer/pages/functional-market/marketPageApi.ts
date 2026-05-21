import type { DesktopApi } from "@shared/contracts";

type MarketApi = DesktopApi["market"];
type PluginApi = DesktopApi["plugins"];

const MARKET_API_UNAVAILABLE_MESSAGE = "市场功能已更新，请刷新窗口或重启 Desktop 后再试。";
const PLUGIN_API_UNAVAILABLE_MESSAGE = "插件导入功能已更新，请刷新窗口或重启 Desktop 后再试。";

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

export function createMissingMarketApiError(method: keyof MarketApi) {
  return new Error(`${MARKET_API_UNAVAILABLE_MESSAGE}（缺少 market.${method}）`);
}

export function createMissingPluginApiError(method: keyof PluginApi) {
  return new Error(`${PLUGIN_API_UNAVAILABLE_MESSAGE}（缺少 plugins.${method}）`);
}

export function normalizeError(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
