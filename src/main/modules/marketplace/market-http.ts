import type { MarketAccessTokenIssuer, MarketAccessTokenReason, MarketplaceOptions } from "./market-model";
import { Buffer } from "node:buffer";
import type { App } from "electron";
import { getDesktopDeviceInfo, getDesktopSsoStatus } from "../identity";
import type { MarketItemType } from "../../../shared/contracts";
import { asObject, asString } from "./catalog-values";
import { t } from "../../support/i18n/main-i18n";
import { getMarketApiBaseUrl } from "./market-settings";
import { MARKET_AUTH_ME_PATH } from "./market-model";

export let configuredMarketAccessTokenIssuer: MarketAccessTokenIssuer | null = null;

export function configureMarketAccessTokenIssuer(issuer: MarketAccessTokenIssuer | null) {
  configuredMarketAccessTokenIssuer = issuer;
}

export function resolveMarketFetchImpl(fetchImpl?: typeof fetch) {
  return fetchImpl ?? fetch;
}

export function encodeHeaderText(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function sanitizeAsciiHeaderText(value: string) {
  return value.replace(/[^\x20-\x7e]+/gu, "").trim();
}

export function getMarketDesktopDeviceHeaders(app: App) {
  const deviceInfo = getDesktopDeviceInfo(app);
  return {
    "X-Desktop-Device-Id": deviceInfo.deviceId,
    "X-Desktop-Device-Name-B64": encodeHeaderText(deviceInfo.deviceName),
    "X-Desktop-Hostname-B64": encodeHeaderText(deviceInfo.hostname),
    "X-Desktop-Username-B64": encodeHeaderText(deviceInfo.username),
    "X-Desktop-Platform": sanitizeAsciiHeaderText(deviceInfo.platform),
    "X-Desktop-Arch": sanitizeAsciiHeaderText(deviceInfo.arch)
  };
}

export function marketRoute(type: MarketItemType) {
  switch (type) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "agent":
      return "agents";
    case "sandbox-image":
      return "sandbox-images";
    case "pet":
      return "pets";
    case "cli":
      return "cli-tools";
    case "mcp":
      return "mcps";
    case "connector":
      return "connectors";
    case "website-app":
      return "webapps";
    case "software-package":
      return "software-packages";
  }
}

export async function issueMarketAccessToken(
  app: App,
  reason: MarketAccessTokenReason,
  options: MarketplaceOptions
) {
  const issuer = options.issueMarketAccessToken ?? configuredMarketAccessTokenIssuer;
  if (!issuer) {
    return "";
  }
  return String(await issuer(app, reason) || "").trim();
}

export async function readMarketErrorMessage(response: Response, label: string) {
  const fallback = `${label} failed: ${response.status}`;
  try {
    const text = await response.text();
    if (!text.trim()) {
      return fallback;
    }
    const data = JSON.parse(text) as unknown;
    const raw = asObject(data);
    const error = asObject(raw.error);
    return asString(error.message).trim() || asString(raw.message).trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function requestMarket(
  app: App,
  url: string,
  init: RequestInit = {},
  options: MarketplaceOptions = {},
  label = "market request"
) {
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  let token = await issueMarketAccessToken(app, "missing", options);
  for (const reason of ["missing", "unauthorized"] as const) {
    if (reason === "unauthorized") {
      token = await issueMarketAccessToken(app, "unauthorized", options);
    }
    const response = await fetchImpl(url, {
      ...init,
      credentials: "include",
      redirect: "error",
      headers: {
        ...getMarketDesktopDeviceHeaders(app),
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (response.status === 401 && reason === "missing" && (options.issueMarketAccessToken || configuredMarketAccessTokenIssuer)) {
      continue;
    }
    if (response.status === 401) {
      throw new Error(t("market.main.marketAuthRequired"));
    }
    if (!response.ok) {
      throw new Error(await readMarketErrorMessage(response, label));
    }
    return response;
  }
  throw new Error(t("market.main.marketAuthRequired"));
}

export async function requestMarketJson(
  app: App,
  url: string,
  options: MarketplaceOptions = {},
  label = "market request",
  init: RequestInit = {}
) {
  const response = await requestMarket(app, url, init, options, label);
  return response.json() as Promise<unknown>;
}

/** Visibility remains server-authoritative; this key only fences in-flight responses. */
export function readMarketViewer(app: App, options: MarketplaceOptions = {}): string | null {
  if (options.readMarketViewer) return options.readMarketViewer();
  const status = getDesktopSsoStatus();
  return status.authenticated && status.user
    ? JSON.stringify([status.user.issuer, status.user.sub, status.user.audience]) : null;
}

export async function requestVisibleMarketJson(
  app: App, url: string, options: MarketplaceOptions = {}, label = "market visibility request"
) {
  const viewer = readMarketViewer(app, options);
  if (!viewer) {
    const result = await requestPublicMarketJson(app, url, options, label);
    if (readMarketViewer(app, options) !== viewer) throw new Error("Market identity changed; reload the catalog.");
    return result;
  }
  // Credentials go only to the configured API, never a custom public catalog host.
  const base = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  const target = new URL(url);
  const trusted = base && target.origin === new URL(base).origin && target.pathname.startsWith(new URL(base).pathname + "/");
  if (!trusted) throw new Error("Authenticated market request must use the configured API.");
  const guardedOptions: MarketplaceOptions = {
    ...options,
    issueMarketAccessToken: async (targetApp, reason) => {
      if (readMarketViewer(app, options) !== viewer) throw new Error("Market identity changed; reload the catalog.");
      const token = await issueMarketAccessToken(targetApp, reason, options);
      if (!token || readMarketViewer(app, options) !== viewer) throw new Error("Market authentication is unavailable; sign in again.");
      return token;
    }
  };
  // Catalog allows anonymous fallback even for invalid tokens: validate first so
  // an expired login gets the standard refresh/retry instead of silently losing private items.
  await verifyMarketAuthentication(app, base, guardedOptions);
  const result = await requestMarketJson(app, url, guardedOptions, label, { cache: "no-store" });
  if (readMarketViewer(app, options) !== viewer) throw new Error("Market identity changed; reload the catalog.");
  return result;
}

export async function requestPublicMarketJson(
  app: App,
  url: string,
  options: MarketplaceOptions = {},
  label = "market public request"
) {
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  const response = await fetchImpl(url, {
    credentials: "omit",
    cache: "no-store",
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(await readMarketErrorMessage(response, label));
  }
  return response.json() as Promise<unknown>;
}

export async function verifyMarketAuthentication(
  app: App,
  apiBaseUrl: string,
  options: MarketplaceOptions
) {
  const response = asObject(await requestMarketJson(
    app,
    `${apiBaseUrl}${MARKET_AUTH_ME_PATH}`,
    options,
    "market authentication request",
    { cache: "no-store" }
  ));
  const user = asObject(response.user);
  if (!asString(user.id).trim()) {
    throw new Error(t("market.main.marketAuthRequired"));
  }
}

export async function fetchJson(url: string, label = "market request", headers: Record<string, string> = {}) {
  const response = await resolveMarketFetchImpl()(url, {
    credentials: "omit",
    headers,
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}
