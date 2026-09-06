import fs from "node:fs";

import http from "node:http";

import type { AddressInfo } from "node:net";

import path from "node:path";

import {
  createPublicKey,
  createHash,
  createVerify,
  randomBytes,
  randomUUID,
  type KeyObject
} from "node:crypto";

import type { App } from "electron";

import type {
  DesktopSsoClaims,
  DesktopSsoLogoutResult,
  DesktopSsoStartResult,
  DesktopSsoStatus
} from "../../../shared/contracts";

import { BRAND_ID, PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/brand";

import {
  buildDesktopSsoAvatarUrl,
  DESKTOP_SSO_AVATAR_PROTOCOL
} from "../../../shared/sso-avatar";

import {
  getDesktopSsoAccessTokenFilePath,
  getDesktopStateRoot,
  getSecretsRoot
} from "../../infrastructure/filesystem/user-paths";

import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

import { t } from "../../support/i18n/main-i18n";

import { clearCachedDesktopSsoAvatar } from "./avatar-storage";

import { CALLBACK_ORIGIN, CookieAccessTokenExchangeConfig, CookieAccessTokenExchangeRequest, DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT, DEFAULT_COOKIE_ACCESS_TOKEN_PATH, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG, DEFAULT_OIDC_CONFIG, DesktopSsoBrowserCookieDetails, DesktopSsoProxyState, ElectronFetchRuntime, FetchLike, FetchResponseLike, OidcConfig, TokenExchangeRequest, desktopSsoRuntimeState, isGoogleOidcConfig, usedAuthorizationCodes, usedDesktopSsoTickets } from "./oidc-sso.part-1";

import { loadDesktopSsoConfig } from "./oidc-sso.part-2";

import { decodeJsonPart, getJwtPayload, getDesktopSsoBrowserCookieOrigins, getDesktopSsoProxySetCookieHeaders, getDesktopSsoProxyTargetOrigin, normalizeAudience, normalizeDesktopSsoAvatarUrlClaim, normalizeStringClaim, readFetchErrorBody, readFetchErrorStatus, rewriteDesktopSsoProxyLocation, rewriteDesktopSsoProxySetCookieHeader } from "./oidc-sso.part-3";

export function buildDesktopSsoBrowserCookieDetails(
  cookies: Map<string, string>,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): DesktopSsoBrowserCookieDetails[] {
  const origins = getDesktopSsoBrowserCookieOrigins(config);
  const cookieDetails: DesktopSsoBrowserCookieDetails[] = [];
  for (const origin of origins) {
    for (const [name, value] of cookies) {
      cookieDetails.push({
        url: origin,
        name,
        value,
        path: "/",
        secure: origin.startsWith("https:"),
        httpOnly: true,
        sameSite: "lax"
      });
    }
  }
  return cookieDetails;
}

export function getDesktopSsoProxyBrowserCookieDetails() {
  if (!desktopSsoRuntimeState.desktopSsoProxyState) {
    return [];
  }
  return buildDesktopSsoBrowserCookieDetails(desktopSsoRuntimeState.desktopSsoProxyState.cookies, desktopSsoRuntimeState.desktopSsoProxyState.config);
}

export function getDesktopSsoCookieMirrorOrigins(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config) {
    return [];
  }
  return getDesktopSsoBrowserCookieOrigins(configResult.config);
}

export function activateDesktopSsoProxy(config: OidcConfig, options: { resetCookies?: boolean } = {}) {
  const currentTargetOrigin = desktopSsoRuntimeState.desktopSsoProxyState
    ? getDesktopSsoProxyTargetOrigin(desktopSsoRuntimeState.desktopSsoProxyState.config)
    : "";
  const nextTargetOrigin = getDesktopSsoProxyTargetOrigin(config);
  if (!desktopSsoRuntimeState.desktopSsoProxyState || options.resetCookies || currentTargetOrigin !== nextTargetOrigin) {
    desktopSsoRuntimeState.desktopSsoProxyState = {
      config,
      cookies: new Map()
    };
    return desktopSsoRuntimeState.desktopSsoProxyState;
  }
  desktopSsoRuntimeState.desktopSsoProxyState.config = config;
  return desktopSsoRuntimeState.desktopSsoProxyState;
}

