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

import { CALLBACK_ORIGIN, DEFAULT_GOOGLE_SCOPE, DEFAULT_OIDC_CONFIG, DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS, DesktopSsoAvatarCacheConfig, DesktopSsoSessionMetadata, FetchResponseLike, OidcConfig, RETURN_TO_APP_PATH, cloneStatus, createAuthenticatedStatus, createCompletedSteps, createFailedStatus, createSignedOutStatus, desktopSsoRuntimeState, getCompletedDesktopSsoMessage, getDesktopSsoUserInfoFilePath, getSessionPath, removeLegacyDesktopSsoSiteTokenFile, setCurrentStatus } from "./oidc-sso.part-1";

import { DesktopSsoUserInfoSource, loadDesktopSsoConfig } from "./oidc-sso.part-2";


export function saveSession(
  app: App,
  status: DesktopSsoStatus,
  _idToken = "",
  metadata: DesktopSsoSessionMetadata = {}
) {
  fs.mkdirSync(path.dirname(getSessionPath(app)), { recursive: true });
  fs.writeFileSync(getSessionPath(app), JSON.stringify({
    schemaVersion: 2,
    authenticated: status.authenticated,
    issuer: metadata.issuer || status.user?.issuer || "",
    audience: metadata.audience || status.user?.audience || "",
    authMode: metadata.authMode || "oidc",
    message: status.message,
    updatedAt: status.updatedAt
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function persistCurrentSessionStatus() {
  if (!desktopSsoRuntimeState.currentSessionApp || !desktopSsoRuntimeState.currentSessionMetadata || !desktopSsoRuntimeState.currentStatus.authenticated) {
    return;
  }
  saveSession(desktopSsoRuntimeState.currentSessionApp, desktopSsoRuntimeState.currentStatus, desktopSsoRuntimeState.currentIdToken, desktopSsoRuntimeState.currentSessionMetadata);
}

export function saveUserInfoFile(
  app: Pick<App, "getPath">,
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource = "sso"
) {
  const filePath = getDesktopSsoUserInfoFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 2,
    ...user,
    updatedAt: new Date().toISOString(),
    source
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function removeUserInfoFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(getDesktopSsoUserInfoFilePath(app), { force: true });
  } catch {
    // Userinfo cleanup is best effort; local Desktop auth state is already cleared.
  }
}

export function saveAccessTokenFile(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return;
  }
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the publish failure; a same-directory temp file is never authoritative.
    }
    throw error;
  }
}

