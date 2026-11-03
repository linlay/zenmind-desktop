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
    case "skin":
      return "skins";
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
  const scope = options.linkSource;
  if (scope) {
    const target = new URL(url);
    const base = new URL(scope.base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname + "/") ||
        target.username || target.password) throw new Error("Market request left the linked API");
    assertMarketLinkViewer(app, options);
    if (!scope.trusted || !scope.viewer) {
      const response = await resolveMarketFetchImpl(options.fetchImpl)(url, {
        method: init.method, signal: init.signal, cache: "no-store", credentials: "omit", redirect: "error",
      });
      assertMarketLinkViewer(app, options);
      if (response.status === 401 || response.status === 403) {
        throw new Error(t(scope.trusted ? "market.main.marketAuthRequired" : "market.main.linkSourceAuthRequired"));
      }
      if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
      return response;
    }
  }
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  const send = (bearerToken: string) => {
    assertMarketLinkViewer(app, options);
    if (scope && !bearerToken) throw new Error(t("market.main.marketAuthRequired"));
    return fetchImpl(url, {
      ...init,
      credentials: "include",
      redirect: "error",
      headers: {
        ...getMarketDesktopDeviceHeaders(app),
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
      }
    });
  };
  let token = await issueMarketAccessToken(app, "missing", options);
  let response = await send(token);
  assertMarketLinkViewer(app, options);
  if (response.status === 401 && (options.issueMarketAccessToken || configuredMarketAccessTokenIssuer)) {
    // Identity may have committed its own renewal while this request was in flight. Use that
    // newer token once, but never ask Identity to renew because Market rejected a credential.
    const current = await issueMarketAccessToken(app, "unauthorized", options);
    if (current && current !== token) {
      token = current;
      response = await send(token);
    }
  }
  assertMarketLinkViewer(app, options);
  if (response.status === 401) {
    if (!token) {
      throw new Error(t("market.main.marketAuthRequired"));
    }
    throw new Error(t("market.main.marketCredentialRejected", {
      reason: await readMarketErrorMessage(response, label)
    }));
  }
  if (!response.ok) {
    throw new Error(await readMarketErrorMessage(response, label));
  }
  return response;
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

export function assertMarketLinkViewer(app: App, options: MarketplaceOptions) {
  options.linkSource?.assertCurrent();
  if (options.linkSource && readMarketViewer(app, options) !== options.linkSource.viewer) {
    throw new Error("Market identity changed; reopen the link.");
  }
}

export async function requestVisibleMarketJson(
  app: App, url: string, options: MarketplaceOptions = {}, label = "market visibility request"
) {
  if (options.linkSource) {
    await verifyMarketAuthentication(app, options.linkSource.base, options);
    return requestMarketJson(app, url, options, label, { cache: "no-store" });
  }
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
  if (options.linkSource && (!options.linkSource.trusted || !options.linkSource.viewer)) return;
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
