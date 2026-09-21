import type { App } from "electron";
import type { DesktopSsoStatus, DesktopSsoClaims } from "../../../shared/contracts";
import type { DesktopSsoSessionMetadata, DesktopSsoAvatarCacheConfig } from "./sso-model";
import fs from "node:fs";
import path from "node:path";
import { getSessionPath, getDesktopSsoUserInfoFilePath, removeLegacyDesktopSsoSiteTokenFile } from "./sso-paths";
import {
  desktopSsoRuntimeState,
  createSignedOutStatus,
  createCompletedSteps,
  createAuthenticatedStatus,
  getCompletedDesktopSsoMessage,
  setCurrentStatus,
  cloneStatus,
  createFailedStatus
} from "./sso-state";
import type { DesktopSsoUserInfoSource } from "./sso-config";
import { getDesktopSsoAccessTokenFilePath } from "../../infrastructure/filesystem/user-paths";
import { randomUUID, createHash } from "node:crypto";
import { getDesktopSsoAvatarCacheConfig } from "./sso-config";
import { buildDesktopSsoAvatarUrl, DESKTOP_SSO_AVATAR_PROTOCOL } from "../../../shared/sso-avatar";
import { getJwtPayload, normalizeStringClaim, normalizeAudience } from "./sso-claims";
import { DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS } from "./sso-defaults";
import { t } from "../../support/i18n/main-i18n";
import { clearCachedDesktopSsoAvatar } from "./avatar-storage";
import { closeCallbackServer } from "./callback-lifecycle";

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
  closeCallbackServer();
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
  closeCallbackServer();
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

export function failDesktopSsoFlow(message: string): DesktopSsoStatus {
  closeCallbackServer();
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