export function removeAccessTokenFile(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  try {
    fs.rmSync(filePath, { force: true });
    if (fs.existsSync(filePath)) {
      return new Error(`access token file still exists after removal: ${filePath}`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function readUserInfoFile(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoUserInfoFilePath(app);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopSsoClaims>;
    return typeof parsed.sub === "string" && parsed.sub.trim()
      ? parsed as DesktopSsoClaims
      : null;
  } catch {
    return null;
  }
}

export function isDesktopSsoAvatarSourceTrusted(config: DesktopSsoAvatarCacheConfig, sourceUrl: string) {
  try {
    return new URL(sourceUrl).origin === config.trustedOrigin;
  } catch {
    return false;
  }
}

export function desktopSsoAvatarVersion(user: DesktopSsoClaims) {
  const sourceUrl = user.avatarUrl?.trim() || "";
  return createHash("sha256")
    .update(`${user.sub.trim()}\x00${sourceUrl}`)
    .digest("hex")
    .slice(0, 24);
}

export function withoutAvatarUrl(user: DesktopSsoClaims): DesktopSsoClaims {
  const { avatarUrl: _avatarUrl, ...rest } = user;
  return rest;
}

export function presentDesktopSsoUser(app: Pick<App, "getPath">, user: DesktopSsoClaims | null) {
  if (!user) {
    return null;
  }
  const config = getDesktopSsoAvatarCacheConfig(app);
  if (!config) {
    return { ...user };
  }
  const sourceUrl = user.avatarUrl?.trim() || "";
  if (!sourceUrl || !isDesktopSsoAvatarSourceTrusted(config, sourceUrl)) {
    return withoutAvatarUrl(user);
  }
  return {
    ...user,
    avatarUrl: buildDesktopSsoAvatarUrl(desktopSsoAvatarVersion(user))
  };
}

export function persistedDesktopSsoUser(
  app: Pick<App, "getPath">,
  user: DesktopSsoClaims
): DesktopSsoClaims {
  const avatarUrl = user.avatarUrl?.trim() || "";
  if (!avatarUrl.startsWith(`${DESKTOP_SSO_AVATAR_PROTOCOL}:`)) {
    return user;
  }
  const existing = readUserInfoFile(app);
  return existing?.avatarUrl
    ? { ...user, avatarUrl: existing.avatarUrl }
    : withoutAvatarUrl(user);
}

export function readDesktopSsoAccessToken(app: Pick<App, "getPath">) {
  const filePath = getDesktopSsoAccessTokenFilePath(app);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function readDesktopSsoAccessTokenUser(app: Pick<App, "getPath">): DesktopSsoClaims | null {
  const payload = getJwtPayload(readDesktopSsoAccessToken(app));
  const sub = normalizeStringClaim(payload.sub);
  const expiresAt = typeof payload.exp === "number" ? payload.exp : Number.NaN;
  if (!sub || !Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) {
    return null;
  }
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  return {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud),
    ...(name ? { name } : {}),
    ...(email ? { email } : {})
  };
}

export function desktopSsoAccessTokenNeedsRefresh(
  app: Pick<App, "getPath">,
  minValidityMs = DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS
) {
  const token = desktopSsoRuntimeState.currentAccessToken || readDesktopSsoAccessToken(app);
  if (!token) {
    return true;
  }
  const expirationClaim = getJwtPayload(token).exp;
  const expiresAtSeconds = typeof expirationClaim === "number" ? expirationClaim : Number.NaN;
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= 0) {
    return true;
  }
  return expiresAtSeconds * 1000 <= Date.now() + Math.max(0, minValidityMs);
}

export function loadSession(app: App) {
  removeLegacyDesktopSsoSiteTokenFile(app);
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  desktopSsoRuntimeState.currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
  const filePath = getSessionPath(app);
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopSsoStatus> & {
      schemaVersion?: unknown;
      issuer?: unknown;
      audience?: unknown;
      authMode?: unknown;
      idToken?: unknown;
    };
    if (parsed.authenticated) {
      const separateUser = readUserInfoFile(app);
      const legacyUser = parsed.user?.sub ? parsed.user : null;
      const user = separateUser || legacyUser;
      const sessionIssuer = typeof parsed.issuer === "string" ? parsed.issuer.trim() : "";
      const userMatchesSession = !user || !sessionIssuer || !user.issuer || user.issuer === sessionIssuer;
      const restoredUser = presentDesktopSsoUser(app, userMatchesSession ? user : null);
      desktopSsoRuntimeState.currentAccessToken = readDesktopSsoAccessToken(app);
      const completedSteps = createCompletedSteps({
        session: true,
        userInfo: Boolean(restoredUser),
        accessToken: Boolean(desktopSsoRuntimeState.currentAccessToken)
      });
      desktopSsoRuntimeState.currentStatus = createAuthenticatedStatus(restoredUser, completedSteps, {
        message: getCompletedDesktopSsoMessage(completedSteps)
      });
      desktopSsoRuntimeState.currentStatus.updatedAt = typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString();
      desktopSsoRuntimeState.currentIdToken = typeof parsed.idToken === "string" ? parsed.idToken.trim() : "";
      desktopSsoRuntimeState.currentSessionAuthMode =
        parsed.authMode === "oidc" ||
        parsed.authMode === "browser-cookie" ||
        parsed.authMode === "server"
          ? parsed.authMode
          : desktopSsoRuntimeState.currentIdToken
            ? "oidc"
            : null;
      desktopSsoRuntimeState.currentSessionApp = app;
      desktopSsoRuntimeState.currentSessionMetadata = {
        issuer: sessionIssuer,
        audience: typeof parsed.audience === "string" ? parsed.audience.trim() : "",
        authMode: desktopSsoRuntimeState.currentSessionAuthMode || undefined
      };
    }
  } catch {
    desktopSsoRuntimeState.currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  }
}

export function beginAuthenticatedSession(
  app: App,
  metadata: Required<Pick<DesktopSsoSessionMetadata, "issuer" | "audience" | "authMode">>,
  idToken = ""
) {
  const status = createAuthenticatedStatus(null, createCompletedSteps({ session: true }), {
    pending: desktopSsoRuntimeState.currentStatus.pending,
    message: desktopSsoRuntimeState.currentStatus.pending ? t("sso.completingLogin") : t("sso.completedWithoutUserInfo")
  });
  saveSession(app, status, idToken, metadata);
  clearCachedDesktopSsoAvatar(app);
  removeUserInfoFile(app);
  removeAccessTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentIdToken = idToken.trim();
  desktopSsoRuntimeState.currentSessionAuthMode = metadata.authMode;
  desktopSsoRuntimeState.currentSessionApp = app;
  desktopSsoRuntimeState.currentSessionMetadata = { ...metadata };
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  setCurrentStatus(status);
  return cloneStatus(status);
}

export function completeUserInfoStep(
  app: App,
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource
) {
  if (!desktopSsoRuntimeState.currentStatus.authenticated || !desktopSsoRuntimeState.currentStatus.completedSteps.session) {
    throw new Error(t("sso.sessionRequiredForUserInfo"));
  }
  const sub = user.sub.trim();
  const normalizedUser: DesktopSsoClaims = {
    ...persistedDesktopSsoUser(app, user),
    sub,
    name: user.name?.trim() || sub
  };
  saveUserInfoFile(app, normalizedUser, source);
  const completedSteps = createCompletedSteps({
    ...desktopSsoRuntimeState.currentStatus.completedSteps,
    session: true,
    userInfo: true
  });
  const status = createAuthenticatedStatus(presentDesktopSsoUser(app, normalizedUser), completedSteps, {
    pending: desktopSsoRuntimeState.currentStatus.pending,
    message: desktopSsoRuntimeState.currentStatus.pending
      ? t("sso.completingLogin")
      : getCompletedDesktopSsoMessage(completedSteps)
  });
  setCurrentStatus(status);
  persistCurrentSessionStatus();
  return cloneStatus(status);
}

export function completeAccessTokenStep(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return cloneStatus(desktopSsoRuntimeState.currentStatus);
  }
  saveAccessTokenFile(app, token);
  desktopSsoRuntimeState.currentAccessToken = token;
  if (desktopSsoRuntimeState.currentStatus.authenticated && desktopSsoRuntimeState.currentStatus.completedSteps.session) {
    const completedSteps = createCompletedSteps({
      ...desktopSsoRuntimeState.currentStatus.completedSteps,
      session: true,
      accessToken: true
    });
    const status = createAuthenticatedStatus(desktopSsoRuntimeState.currentStatus.user, completedSteps, {
      pending: desktopSsoRuntimeState.currentStatus.pending,
      message: desktopSsoRuntimeState.currentStatus.pending
        ? t("sso.completingLogin")
        : getCompletedDesktopSsoMessage(completedSteps)
    });
    setCurrentStatus(status);
  }
  return cloneStatus(desktopSsoRuntimeState.currentStatus);
}

