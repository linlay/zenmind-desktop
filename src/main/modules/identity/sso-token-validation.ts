import type { FetchLike, OidcConfig } from "./sso-model";
import { getDefaultOidcFetch, fetchJson, buildOidcFetchStage } from "./sso-http";
import { DEFAULT_OIDC_CONFIG, DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG } from "./sso-defaults";
import type { DesktopSsoClaims } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { decodeJsonPart, includesAudience, normalizeStringClaim, keyObjectFromJwk, createClaims } from "./sso-claims";
import { createVerify } from "node:crypto";
import { readJsonPathValue } from "./sso-cookie-token";
import { buildTokenExchangeRequest } from "./sso-authorization";
import type { App } from "electron";
import { beginAuthenticatedSession, completeUserInfoStep, completeAccessTokenStep } from "./sso-session";
import { cloneStatus, desktopSsoRuntimeState } from "./sso-state";

export async function validateIdToken(
  idToken: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG
): Promise<DesktopSsoClaims> {
  const [headerPart, payloadPart, signaturePart] = idToken.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error(t("sso.token.idTokenInvalidFormat"));
  }
  const header = decodeJsonPart(headerPart);
  const payload = decodeJsonPart(payloadPart);
  if (header.alg !== "RS256") {
    throw new Error(t("sso.token.idTokenRs256Only"));
  }
  if (payload.iss !== config.issuer) {
    throw new Error(t("sso.token.issuerMismatch"));
  }
  if (!includesAudience(payload.aud, config.clientId)) {
    throw new Error(t("sso.token.audienceMismatch"));
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error(t("sso.token.expired"));
  }

  let jwksUri = config.jwksUrl?.trim() || "";
  const wellKnownUrl = config.wellKnownUrl?.trim() || "";
  if (wellKnownUrl) {
    const discovery = await fetchJson(
      fetchImpl,
      wellKnownUrl,
      undefined,
      buildOidcFetchStage("OIDC discovery", config)
    ) as { jwks_uri?: unknown };
    jwksUri = normalizeStringClaim(discovery.jwks_uri);
    if (!jwksUri) {
      throw new Error(t("sso.token.wellKnownMissingJwks"));
    }
  }
  if (!jwksUri) {
    throw new Error(t("sso.config.jwksRequired"));
  }
  const jwks = await fetchJson(
    fetchImpl,
    jwksUri,
    undefined,
    buildOidcFetchStage("JWKS fetch", config)
  ) as { keys?: unknown };
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const kid = normalizeStringClaim(header.kid);
  const key = keys.find((candidate) => {
    const record = candidate as Record<string, unknown>;
    return record.kty === "RSA" && (!kid || record.kid === kid);
  }) as Record<string, unknown> | undefined;
  if (!key) {
    throw new Error(t("sso.token.noJwk"));
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  if (!verifier.verify(keyObjectFromJwk(key), Buffer.from(signaturePart, "base64url"))) {
    throw new Error(t("sso.token.signatureFailed"));
  }
  return createClaims(payload);
}

export function mergeDesktopSsoUserInfoClaims(
  claims: DesktopSsoClaims,
  userInfo: unknown,
  config: OidcConfig
) {
  const userInfoConfig = config.userInfo;
  if (!userInfoConfig || !userInfo || typeof userInfo !== "object" || Array.isArray(userInfo)) {
    return claims;
  }
  const userInfoRecord = userInfo as Record<string, unknown>;
  const userInfoSub = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.subPath));
  if (userInfoSub && userInfoSub !== claims.sub) {
    if (userInfoConfig.required) {
      throw new Error(t("sso.token.userInfoSubMismatch"));
    }
    return claims;
  }
  const name = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.namePath));
  const email = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.emailPath));
  const avatarUrl = normalizeStringClaim(readJsonPathValue(userInfoRecord, userInfoConfig.avatarUrlPath));
  return {
    ...claims,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

export function createDesktopSsoCookieUserInfoClaims(userInfo: unknown, config: OidcConfig) {
  const userInfoConfig = config.userInfo;
  if (
    !userInfoConfig ||
    userInfoConfig.authMode !== "cookie" ||
    !userInfo ||
    typeof userInfo !== "object" ||
    Array.isArray(userInfo)
  ) {
    throw new Error(t("sso.token.cookieUserInfoInvalid"));
  }
  const record = userInfo as Record<string, unknown>;
  const sub = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.subPath));
  if (!sub) {
    throw new Error(t("sso.token.cookieUserInfoSubMissing", { path: userInfoConfig.subPath }));
  }
  const name = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.namePath));
  const email = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.emailPath));
  const avatarUrl = normalizeStringClaim(readJsonPathValue(record, userInfoConfig.avatarUrlPath));
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub,
    issuer: config.browserOrigin || new URL(userInfoConfig.url).origin,
    audience: claimsConfig.audience,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  } satisfies DesktopSsoClaims;
}