export function updateDesktopSsoProxyCookies(proxyState: DesktopSsoProxyState, setCookieHeaders: string[]) {
  for (const header of setCookieHeaders) {
    const [nameValuePair, ...attributes] = header.split(";");
    const separatorIndex = nameValuePair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = nameValuePair.slice(0, separatorIndex).trim();
    const value = nameValuePair.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    let expired = false;
    for (const rawAttribute of attributes) {
      const attribute = rawAttribute.trim();
      const attributeSeparatorIndex = attribute.indexOf("=");
      const attributeName = (attributeSeparatorIndex >= 0
        ? attribute.slice(0, attributeSeparatorIndex)
        : attribute).trim().toLowerCase();
      const attributeValue = attributeSeparatorIndex >= 0
        ? attribute.slice(attributeSeparatorIndex + 1).trim()
        : "";
      if (attributeName === "max-age" && Number.parseInt(attributeValue, 10) <= 0) {
        expired = true;
      } else if (attributeName === "expires") {
        const expiresAt = Date.parse(attributeValue);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          expired = true;
        }
      }
    }
    if (expired) {
      proxyState.cookies.delete(name);
    } else {
      proxyState.cookies.set(name, value);
    }
  }
}

export function mergeDesktopSsoProxyCookies(browserCookieHeader: string | undefined, proxyState: DesktopSsoProxyState) {
  const cookies = new Map<string, string>();
  for (const cookie of (browserCookieHeader ?? "").split(";")) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = cookie.slice(0, separatorIndex).trim();
    const value = cookie.slice(separatorIndex + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  for (const [name, value] of proxyState.cookies) {
    cookies.set(name, value);
  }
  return [...cookies]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function rewriteDesktopSsoProxyHeaderUrl(value: string, config: OidcConfig) {
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  return value
    .replaceAll(CALLBACK_ORIGIN, targetOrigin)
    .replaceAll(CALLBACK_ORIGIN.replace("localhost", "127.0.0.1"), targetOrigin);
}

export function getDesktopSsoProxyRequestHeaders(
  request: http.IncomingMessage,
  upstreamUrl: URL,
  proxyState: DesktopSsoProxyState
) {
  const blockedHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "proxy-connection",
    "upgrade"
  ]);
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (blockedHeaders.has(name) || rawValue === undefined) {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    headers[name] = value;
  }

  headers["accept-encoding"] = "identity";
  if (headers.origin) {
    headers.origin = getDesktopSsoProxyTargetOrigin(proxyState.config);
  }
  if (headers.referer) {
    headers.referer = rewriteDesktopSsoProxyHeaderUrl(headers.referer, proxyState.config);
  }
  const cookieHeader = mergeDesktopSsoProxyCookies(request.headers.cookie, proxyState);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  } else {
    delete headers.cookie;
  }
  return headers;
}

export function readDesktopSsoProxyRequestBody(request: http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function shouldRewriteDesktopSsoProxyBody(contentType: string) {
  return /(?:text|json|javascript|ecmascript|xml|x-www-form-urlencoded)/iu.test(contentType);
}

export function rewriteDesktopSsoProxyBody(body: Buffer, contentType: string, config: OidcConfig) {
  if (!shouldRewriteDesktopSsoProxyBody(contentType)) {
    return body;
  }
  const targetOrigin = getDesktopSsoProxyTargetOrigin(config);
  const httpTargetOrigin = targetOrigin.replace(/^https:/iu, "http:");
  const rewrittenBody = body
    .toString("utf8")
    .replaceAll(targetOrigin, CALLBACK_ORIGIN)
    .replaceAll(httpTargetOrigin, CALLBACK_ORIGIN);
  return Buffer.from(rewrittenBody, "utf8");
}

export async function proxyDesktopSsoRequest(
  proxyState: DesktopSsoProxyState,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL
) {
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, getDesktopSsoProxyTargetOrigin(proxyState.config));
  const method = (request.method || "GET").toUpperCase();
  const requestBodyBuffer = method === "GET" || method === "HEAD"
    ? undefined
    : await readDesktopSsoProxyRequestBody(request);
  const requestBody = requestBodyBuffer
    ? Uint8Array.from(requestBodyBuffer).buffer
    : undefined;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: getDesktopSsoProxyRequestHeaders(request, upstreamUrl, proxyState),
    body: requestBody as BodyInit | undefined,
    redirect: "manual"
  });
  const setCookieHeaders = getDesktopSsoProxySetCookieHeaders(upstreamResponse.headers);
  updateDesktopSsoProxyCookies(proxyState, setCookieHeaders);

  const blockedResponseHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "set-cookie",
    "transfer-encoding"
  ]);
  const responseHeaders: http.OutgoingHttpHeaders = {};
  upstreamResponse.headers.forEach((value, name) => {
    const headerName = name.toLowerCase();
    if (blockedResponseHeaders.has(headerName)) {
      return;
    }
    if (headerName === "location") {
      responseHeaders.location = rewriteDesktopSsoProxyLocation(value, upstreamUrl, proxyState.config);
      return;
    }
    responseHeaders[name] = value;
  });

  const rewrittenCookies = setCookieHeaders
    .map((header) => rewriteDesktopSsoProxySetCookieHeader(header))
    .filter(Boolean);
  if (rewrittenCookies.length > 0) {
    responseHeaders["set-cookie"] = rewrittenCookies;
  }

  const rawBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const body = rewriteDesktopSsoProxyBody(rawBody, upstreamResponse.headers.get("content-type") ?? "", proxyState.config);
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(method === "HEAD" ? undefined : body);
}