export function failDesktopSsoStep(message: string): DesktopSsoStatus {
  if (!desktopSsoRuntimeState.currentStatus.authenticated || !desktopSsoRuntimeState.currentStatus.completedSteps.session) {
    return failDesktopSsoFlow(message);
  }
  return finalizeDesktopSsoLoginAttempt(message);
}

export function finalizeDesktopSsoLoginAttempt(
  errors: string | string[] = []
): DesktopSsoStatus {
  const messages = (Array.isArray(errors) ? errors : [errors])
    .map((message) => message.trim())
    .filter(Boolean);
  desktopSsoRuntimeState.pendingLogin = null;
  if (!desktopSsoRuntimeState.currentStatus.authenticated || !desktopSsoRuntimeState.currentStatus.completedSteps.session) {
    return failDesktopSsoFlow(messages.join("; ") || t("sso.loginFailed"));
  }
  const status = createAuthenticatedStatus(desktopSsoRuntimeState.currentStatus.user, desktopSsoRuntimeState.currentStatus.completedSteps, {
    message: getCompletedDesktopSsoMessage(desktopSsoRuntimeState.currentStatus.completedSteps, messages.length > 0),
    ...(messages.length > 0 ? { error: messages.join("; ") } : {})
  });
  setCurrentStatus(status);
  persistCurrentSessionStatus();
  return cloneStatus(status);
}

export function clearSession(app: App) {
  desktopSsoRuntimeState.pendingLogin = null;
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  const accessTokenRemovalError = removeAccessTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  removeUserInfoFile(app);
  clearCachedDesktopSsoAvatar(app);
  const filePath = getSessionPath(app);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Session cleanup is best effort; the in-memory state is authoritative for this run.
  }
  return accessTokenRemovalError;
}

