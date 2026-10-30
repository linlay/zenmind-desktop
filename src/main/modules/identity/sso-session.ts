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
import { getDesktopSsoIdTokenFilePath } from "../../infrastructure/filesystem/user-paths";
import { randomUUID, createHash } from "node:crypto";
import { getDesktopSsoAvatarCacheConfig } from "./sso-config";
import { buildDesktopSsoAvatarUrl, DESKTOP_SSO_AVATAR_PROTOCOL } from "../../../shared/sso-avatar";
import { getJwtPayload, normalizeStringClaim, normalizeAudience } from "./sso-claims";
import { DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS } from "./sso-defaults";
import { t } from "../../support/i18n/main-i18n";
import { clearSsoCredentials } from "./sso-credentials";
import { clearCachedDesktopSsoAvatar } from "./avatar-storage";
import { closeCallbackServer } from "./callback-lifecycle";

function serializeSession(
  status: DesktopSsoStatus,
  metadata: DesktopSsoSessionMetadata = {}
) {
  return JSON.stringify({
    schemaVersion: 2,
    authenticated: status.authenticated,
    issuer: metadata.issuer || status.user?.issuer || "",
    audience: metadata.audience || status.user?.audience || "",
    authMode: metadata.authMode || "oidc",
    message: status.message,
    updatedAt: status.updatedAt
  }, null, 2) + "\n";
}

export function saveSession(
  app: App,
  status: DesktopSsoStatus,
  _idToken = "",
  metadata: DesktopSsoSessionMetadata = {}
) {
  fs.mkdirSync(path.dirname(getSessionPath(app)), { recursive: true });
  fs.writeFileSync(getSessionPath(app), serializeSession(status, metadata), { encoding: "utf8", mode: 0o600 });
}

export function persistCurrentSessionStatus() {
  if (!desktopSsoRuntimeState.currentSessionApp || !desktopSsoRuntimeState.currentSessionMetadata || !desktopSsoRuntimeState.currentStatus.authenticated) {
    return;
  }
  saveSession(desktopSsoRuntimeState.currentSessionApp, desktopSsoRuntimeState.currentStatus, desktopSsoRuntimeState.currentIdToken, desktopSsoRuntimeState.currentSessionMetadata);
}

function serializeUserInfo(
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource = "sso"
) {
  return `${JSON.stringify({
    schemaVersion: 2,
    ...user,
    updatedAt: new Date().toISOString(),
    source
  }, null, 2)}\n`;
}

export function saveUserInfoFile(
  app: Pick<App, "getPath">,
  user: DesktopSsoClaims,
  source: DesktopSsoUserInfoSource = "sso"
) {
  const filePath = getDesktopSsoUserInfoFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeUserInfo(user, source), { encoding: "utf8", mode: 0o600 });
}

export function removeUserInfoFile(app: Pick<App, "getPath">) {
  try {
    fs.rmSync(getDesktopSsoUserInfoFilePath(app), { force: true });
  } catch {
    // Userinfo cleanup is best effort; local Desktop auth state is already cleared.
  }
}

export function saveIdTokenFile(app: Pick<App, "getPath">, accessToken: string) {
  const token = accessToken.trim();
  if (!token) {
    return;
  }
  const filePath = getDesktopSsoIdTokenFilePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    fs.rmSync(path.join(path.dirname(filePath), "sso-access-token.txt"), { force: true });
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the publish failure; a same-directory temp file is never authoritative.
    }
    throw error;
  }
}