export function getIdentityProviderCookieHosts(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const hosts = new Set<string>();
  for (const value of [
    config.issuer,
    config.authorizeUrl,
    config.loginUrl,
    config.tokenUrl,
    config.wellKnownUrl,
    config.logoutUrl,
    config.cookieAccessTokenExchange?.url,
    config.browserSession?.url,
    config.userInfo?.url
  ]) {
    if (!value) {
      continue;
    }
    try {
      const host = new URL(value).hostname.trim().toLowerCase();
      if (host) {
        hosts.add(host);
      }
    } catch {
      // Ignore malformed optional URLs; required URLs fail later when used.
    }
  }
  return [...hosts];
}

export function isDesktopSsoAuthorizeUrl(value: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  try {
    const url = new URL(value);
    const authorizeUrl = new URL(config.authorizeUrl);
    return url.origin === authorizeUrl.origin && url.pathname === authorizeUrl.pathname;
  } catch {
    return false;
  }
}

export function buildTokenExchangeRequest(
  code: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
): TokenExchangeRequest {
  const tokenUrl = new URL(config.tokenUrl);
  if (isGoogleOidcConfig(config)) {
    const bodyParams = new URLSearchParams();
    bodyParams.set("client_id", config.clientId);
    if (config.clientSecret?.trim()) {
      bodyParams.set("client_secret", config.clientSecret.trim());
    }
    bodyParams.set("redirect_uri", options.redirectUri || config.redirectUri);
    bodyParams.set("grant_type", "authorization_code");
    bodyParams.set("code", code);
    if (options.codeVerifier) {
      bodyParams.set("code_verifier", options.codeVerifier);
    }
    return {
      url: tokenUrl.toString(),
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    };
  }
  const bodyParams = new URLSearchParams();
  bodyParams.set("client_id", config.clientId);
  if (config.clientSecret?.trim()) {
    bodyParams.set("client_secret", config.clientSecret.trim());
  }
  bodyParams.set("redirect_uri", options.redirectUri || config.redirectUri);
  bodyParams.set("grant_type", "authorization_code");
  bodyParams.set("code", code);
  if (options.codeVerifier) {
    bodyParams.set("code_verifier", options.codeVerifier);
  }
  return {
    url: tokenUrl.toString(),
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  };
}

export function buildCookieAccessTokenExchangeRequest(
  cookieHeader: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): CookieAccessTokenExchangeRequest | null {
  const exchangeConfig = config.cookieAccessTokenExchange;
  if (!exchangeConfig) {
    return null;
  }
  const headers: Record<string, string> = {
    Accept: DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT,
    ...exchangeConfig.headers
  };
  const normalizedCookieHeader = cookieHeader.trim();
  if (normalizedCookieHeader) {
    headers.Cookie = normalizedCookieHeader;
  }
  return {
    url: exchangeConfig.url,
    method: exchangeConfig.method,
    headers,
    ...(exchangeConfig.body !== undefined ? { body: exchangeConfig.body } : {})
  };
}

export function readJsonPathValue(value: unknown, pathValue: string) {
  let currentValue = value;
  for (const segment of pathValue.split(".")) {
    const key = segment.trim();
    if (!key) {
      return undefined;
    }
    if (!currentValue || typeof currentValue !== "object") {
      return undefined;
    }
    currentValue = (currentValue as Record<string, unknown>)[key];
  }
  return currentValue;
}

export function normalizeCookieAccessToken(value: unknown) {
  const token = normalizeStringClaim(value);
  const bearerMatch = /^Bearer\s+(.+)$/iu.exec(token);
  return (bearerMatch?.[1] || token).trim();
}

export function cookieAccessTokenMatchesIdentity(
  token: string,
  issuer: string,
  audience: string
) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const payload = decodeJsonPart(parts[1]);
    const tokenIssuer = normalizeStringClaim(payload.iss);
    const rawAudience = payload.aud;
    const audiences = Array.isArray(rawAudience)
      ? rawAudience.filter((item): item is string => typeof item === "string")
      : [normalizeStringClaim(rawAudience)].filter(Boolean);
    return tokenIssuer === issuer && audiences.includes(audience);
  } catch {
    return false;
  }
}