export function readFetchErrorStatus(response: FetchResponseLike) {
  const status = typeof response.status === "number" ? response.status : 0;
  const statusText = typeof response.statusText === "string" ? response.statusText : "";
  return [status, statusText].filter(Boolean).join(" ") || "request failed";
}

export async function readFetchErrorBody(response: FetchResponseLike) {
  if (typeof response.text !== "function") {
    return "";
  }
  try {
    return (await response.text()).trim().slice(0, 300);
  } catch {
    return "";
  }
}

export function decodeJsonPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function normalizeStringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function normalizeAudience(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string") ?? "";
  }
  return "";
}

export const DESKTOP_SSO_AVATAR_CLAIM_KEYS = ["avatarUrl", "picture", "avatar_url", "avatar"] as const;

export function normalizeDesktopSsoAvatarUrlClaim(payload: Record<string, unknown>) {
  for (const key of DESKTOP_SSO_AVATAR_CLAIM_KEYS) {
    const avatarUrl = normalizeStringClaim(payload[key]);
    if (avatarUrl) {
      return avatarUrl;
    }
  }
  return "";
}

export function includesAudience(value: unknown, expected: string) {
  if (typeof value === "string") {
    return value === expected;
  }
  return Array.isArray(value) && value.includes(expected);
}

export function createClaims(payload: Record<string, unknown>): DesktopSsoClaims {
  const sub = normalizeStringClaim(payload.sub);
  if (!sub) {
    throw new Error(t("sso.token.idTokenMissingSub"));
  }
  const claims: DesktopSsoClaims = {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud)
  };
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  const avatarUrl = normalizeDesktopSsoAvatarUrlClaim(payload);
  if (name) {
    claims.name = name;
  }
  if (email) {
    claims.email = email;
  }
  if (avatarUrl) {
    claims.avatarUrl = avatarUrl;
  }
  return claims;
}

export function keyObjectFromJwk(jwk: Record<string, unknown>): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

export function renderCallbackHtml(title: string, message: string, options: {
  actionHref?: string;
  actionLabel?: string;
} = {}) {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  const actionHref = options.actionHref?.trim() || "";
  const actionLabel = options.actionLabel?.trim() || "";
  const actionHtml = actionHref && actionLabel
    ? `<a class="primary-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #162033; }
    main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid #d9e2ef; border-radius: 16px; background: #fff; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12); }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.25; }
    p { margin: 0; font-size: 15px; line-height: 1.7; color: #44546a; }
    .primary-action { display: inline-flex; align-items: center; justify-content: center; margin-top: 24px; min-height: 42px; padding: 0 18px; border-radius: 8px; background: #1f5eff; color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; box-shadow: 0 10px 22px rgba(31, 94, 255, 0.24); }
    .primary-action:focus-visible { outline: 3px solid rgba(31, 94, 255, 0.28); outline-offset: 3px; }
    .primary-action:hover { background: #174edb; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    ${actionHtml}
  </main>
</body>
</html>`;
}