export function removeIdTokenFile(app: Pick<App, "getPath">, includeLegacy = true) {
  const filePath = getDesktopSsoIdTokenFilePath(app);
  try {
    fs.rmSync(filePath, { force: true });
    if (includeLegacy) fs.rmSync(path.join(path.dirname(filePath), "sso-access-token.txt"), { force: true });
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

export function readDesktopSsoIdToken(app: Pick<App, "getPath">) {
  let filePath = getDesktopSsoIdTokenFilePath(app);
  if (!fs.existsSync(filePath)) filePath = path.join(path.dirname(filePath), "sso-access-token.txt");
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function readDesktopSsoIdTokenUser(app: Pick<App, "getPath">): DesktopSsoClaims | null {
  const payload = getJwtPayload(readDesktopSsoIdToken(app));
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

export function desktopSsoIdTokenNeedsRefresh(
  app: Pick<App, "getPath">,
  minValidityMs = DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS
) {
  const token = desktopSsoRuntimeState.currentBusinessToken || readDesktopSsoIdToken(app);
  if (!token) {
    return true;
  }
  const payload = getJwtPayload(token);
  const expirationClaim = payload.exp;
  const expiresAtSeconds = typeof expirationClaim === "number" ? expirationClaim : Number.NaN;
  if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= 0) {
    return true;
  }
  const lifetime = typeof payload.iat === "number" && payload.iat < expiresAtSeconds
    ? (expiresAtSeconds - payload.iat) * 1000 : undefined;
  const skew = lifetime === undefined ? minValidityMs : Math.min(minValidityMs, lifetime * 0.2);
  return expiresAtSeconds * 1000 <= Date.now() + Math.max(0, skew);
}

export function loadSession(app: App) {
  removeLegacyDesktopSsoSiteTokenFile(app);
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  desktopSsoRuntimeState.currentStatus = createSignedOutStatus(t("sso.notSignedIn"));
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentBusinessToken = "";
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
      desktopSsoRuntimeState.currentBusinessToken = readDesktopSsoIdToken(app);
      const completedSteps = createCompletedSteps({
        session: true,
        userInfo: Boolean(restoredUser),
        accessToken: Boolean(desktopSsoRuntimeState.currentBusinessToken)
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
  removeIdTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  desktopSsoRuntimeState.currentBusinessToken = "";
  desktopSsoRuntimeState.currentIdToken = idToken.trim();
  desktopSsoRuntimeState.currentSessionAuthMode = metadata.authMode;
  desktopSsoRuntimeState.currentSessionApp = app;
  desktopSsoRuntimeState.currentSessionMetadata = { ...metadata };
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  setCurrentStatus(status);
  return cloneStatus(status);
}

/** Publish an already-verified restore/renewal without transient login steps. */
export function publishRestoredDesktopSsoSession(
  app: App,
  user: DesktopSsoClaims,
  accessToken: string,
  metadata: Required<Pick<DesktopSsoSessionMetadata, "issuer" | "audience" | "authMode">>
) {
  const token = accessToken.trim();
  const sub = user.sub.trim();
  if (!token) throw new Error(t("sso.cookieAccessTokenEmpty"));
  if (!sub) throw new Error(t("sso.token.cookieUserInfoSubMissing", { path: "sub" }));
  const normalizedUser: DesktopSsoClaims = {
    ...persistedDesktopSsoUser(app, user),
    sub,
    name: user.name?.trim() || sub
  };
  const status = createAuthenticatedStatus(presentDesktopSsoUser(app, normalizedUser), createCompletedSteps({
    session: true,
    userInfo: true,
    accessToken: true
  }));
  const tokenPath = getDesktopSsoIdTokenFilePath(app);
  // Stage every file before replacing anything. The canonical token is replaced
  // last, so preparation failures leave the valid token available to consumers.
  const files = [
    { filePath: getSessionPath(app), content: serializeSession(status, metadata) },
    { filePath: getDesktopSsoUserInfoFilePath(app), content: serializeUserInfo(normalizedUser, "browser_session") },
    { filePath: tokenPath, content: `${token}\n` }
  ].map((file) => {
    let previous: Buffer | null = null;
    try {
      previous = fs.readFileSync(file.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      ...file,
      previous,
      temporaryPath: path.join(path.dirname(file.filePath), `.${path.basename(file.filePath)}.${process.pid}.${randomUUID()}.tmp`),
      committed: false
    };
  });
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      fs.writeFileSync(file.temporaryPath, file.content, { encoding: "utf8", mode: 0o600 });
    }
    for (const file of files) {
      fs.renameSync(file.temporaryPath, file.filePath);
      file.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of [...files].reverse()) {
      if (!file.committed) continue;
      try {
        if (file.previous === null) {
          fs.rmSync(file.filePath, { force: true });
        } else {
          fs.writeFileSync(file.temporaryPath, file.previous, { mode: 0o600 });
          fs.renameSync(file.temporaryPath, file.filePath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "SSO session publication rollback failed.");
    throw error;
  } finally {
    for (const file of files) {
      try { fs.rmSync(file.temporaryPath, { force: true }); } catch { /* A temporary file is never authoritative. */ }
    }
  }
  // Nothing below may withdraw the old token or emit an incomplete identity.
  // In particular, do not reuse beginAuthenticatedSession during renewal.
  clearCachedDesktopSsoAvatar(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  try { fs.rmSync(path.join(path.dirname(tokenPath), "sso-access-token.txt"), { force: true }); } catch { /* Canonical publication already succeeded. */ }
  closeCallbackServer();
  desktopSsoRuntimeState.pendingLogin = null;
  desktopSsoRuntimeState.currentBusinessToken = token;
  desktopSsoRuntimeState.currentIdToken = "";
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
  saveIdTokenFile(app, token);
  desktopSsoRuntimeState.currentBusinessToken = token;
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
  desktopSsoRuntimeState.credentialGeneration++;
  let credentialRemovalError: Error | undefined;
  try { clearSsoCredentials(app); } catch { credentialRemovalError = new Error("SSO local credentials could not be removed."); }
  closeCallbackServer();
  desktopSsoRuntimeState.pendingLogin = null;
  desktopSsoRuntimeState.currentBusinessToken = "";
  desktopSsoRuntimeState.currentIdToken = "";
  desktopSsoRuntimeState.currentSessionAuthMode = null;
  desktopSsoRuntimeState.currentSessionApp = null;
  desktopSsoRuntimeState.currentSessionMetadata = null;
  desktopSsoRuntimeState.loadedSessionPath = getSessionPath(app);
  desktopSsoRuntimeState.unverifiedCookieSessionCandidate = false;
  const accessTokenRemovalError = removeIdTokenFile(app);
  removeLegacyDesktopSsoSiteTokenFile(app);
  removeUserInfoFile(app);
  clearCachedDesktopSsoAvatar(app);
  const filePath = getSessionPath(app);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Session cleanup is best effort; the in-memory state is authoritative for this run.
  }
  return credentialRemovalError || accessTokenRemovalError;
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
  desktopSsoRuntimeState.currentBusinessToken = "";
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