export function describeCookieAccessTokenIdentity(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return "";
  }
  try {
    const payload = decodeJsonPart(parts[1]);
    const issuer = normalizeStringClaim(payload.iss);
    const rawAudience = payload.aud;
    const audiences = Array.isArray(rawAudience)
      ? rawAudience.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [normalizeStringClaim(rawAudience)].filter(Boolean);
    if (!issuer && audiences.length === 0) {
      return "";
    }
    return `${issuer || "<missing-issuer>"} -> ${audiences.join(",") || "<missing-audience>"}`;
  } catch {
    return "";
  }
}

export function collectCookieAccessTokenCandidates(
  value: unknown,
  candidates: Set<string>,
  depth = 0
) {
  if (depth > 6 || candidates.size > 64 || value == null) {
    return;
  }
  if (typeof value === "string") {
    const token = normalizeCookieAccessToken(value);
    if (token.split(".").length === 3) {
      candidates.add(token);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) {
      collectCookieAccessTokenCandidates(item, candidates, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>).slice(0, 64)) {
      collectCookieAccessTokenCandidates(item, candidates, depth + 1);
    }
  }
}

export function selectCookieAccessTokenByIdentity(value: unknown, config: CookieAccessTokenExchangeConfig) {
  const issuer = config.accessTokenIssuer || "";
  const audience = config.accessTokenAudience || "";
  const candidates = new Set<string>();
  collectCookieAccessTokenCandidates(value, candidates);
  const matches = [...candidates].filter((token) => cookieAccessTokenMatchesIdentity(token, issuer, audience));
  if (matches.length === 0) {
    const detected = [...new Set([...candidates]
      .map((token) => describeCookieAccessTokenIdentity(token))
      .filter(Boolean))];
    const message = t("sso.token.cookieAccessTokenIdentityNotFound", { issuer, audience });
    throw new Error(detected.length > 0
      ? `${message} ${t("sso.token.cookieAccessTokenIdentitiesDetected", { identities: detected.join("; ") })}`
      : message);
  }
  if (matches.length > 1) {
    throw new Error(t("sso.token.cookieAccessTokenIdentityAmbiguous", { issuer, audience }));
  }
  return matches[0];
}

export function selectSingleCookieAccessTokenForRemoteValidation(value: unknown) {
  const candidates = new Set<string>();
  collectCookieAccessTokenCandidates(value, candidates);
  if (candidates.size === 0) {
    throw new Error(t("sso.token.cookieAccessTokenRemoteMissing"));
  }
  if (candidates.size > 1) {
    throw new Error(t("sso.token.cookieAccessTokenRemoteAmbiguous"));
  }
  return [...candidates][0];
}

export function readCookieAccessTokenFromResponse(value: unknown, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const exchangeConfig = config.cookieAccessTokenExchange;
  if (exchangeConfig?.validationMode === "remote") {
    return selectSingleCookieAccessTokenForRemoteValidation(value);
  }
  if (exchangeConfig?.accessTokenIssuer && exchangeConfig.accessTokenAudience) {
    return selectCookieAccessTokenByIdentity(value, exchangeConfig);
  }
  const rawAccessToken = normalizeCookieAccessToken(value);
  if (rawAccessToken) {
    return rawAccessToken;
  }
  const pathValue = config.cookieAccessTokenExchange?.accessTokenPath || DEFAULT_COOKIE_ACCESS_TOKEN_PATH;
  const accessToken = normalizeCookieAccessToken(readJsonPathValue(value, pathValue));
  if (!accessToken) {
    throw new Error(t("sso.token.cookieAccessTokenMissingPath", { path: pathValue }));
  }
  return accessToken;
}

export function isJsonFetchResponse(response: FetchResponseLike) {
  const contentType = response.headers?.get("content-type")?.toLowerCase() || "";
  return contentType.includes("json");
}