export function buildReturnToAppUrl(origin: string) {
  return `${origin}${RETURN_TO_APP_PATH}`;
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function writeHtmlResponse(response: http.ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

export function createPkceCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

export function createPkceCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(
  state: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeChallenge?: string;
  } = {}
) {
  if (config.loginUrl) {
    return buildConfiguredLoginUrl(state, config.loginUrl, config.appendLoginState);
  }
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri || config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scope || DEFAULT_GOOGLE_SCOPE);
  if (options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const prompt = config.prompt?.trim();
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  return url.toString();
}

export function buildServerBrokerAuthorizeUrl(state: string, callbackUrl: string, config: OidcConfig) {
  if (!config.serverAuthorizeUrl) {
    throw new Error(t("sso.config.serverAuthorizeRequired"));
  }
  const url = new URL(config.serverAuthorizeUrl);
  url.searchParams.set("callback", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildConfiguredLoginUrl(state: string, loginUrl: string, appendState = true) {
  if (!appendState) {
    return new URL(loginUrl).toString();
  }
  const url = new URL(loginUrl);
  if (url.hash) {
    const hashValue = url.hash.slice(1);
    const queryStartIndex = hashValue.indexOf("?");
    const hashPath = queryStartIndex >= 0 ? hashValue.slice(0, queryStartIndex) : hashValue;
    const hashQuery = queryStartIndex >= 0 ? hashValue.slice(queryStartIndex + 1) : "";
    const hashParams = new URLSearchParams(hashQuery);
    hashParams.set("state", state);
    url.hash = `${hashPath}?${hashParams.toString()}`;
    return url.toString();
  }
  url.searchParams.set("state", state);
  return url.toString();
}

export function getDesktopSsoProxyTargetOrigin(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return new URL(config.authorizeUrl).origin;
}

export function getJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) return {};
  try {
    return decodeJsonPart(payloadPart);
  } catch {
    return {};
  }
}

export function getDesktopSsoAvatarCacheConfig(app: Pick<App, "getPath">) {
  const configResult = loadDesktopSsoConfig(app);
  if (!configResult.configured || configResult.error || !configResult.config?.avatarCache) {
    return null;
  }
  return { ...configResult.config.avatarCache };
}

export function failDesktopSsoFlow(message: string): DesktopSsoStatus {
  desktopSsoRuntimeState.pendingLogin = null;
  if (
    desktopSsoRuntimeState.currentStatus.authenticated &&
    desktopSsoRuntimeState.currentStatus.pending &&
    desktopSsoRuntimeState.currentStatus.completedSteps.session
  ) {
    const status = createAuthenticatedStatus(
      desktopSsoRuntimeState.currentStatus.user,
      desktopSsoRuntimeState.currentStatus.completedSteps,
      {
        message: getCompletedDesktopSsoMessage(
          desktopSsoRuntimeState.currentStatus.completedSteps,
          true
        ),
        error: message
      }
    );
    setCurrentStatus(status);
    return cloneStatus(status);
  }
  desktopSsoRuntimeState.currentAccessToken = "";
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
  if (!desktopSsoRuntimeState.unverifiedCookieSessionCandidate) {
    desktopSsoRuntimeState.loadedSessionPath = "";
  }
  const status = createFailedStatus(message);
  setCurrentStatus(status);
  return cloneStatus(status);
}

export function buildDesktopSsoProxyUrl(value: string) {
  const targetUrl = new URL(value);
  return `${CALLBACK_ORIGIN}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
}

export function rewriteDesktopSsoProxyLocation(
  location: string,
  upstreamRequestUrl: URL,
  config: OidcConfig = DEFAULT_OIDC_CONFIG
) {
  const resolvedLocation = new URL(location, upstreamRequestUrl);
  if (resolvedLocation.origin === CALLBACK_ORIGIN) {
    return resolvedLocation.toString();
  }
  if (resolvedLocation.origin === getDesktopSsoProxyTargetOrigin(config)) {
    return buildDesktopSsoProxyUrl(resolvedLocation.toString());
  }
  return resolvedLocation.toString();
}

export function splitDesktopSsoProxySetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getDesktopSsoProxySetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoProxySetCookieHeader(setCookieHeader) : [];
}

export function rewriteDesktopSsoProxySetCookieHeader(header: string) {
  const [nameValuePair, ...attributes] = header.split(";");
  const rewrittenAttributes: string[] = [];
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }
    const separatorIndex = attribute.indexOf("=");
    const attributeName = (separatorIndex >= 0 ? attribute.slice(0, separatorIndex) : attribute)
      .trim()
      .toLowerCase();
    const attributeValue = separatorIndex >= 0 ? attribute.slice(separatorIndex + 1).trim() : "";
    if (attributeName === "domain" || attributeName === "secure") {
      continue;
    }
    if (attributeName === "samesite" && attributeValue.toLowerCase() === "none") {
      rewrittenAttributes.push("SameSite=Lax");
      continue;
    }
    rewrittenAttributes.push(attribute);
  }
  return [nameValuePair.trim(), ...rewrittenAttributes].filter(Boolean).join("; ");
}

export function getDesktopSsoBrowserCookieOrigins(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const origins = new Set<string>();
  origins.add(getDesktopSsoProxyTargetOrigin(config));
  if (config.loginUrl) {
    origins.add(new URL(config.loginUrl).origin);
  }
  if (config.browserOrigin) {
    origins.add(config.browserOrigin);
  }
  if (config.cookieAccessTokenExchange) {
    origins.add(new URL(config.cookieAccessTokenExchange.url).origin);
  }
  if (config.browserSession) {
    origins.add(new URL(config.browserSession.url).origin);
  }
  if (config.userInfo?.authMode === "cookie") {
    origins.add(new URL(config.userInfo.url).origin);
  }
  return [...origins];
}
