import type {
  OidcConfig,
  CookieAccessTokenExchangeRequest,
  CookieAccessTokenExchangeConfig,
  FetchResponseLike,
  FetchLike
} from "./sso-model";
import {
  DEFAULT_OIDC_CONFIG,
  DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT,
  DEFAULT_COOKIE_ACCESS_TOKEN_PATH,
  DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG
} from "./sso-defaults";
import {
  normalizeStringClaim,
  decodeJsonPart,
  getJwtPayload,
  normalizeDesktopSsoAvatarUrlClaim,
  normalizeAudience
} from "./sso-claims";
import { t } from "../../support/i18n/main-i18n";
import type { DesktopSsoClaims } from "../../../shared/contracts";
import { readFetchErrorBody, readFetchErrorStatus } from "./sso-http";

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