export function createCookieAccessTokenClaims(accessToken: string, config: OidcConfig): DesktopSsoClaims {
  const payload = getJwtPayload(accessToken);
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  const avatarUrl = normalizeDesktopSsoAvatarUrlClaim(payload);
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub: normalizeStringClaim(payload.sub) || claimsConfig.cookieFallbackSub,
    issuer: normalizeStringClaim(payload.iss) || config.browserOrigin || new URL(config.loginUrl || config.authorizeUrl).origin,
    audience: normalizeAudience(payload.aud) || claimsConfig.audience,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

export function urlsMatchOriginAndPath(value: string, expected: string) {
  try {
    const valueUrl = new URL(value);
    const expectedUrl = new URL(expected);
    return valueUrl.origin === expectedUrl.origin && valueUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

export async function exchangeCookieForAccessToken(
  cookieHeader: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
) {
  const request = buildCookieAccessTokenExchangeRequest(cookieHeader, config);
  if (!request) {
    return "";
  }
  if (config.cookieAccessTokenExchange?.csrfUrl) {
    const csrfHeaders: Record<string, string> = { Accept: "application/json" };
    if (cookieHeader.trim()) {
      csrfHeaders.Cookie = cookieHeader.trim();
    }
    const csrfResponse = await fetchImpl(config.cookieAccessTokenExchange.csrfUrl, {
      method: "GET",
      headers: csrfHeaders
    });
    if (!csrfResponse.ok) {
      const detail = await readFetchErrorBody(csrfResponse);
      throw new Error(`OIDC CSRF request failed: ${readFetchErrorStatus(csrfResponse)}${detail ? ` - ${detail}` : ""}`);
    }
    const csrfBody = await csrfResponse.json();
    const csrfToken = normalizeStringClaim(readJsonPathValue(csrfBody, "csrfToken"));
    if (!csrfToken) {
      throw new Error("OIDC CSRF response did not include csrfToken.");
    }
    request.headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  if (!response.ok) {
    const detail = await readFetchErrorBody(response);
    throw new Error(`OIDC request failed: ${readFetchErrorStatus(response)}${detail ? ` - ${detail}` : ""}`);
  }
  if (!isJsonFetchResponse(response) && typeof response.text === "function") {
    return readCookieAccessTokenFromResponse(await response.text(), config);
  }
  return readCookieAccessTokenFromResponse(await response.json(), config);
}

export function normalizeCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedCodes: Set<string> = usedAuthorizationCodes
) {
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!code) {
    throw new Error("missing authorization code");
  }
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  if (usedCodes.has(code)) {
    throw new Error("authorization code has already been used");
  }
  usedCodes.add(code);
  return { code, state };
}

export function normalizeDesktopTicketCallbackRequest(
  requestUrl: URL,
  expectedState: string,
  usedTickets: Set<string> = usedDesktopSsoTickets
) {
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!state || state !== expectedState) {
    throw new Error("state mismatch");
  }
  const error = requestUrl.searchParams.get("error")?.trim() ?? "";
  if (error) {
    throw new Error(error);
  }
  const ticket = requestUrl.searchParams.get("ticket")?.trim() ?? "";
  if (!ticket) {
    throw new Error("missing desktop SSO ticket");
  }
  if (usedTickets.has(ticket)) {
    throw new Error("desktop SSO ticket has already been used");
  }
  usedTickets.add(ticket);
  return { ticket, state };
}

export function createDesktopTicketPlaceholderClaims(config: OidcConfig): DesktopSsoClaims {
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub: claimsConfig.ticketPlaceholderSub,
    issuer: config.webSessionExchange ? new URL(config.webSessionExchange.url).origin : config.serverAuthorizeUrl || "desktop-sso-server",
    audience: claimsConfig.audience
  };
}

export function isDesktopSsoClaimsValue(value: unknown): value is DesktopSsoClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sub === "string" &&
    typeof record.issuer === "string" &&
    typeof record.audience === "string";
}

export function loadElectronFetchRuntime(): ElectronFetchRuntime | null {
  try {
    const runtime = require("electron") as unknown;
    return runtime && typeof runtime === "object" ? runtime as ElectronFetchRuntime : null;
  } catch {
    return null;
  }
}

export function getElectronNetFetch(runtime: ElectronFetchRuntime | null = loadElectronFetchRuntime()): FetchLike | null {
  const net = runtime?.net;
  const netFetch = net?.fetch;
  if (typeof netFetch !== "function") {
    return null;
  }
  return ((url, init) => netFetch.call(net, url, init)) as FetchLike;
}

export function getDefaultOidcFetch(runtime?: ElectronFetchRuntime | null): FetchLike {
  return getElectronNetFetch(runtime === undefined ? loadElectronFetchRuntime() : runtime) ||
    (fetch as unknown as FetchLike);
}

export function describeFetchError(error: unknown) {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      if (cause.message && cause.message !== error.message) {
        parts.push(cause.message);
      }
      const code = (cause as Error & { code?: unknown }).code;
      if (typeof code === "string" && !parts.includes(code)) {
        parts.push(code);
      }
    } else if (typeof cause === "string" && cause && cause !== error.message) {
      parts.push(cause);
    }
  } else if (typeof error === "string") {
    parts.push(error);
  }
  return parts.filter(Boolean).join(" - ") || String(error);
}