export async function enrichClaimsWithUserInfo(
  claims: DesktopSsoClaims,
  accessToken: string,
  fetchImpl: FetchLike,
  config: OidcConfig
) {
  const userInfoConfig = config.userInfo;
  if (!userInfoConfig?.enabled || (userInfoConfig.authMode || "bearer") !== "bearer") {
    return claims;
  }
  const token = accessToken.trim();
  if (!token) {
    if (userInfoConfig.required) {
      throw new Error(t("sso.token.userInfoAccessTokenMissing"));
    }
    return claims;
  }
  try {
    const userInfo = await fetchJson(fetchImpl, userInfoConfig.url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    }, buildOidcFetchStage("userinfo fetch", config));
    return mergeDesktopSsoUserInfoClaims(claims, userInfo, config);
  } catch (error) {
    if (userInfoConfig.required) {
      throw error;
    }
    return claims;
  }
}

export async function exchangeCodeForValidatedTokenResponse(
  code: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
) {
  const request = buildTokenExchangeRequest(code, config, options);
  const tokenResponse = await fetchJson(fetchImpl, request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  }, buildOidcFetchStage("token exchange", config)) as { id_token?: unknown; access_token?: unknown };
  const idToken = normalizeStringClaim(tokenResponse.id_token);
  if (!idToken) {
    throw new Error(t("sso.token.responseMissingIdToken"));
  }
  const accessToken = normalizeStringClaim(tokenResponse.access_token);
  const claims = await validateIdToken(idToken, fetchImpl, config);
  return { claims, idToken, accessToken };
}

export async function exchangeCodeForTokenClaims(
  code: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
) {
  const tokenClaims = await exchangeCodeForValidatedTokenResponse(code, fetchImpl, config, options);
  return {
    ...tokenClaims,
    claims: await enrichClaimsWithUserInfo(tokenClaims.claims, tokenClaims.accessToken, fetchImpl, config)
  };
}

export async function exchangeCodeForClaims(
  code: string,
  fetchImpl: FetchLike = getDefaultOidcFetch(),
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
) {
  return (await exchangeCodeForTokenClaims(code, fetchImpl, config, options)).claims;
}

export async function completeValidatedOidcLogin(
  app: App,
  tokenClaims: { claims: DesktopSsoClaims; idToken: string; accessToken: string },
  fetchImpl: FetchLike,
  config: OidcConfig,
  assertCurrent: () => void = () => {}
) {
  assertCurrent();
  beginAuthenticatedSession(app, {
    issuer: tokenClaims.claims.issuer,
    audience: tokenClaims.claims.audience,
    authMode: "oidc"
  }, tokenClaims.idToken);
  completeUserInfoStep(app, tokenClaims.claims, "id_token");
  if (tokenClaims.accessToken) {
    completeAccessTokenStep(app, tokenClaims.accessToken);
  }
  const enrichedClaims = await enrichClaimsWithUserInfo(
    tokenClaims.claims,
    tokenClaims.accessToken,
    fetchImpl,
    config
  );
  assertCurrent();
  if (enrichedClaims !== tokenClaims.claims) {
    completeUserInfoStep(app, enrichedClaims, "userinfo");
  }
  return cloneStatus(desktopSsoRuntimeState.currentStatus);
}
