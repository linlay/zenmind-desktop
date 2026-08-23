import type { App, BrowserWindow, CookiesSetDetails, Session } from "electron";
import {
  type DesktopSsoClaimsConfig,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  completeDesktopSsoRestoredBrowserSession,
  completeDesktopSsoBrowserUserInfo,
  clearDesktopSsoLocalSession,
  desktopSsoAccessTokenNeedsRefresh,
  exchangeConfiguredDesktopSsoCookieForAccessToken,
  getDesktopSsoAccessToken,
  getDesktopSsoAccessTokenCookieDetails,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoCookieMirrorOrigins,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoCookieCSRFUrl,
  getDesktopSsoBrowserSessionConfig,
  getDesktopSsoCookieUserInfoConfig,
  getDesktopSsoProxyBrowserCookieDetails,
  getDesktopSsoStatus,
  getDesktopSsoWebSessionClearCookies,
  getDesktopSsoWebSessionExchangeConfig,
  markDesktopSsoRestoreTemporarilyUnavailable,
  parseDesktopSsoCookieUserInfo,
  prepareDesktopSsoSessionRestore
} from "./oidc-sso";
import { getDesktopSsoBrowserUserAgent, type DesktopPlatform } from "./platform-adapter";
import { safeConsoleError } from "./safe-console";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../shared/sso";
import type { DesktopSsoClaims } from "../shared/contracts";
import { t } from "./i18n/main-i18n";

export { DESKTOP_SSO_WEBVIEW_PARTITION };

type DesktopSsoStatus = ReturnType<typeof getDesktopSsoStatus>;
type CookieAccessTokenFetch = Parameters<typeof exchangeConfiguredDesktopSsoCookieForAccessToken>[2];

type BrowserCookieFetch = (url: string, init: {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Headers;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

type WebSessionExchangeFetch = (url: string, init: {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status?: number;
  statusText?: string;
  headers: Headers;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

type BrowserOpenInput = {
  url: string;
  label?: string;
  requireOperableTarget?: boolean;
  partition?: string;
  userAgent?: string;
};

type BrowserOpenResult = {
  ok: boolean;
  action: string;
  target: string;
  url: string;
  message: string;
  error?: string;
  title?: string;
  data?: unknown;
};

type EmbeddedLoginDialogOpenInput = {
  url: string;
  label?: string;
  browserOrigin?: string;
  resolveRedirect?: boolean;
};

type ElectronSessionAccess = {
  defaultSession: Session;
  fromPartition(partition: string): Session;
};

export type DesktopSsoControllerOptions = {
  app: App;
  platform: DesktopPlatform;
  session: ElectronSessionAccess;
  getMainWindow(): BrowserWindow | null;
  openBrowserUrl(input: BrowserOpenInput): Promise<BrowserOpenResult>;
  openExternal(url: string): Promise<void>;
  onRestoreResult?(result: DesktopSsoRestoreResult): void;
};

export type DesktopSsoRestoreResult = {
  state: "authenticated" | "signed_out" | "temporarily_unavailable";
  status: DesktopSsoStatus;
  accessToken?: string;
};

class DesktopSsoRestoreRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DesktopSsoRestoreRequestError";
  }
}

export function splitDesktopSsoSetCookieHeader(header: string) {
  return header
    .split(/,(?=\s*[^;,\s]+=)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getDesktopSsoSetCookieHeaders(headers: Headers) {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const setCookieHeader = headers.get("set-cookie");
  return setCookieHeader ? splitDesktopSsoSetCookieHeader(setCookieHeader) : [];
}

function getDesktopSsoDefaultCookiePath(url: URL) {
  const pathname = url.pathname || "/";
  if (pathname === "/" || !pathname.startsWith("/")) {
    return "/";
  }
  const lastSlashIndex = pathname.lastIndexOf("/");
  return lastSlashIndex <= 0 ? "/" : pathname.slice(0, lastSlashIndex);
}

function toDesktopSsoSameSite(value: string): CookiesSetDetails["sameSite"] {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "none") {
    return "no_restriction";
  }
  if (normalizedValue === "strict") {
    return "strict";
  }
  if (normalizedValue === "lax") {
    return "lax";
  }
  return "unspecified";
}

export function rewriteDesktopSsoUrlOrigin(value: string, browserOrigin?: string) {
  if (!browserOrigin) {
    return value;
  }
  const url = new URL(value);
  const originUrl = new URL(browserOrigin);
  if (!["http:", "https:"].includes(originUrl.protocol)) {
    return value;
  }
  url.protocol = originUrl.protocol;
  url.host = originUrl.host;
  return url.toString();
}

export function parseDesktopSsoSetCookieHeader(header: string, responseUrl: string): CookiesSetDetails | null {
  const responseUrlObject = new URL(responseUrl);
  const [nameValuePair, ...attributes] = header.split(";");
  const separatorIndex = nameValuePair.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const name = nameValuePair.slice(0, separatorIndex).trim();
  if (!name) {
    return null;
  }

  const details: CookiesSetDetails = {
    url: responseUrlObject.origin,
    name,
    value: nameValuePair.slice(separatorIndex + 1).trim(),
    path: getDesktopSsoDefaultCookiePath(responseUrlObject)
  };

  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }

    const attributeSeparatorIndex = attribute.indexOf("=");
    const attributeName = (attributeSeparatorIndex >= 0
      ? attribute.slice(0, attributeSeparatorIndex)
      : attribute).trim().toLowerCase();
    const attributeValue = attributeSeparatorIndex >= 0
      ? attribute.slice(attributeSeparatorIndex + 1).trim()
      : "";

    if (attributeName === "domain" && attributeValue) {
      details.domain = attributeValue;
    } else if (attributeName === "path" && attributeValue) {
      details.path = attributeValue;
    } else if (attributeName === "secure") {
      details.secure = true;
    } else if (attributeName === "httponly") {
      details.httpOnly = true;
    } else if (attributeName === "samesite" && attributeValue) {
      details.sameSite = toDesktopSsoSameSite(attributeValue);
    } else if (attributeName === "expires" && attributeValue) {
      const expiresAt = Date.parse(attributeValue);
      if (Number.isFinite(expiresAt)) {
        details.expirationDate = Math.floor(expiresAt / 1000);
      }
    } else if (attributeName === "max-age" && attributeValue) {
      const maxAgeSeconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(maxAgeSeconds)) {
        details.expirationDate = Math.floor(Date.now() / 1000) + maxAgeSeconds;
      }
    }
  }

  return details;
}

async function applyDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  setCookieHeaders: string[]
) {
  await Promise.all(setCookieHeaders.map(async (header) => {
    const cookieDetails = parseDesktopSsoSetCookieHeader(header, responseUrl);
    if (!cookieDetails) {
      return;
    }
    await ssoSession.cookies.set(cookieDetails);
  }));
}

async function applyDesktopSsoSetCookieHeadersToSessions(
  targetSessions: Session[],
  responseUrls: string[],
  setCookieHeaders: string[]
) {
  const uniqueResponseUrls = [...new Set(responseUrls)];
  await Promise.all(uniqueResponseUrls.flatMap((responseUrl) =>
    targetSessions.map((targetSession) =>
      applyDesktopSsoSetCookieHeaders(targetSession, responseUrl, setCookieHeaders)
    )
  ));
}

async function readDesktopSsoWebSessionExchangeError(response: {
  status?: number;
  statusText?: string;
  text?: () => Promise<string>;
}) {
  const status = typeof response.status === "number" && response.status > 0
    ? response.status
    : 0;
  const statusText = response.statusText?.trim() || "";
  let detail = "";
  if (typeof response.text === "function") {
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = "";
    }
  }
  return [status ? String(status) : "", statusText, detail]
    .filter(Boolean)
    .join(" - ") || "unknown error";
}

function getRecordValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function getRecordString(value: unknown, key: string) {
  const rawValue = getRecordValue(value, key);
  return typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : "";
}

function getRecordIdString(value: unknown, key: string) {
  const rawValue = getRecordValue(value, key);
  if (typeof rawValue === "string" && rawValue.trim()) {
    return rawValue.trim();
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return String(rawValue);
  }
  return "";
}

const DESKTOP_SSO_AVATAR_CLAIM_KEYS = ["avatarUrl", "picture", "avatar_url", "avatar"] as const;

function getRecordAvatarUrl(value: unknown) {
  for (const key of DESKTOP_SSO_AVATAR_CLAIM_KEYS) {
    const avatarUrl = getRecordString(value, key);
    if (avatarUrl) {
      return avatarUrl;
    }
  }
  return "";
}

function createWebSessionClaims(
  user: unknown,
  exchangeUrl: string,
  claimsConfig: DesktopSsoClaimsConfig
): DesktopSsoClaims | null {
  const id = getRecordIdString(user, "id");
  if (!id) {
    return null;
  }
  const email = getRecordString(user, "email");
  const displayName = getRecordString(user, "displayName") || getRecordString(user, "name");
  const avatarUrl = getRecordAvatarUrl(user);
  return {
    sub: `${claimsConfig.webSessionSubPrefix}${id}`,
    issuer: new URL(exchangeUrl).origin,
    audience: claimsConfig.audience,
    ...(email ? { email } : {}),
    ...(displayName ? { name: displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

async function buildDesktopSsoCookieHeader(ssoSession: Session, targetUrl: string) {
  const cookies = await ssoSession.cookies.get({ url: targetUrl });
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function mirrorDesktopSsoSetCookieHeaders(
  ssoSession: Session,
  responseUrl: string,
  browserOrigin: string | undefined,
  setCookieHeaders: string[]
) {
  await applyDesktopSsoSetCookieHeaders(ssoSession, responseUrl, setCookieHeaders);
  const mirroredResponseUrl = rewriteDesktopSsoUrlOrigin(responseUrl, browserOrigin);
  if (mirroredResponseUrl !== responseUrl) {
    await applyDesktopSsoSetCookieHeaders(ssoSession, mirroredResponseUrl, setCookieHeaders);
  }
}

async function resolveDesktopSsoNavigationUrl(
  ssoSession: Session,
  targetUrl: string,
  userAgent: string,
  browserOrigin?: string
) {
  try {
    const requestUrl = new URL(targetUrl);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, targetUrl);
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": userAgent
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await fetch(targetUrl, {
      redirect: "manual",
      headers
    });
    await mirrorDesktopSsoSetCookieHeaders(
      ssoSession,
      response.url || targetUrl,
      browserOrigin,
      getDesktopSsoSetCookieHeaders(response.headers)
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const resolvedLocation = new URL(location, requestUrl).toString();
        return rewriteDesktopSsoUrlOrigin(resolvedLocation, browserOrigin);
      }
    }
  } catch (error) {
    safeConsoleError("failed to resolve desktop sso navigation url", {
      url: targetUrl,
      error
    });
  }
  return rewriteDesktopSsoUrlOrigin(targetUrl, browserOrigin);
}

function focusMainWindowAfterDesktopSso(options: DesktopSsoControllerOptions) {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  if (options.platform === "darwin") {
    options.app.focus({ steal: true });
    mainWindow.focus();
    return;
  }
  if (options.platform === "win32") {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  mainWindow.focus();
}

export function createDesktopSsoController(options: DesktopSsoControllerOptions) {
  let accessTokenRefreshPromise: Promise<string> | null = null;
  let restorePromise: Promise<DesktopSsoRestoreResult> | null = null;
  let restoreState: DesktopSsoRestoreResult["state"] | "uninitialized" = "uninitialized";

  function publishRestoreResult(result: DesktopSsoRestoreResult) {
    try {
      options.onRestoreResult?.(result);
    } catch (error) {
      safeConsoleError("failed to publish desktop sso restore result", error);
    }
    return result;
  }

  async function probeBrowserSession(fetchImpl?: BrowserCookieFetch, signal?: AbortSignal) {
    const config = getDesktopSsoBrowserSessionConfig(options.app);
    if (!config) {
      return null;
    }
    const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, config.url);
    if (!cookieHeader) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO browser session cookie is missing.", 401);
    }
    const headers: Record<string, string> = {
      Accept: "application/json,text/plain,*/*",
      ...config.headers,
      Cookie: cookieHeader
    };
    const request = fetchImpl || ((url, init) => ssoSession.fetch(url, init) as unknown as ReturnType<BrowserCookieFetch>);
    const response = await request(config.url, {
      method: config.method,
      headers,
      ...(config.body !== undefined ? { body: config.body } : {}),
      ...(signal ? { signal } : {})
    });
    if (!config.successStatuses.includes(response.status)) {
      throw new DesktopSsoRestoreRequestError(
        `Desktop SSO browser session validation failed: ${await readDesktopSsoWebSessionExchangeError(response)}`,
        response.status
      );
    }
    await mirrorDesktopSsoSetCookieHeaders(
      ssoSession,
      config.url,
      undefined,
      getDesktopSsoSetCookieHeaders(response.headers)
    );
    if (!config.userInfoHeaders) {
      return { userInfo: undefined };
    }
    const sub = response.headers.get(config.userInfoHeaders.sub)?.trim() || "";
    if (!sub) {
      return { userInfo: undefined };
    }
    const readOptionalHeader = (headerName: string | undefined) =>
      headerName ? response.headers.get(headerName)?.trim() || "" : "";
    return {
      userInfo: {
        sub,
        name: readOptionalHeader(config.userInfoHeaders.name),
        email: readOptionalHeader(config.userInfoHeaders.email),
        avatarUrl: readOptionalHeader(config.userInfoHeaders.avatarUrl)
      }
    };
  }

  async function probeBrowserUserInfo(signal: AbortSignal) {
    const config = getDesktopSsoCookieUserInfoConfig(options.app);
    if (!config) {
      return undefined;
    }
    const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, config.url);
    if (!cookieHeader) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO browser userinfo cookie is missing.", 401);
    }
    const response = await ssoSession.fetch(config.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader
      },
      signal
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new DesktopSsoRestoreRequestError(
          `Desktop SSO browser userinfo rejected the upstream session (${response.status}).`,
          response.status
        );
      }
      if (!config.required) {
        return undefined;
      }
      throw new DesktopSsoRestoreRequestError(
        `Desktop SSO browser userinfo failed: ${await readDesktopSsoWebSessionExchangeError(response)}`,
        response.status
      );
    }
    await mirrorDesktopSsoSetCookieHeaders(
      ssoSession,
      config.url,
      undefined,
      getDesktopSsoSetCookieHeaders(response.headers)
    );
    try {
      return parseDesktopSsoCookieUserInfo(options.app, await response.json());
    } catch (error) {
      if (!config.required) {
        return undefined;
      }
      throw error;
    }
  }

  async function flushDesktopSsoSessions() {
    const targetSessions = [
      options.session.defaultSession,
      options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
    ];
    await Promise.all(targetSessions.map(async (targetSession) => {
      if (typeof targetSession.flushStorageData === "function") {
        await targetSession.flushStorageData();
      }
    }));
  }

  async function exchangeBrowserCookieAccessToken(
    fetchImpl?: CookieAccessTokenFetch,
    exchangeOptions: { signal?: AbortSignal; persist?: boolean; requireCookie?: boolean } = {}
  ) {
    const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(options.app);
    if (!exchangeUrl) {
      return "";
    }
    const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, exchangeUrl);
    if (!cookieHeader && exchangeOptions.requireCookie) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO access-token exchange cookie is missing.", 401);
    }
    const accessTokenFetch = fetchImpl || ((url, init) => ssoSession.fetch(url, init));
    const request: CookieAccessTokenFetch = async (url, init) => accessTokenFetch(url, {
      ...init,
      ...(exchangeOptions.signal ? { signal: exchangeOptions.signal } : {})
    });
    const accessToken = await exchangeConfiguredDesktopSsoCookieForAccessToken(
      options.app,
      cookieHeader,
      request,
      { persist: exchangeOptions.persist }
    );
    if (!accessToken) {
      return "";
    }
    const cookieDetails = getDesktopSsoAccessTokenCookieDetails(options.app, accessToken);
    const targetSessions = [options.session.defaultSession, ssoSession];
    await Promise.all(cookieDetails.flatMap((details) =>
      targetSessions.map(async (targetSession) => {
        await targetSession.cookies.set(details);
      })
    ));
    await flushDesktopSsoSessions();
    return accessToken;
  }

  async function clearRestoredDesktopSsoCookies() {
    const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
    const defaultSession = options.session.defaultSession;
    const knownOrigins = new Set([
      ...getDesktopSsoCookieMirrorOrigins(options.app),
      ...getDesktopSsoWebSessionClearCookies(options.app).map((details) => new URL(details.url).origin)
    ]);
    await Promise.all([...knownOrigins].map(async (origin) => {
      try {
        const cookies = await defaultSession.cookies.get({ url: origin });
        await Promise.all(cookies.map(async (cookie) => {
          try {
            await defaultSession.cookies.remove(origin, cookie.name);
          } catch {
            // Definitive restore failure already clears canonical files; Cookie removal is best effort.
          }
        }));
      } catch {
        // Failure to enumerate a known default-session origin is best effort.
      }
    }));
    try {
      const cookies = await ssoSession.cookies.get({});
      await Promise.all(cookies.map(async (cookie) => {
        const domain = cookie.domain?.replace(/^\./u, "") || "";
        if (!domain) {
          return;
        }
        const cookiePath = cookie.path?.startsWith("/") ? cookie.path : `/${cookie.path || ""}`;
        try {
          await ssoSession.cookies.remove(`${cookie.secure ? "https" : "http"}://${domain}${cookiePath}`, cookie.name);
        } catch {
          // Dedicated SSO partition cleanup is best effort.
        }
      }));
    } catch {
      // Failure to enumerate the dedicated partition does not restore local authentication.
    }
    try {
      await flushDesktopSsoSessions();
    } catch {
      // Cookie cleanup remains best effort after the canonical files are cleared.
    }
  }

  async function clearDesktopSsoAccessTokenCookies() {
    const targetSessions = [
      options.session.defaultSession,
      options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
    ];
    const cookieLookups = getDesktopSsoAccessTokenCookieLookups(options.app);
    await Promise.all(cookieLookups.flatMap((details) =>
      targetSessions.map(async (targetSession) => {
        await targetSession.cookies.remove(details.url, details.name);
      })
    ));
    await flushDesktopSsoSessions();
  }

  function isDefinitiveRestoreFailure(error: unknown) {
    const status = error instanceof DesktopSsoRestoreRequestError ? error.status : undefined;
    return status === 401 || status === 403 || status === 204 || Boolean(status && status >= 300 && status < 400);
  }

  async function performDesktopSsoSessionRestore(timeoutMs: number): Promise<DesktopSsoRestoreResult> {
    const wasTemporarilyUnavailable = restoreState === "temporarily_unavailable";
    const preparation = prepareDesktopSsoSessionRestore(options.app);
    if (preparation.clearCookies) {
      await clearRestoredDesktopSsoCookies();
    }
    if (!preparation.requiresCookieValidation) {
      const result: DesktopSsoRestoreResult = {
        state: preparation.status.authenticated ? "authenticated" : "signed_out",
        status: preparation.status,
        ...(preparation.status.authenticated && getDesktopSsoAccessToken()
          ? { accessToken: getDesktopSsoAccessToken() || undefined }
          : {})
      };
      restoreState = result.state;
      return publishRestoreResult(result);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      // Keep the upstream session Cookie as the recovery authority, but remove the derived JWT
      // Cookie until this process has verified the session and exchanged a fresh token.
      await clearDesktopSsoAccessTokenCookies();
      const browserSession = await probeBrowserSession(undefined, abortController.signal);
      const stableUserInfo = browserSession?.userInfo || await probeBrowserUserInfo(abortController.signal);
      if (!stableUserInfo?.sub.trim()) {
        throw new Error("Desktop SSO restore did not return a stable user id.");
      }
      let exchangeStatus: number | undefined;
      const accessToken = await exchangeBrowserCookieAccessToken(async (url, init) => {
        const response = await options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION).fetch(url, init);
        exchangeStatus = response.status;
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 204 ||
          (response.status >= 300 && response.status < 400)
        ) {
          throw new DesktopSsoRestoreRequestError(
            `Desktop SSO access-token exchange rejected the upstream session (${response.status}).`,
            response.status
          );
        }
        return response;
      }, {
        signal: abortController.signal,
        persist: false,
        requireCookie: true
      });
      if (!accessToken) {
        throw new DesktopSsoRestoreRequestError("Desktop SSO access-token exchange returned no token.", exchangeStatus);
      }
      const status = completeDesktopSsoRestoredBrowserSession(options.app, accessToken, stableUserInfo);
      const result: DesktopSsoRestoreResult = { state: "authenticated", status, accessToken };
      restoreState = result.state;
      if (wasTemporarilyUnavailable) {
        options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      }
      return publishRestoreResult(result);
    } catch (error) {
      if (isDefinitiveRestoreFailure(error)) {
        const status = clearDesktopSsoLocalSession(options.app, t("sso.restoreSessionExpired"));
        await clearRestoredDesktopSsoCookies();
        const result: DesktopSsoRestoreResult = { state: "signed_out", status };
        restoreState = result.state;
        options.getMainWindow()?.webContents.send("sso.statusChanged", status);
        return publishRestoreResult(result);
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = markDesktopSsoRestoreTemporarilyUnavailable(options.app, message);
      const result: DesktopSsoRestoreResult = { state: "temporarily_unavailable", status };
      restoreState = result.state;
      options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      return publishRestoreResult(result);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    returnToApp() {
      focusMainWindowAfterDesktopSso(options);
    },
    broadcastStatus(status: DesktopSsoStatus) {
      if (status.authenticated && !status.pending) {
        restoreState = "authenticated";
        publishRestoreResult({
          state: "authenticated",
          status,
          ...(getDesktopSsoAccessToken() ? { accessToken: getDesktopSsoAccessToken() || undefined } : {})
        });
      } else if (!status.authenticated && !status.pending) {
        restoreState = "signed_out";
        publishRestoreResult({ state: "signed_out", status });
      }
      options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      if (status.authenticated) {
        focusMainWindowAfterDesktopSso(options);
      }
    },
    async openBrowserUrl(input: {
      url: string;
      label?: string;
      browserOrigin?: string;
      resolveRedirect?: boolean;
    }) {
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const userAgent = getDesktopSsoBrowserUserAgent(options.platform);
      await ssoSession.setProxy({ proxyRules: "direct://" });
      return options.openBrowserUrl({
        ...input,
        url: input.resolveRedirect === false
          ? rewriteDesktopSsoUrlOrigin(input.url, input.browserOrigin)
          : await resolveDesktopSsoNavigationUrl(ssoSession, input.url, userAgent, input.browserOrigin),
        requireOperableTarget: false,
        partition: DESKTOP_SSO_WEBVIEW_PARTITION,
        userAgent
      });
    },
    async openEmbeddedLoginDialog(input: EmbeddedLoginDialogOpenInput): Promise<BrowserOpenResult> {
      const targetWindow = options.getMainWindow();
      if (!targetWindow || targetWindow.isDestroyed()) {
        return {
          ok: false,
          action: "open_embedded_sso_login",
          target: input.url,
          url: input.url,
          error: "main_window_unavailable",
          message: "Desktop SSO login window is unavailable."
        };
      }
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const userAgent = getDesktopSsoBrowserUserAgent(options.platform);
      await ssoSession.setProxy({ proxyRules: "direct://" });
      const url = input.resolveRedirect === false
        ? rewriteDesktopSsoUrlOrigin(input.url, input.browserOrigin)
        : await resolveDesktopSsoNavigationUrl(ssoSession, input.url, userAgent, input.browserOrigin);
      targetWindow.webContents.send("sso.embeddedLogin.open", {
        url,
        label: input.label || t("sso.iamLogin"),
        partition: DESKTOP_SSO_WEBVIEW_PARTITION,
        userAgent
      });
      const label = input.label || t("sso.iamLogin");
      return {
        ok: true,
        action: "open_embedded_sso_login",
        target: input.url,
        url,
        message: t("sso.embeddedLoginOpened", { label })
      };
    },
    async openSystemBrowserUrl(input: {
      url: string;
      label?: string;
    }) {
      const targetUrl = input.url.trim();
      try {
        await options.openExternal(targetUrl);
        return {
          ok: true,
          action: "open_system_browser",
          target: targetUrl,
          url: targetUrl,
          message: t("sso.systemBrowserOpened", { label: input.label || targetUrl })
        };
      } catch (error) {
        return {
          ok: false,
          action: "open_system_browser",
          target: targetUrl,
          url: targetUrl,
          message: t("sso.systemBrowserOpenFailed", { label: input.label || targetUrl }),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    },
    async syncBrowserCookies() {
      const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
      const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(options.app);
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const targetSessions = [
        options.session.defaultSession,
        ssoSession
      ];
      await Promise.all(cookieDetails.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          await targetSession.cookies.set(details);
        })
      ));
      await Promise.all(mirrorOrigins.map(async (origin) => {
        const cookies = await ssoSession.cookies.get({ url: origin });
        await Promise.all(cookies.map(async (cookie) => {
          await options.session.defaultSession.cookies.set({
            url: origin,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || undefined,
            path: cookie.path || "/",
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expirationDate,
            sameSite: cookie.sameSite
          });
        }));
      }));
    },
    async validateBrowserSession(fetchImpl?: BrowserCookieFetch) {
      const browserSession = await probeBrowserSession(fetchImpl);
      if (!browserSession) {
        return null;
      }
      const sessionStatus = completeDesktopSsoBrowserSession(options.app);
      if (!browserSession.userInfo) {
        return sessionStatus;
      }
      return completeDesktopSsoBrowserSessionUserInfo(options.app, browserSession.userInfo);
    },
    async fetchBrowserUserInfo(fetchImpl?: BrowserCookieFetch) {
      const config = getDesktopSsoCookieUserInfoConfig(options.app);
      if (!config) {
        return null;
      }
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, config.url);
      const headers: Record<string, string> = {
        Accept: "application/json"
      };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const request = fetchImpl || ((url, init) => ssoSession.fetch(url, init) as unknown as ReturnType<BrowserCookieFetch>);
      const response = await request(config.url, { method: "GET", headers });
      if (!response.ok) {
        if (!config.required) {
          return getDesktopSsoStatus(options.app);
        }
        throw new Error(`Desktop SSO browser userinfo failed: ${await readDesktopSsoWebSessionExchangeError(response)}`);
      }
      if (typeof response.json !== "function") {
        if (!config.required) {
          return getDesktopSsoStatus(options.app);
        }
        throw new Error("Desktop SSO browser userinfo response is not JSON.");
      }
      await mirrorDesktopSsoSetCookieHeaders(
        ssoSession,
        config.url,
        undefined,
        getDesktopSsoSetCookieHeaders(response.headers)
      );
      try {
        return completeDesktopSsoBrowserUserInfo(options.app, await response.json());
      } catch (error) {
        if (!config.required) {
          return getDesktopSsoStatus(options.app);
        }
        throw error;
      }
    },
    async exchangeBrowserCookieAccessToken(fetchImpl?: CookieAccessTokenFetch) {
      return exchangeBrowserCookieAccessToken(fetchImpl);
    },
    async refreshBrowserCookieAccessTokenIfNeeded(force = false, fetchImpl?: CookieAccessTokenFetch) {
      const status = getDesktopSsoStatus(options.app);
      if (!status.authenticated || !getDesktopSsoCookieAccessTokenExchangeUrl(options.app)) {
        return "";
      }
      if (!force && !desktopSsoAccessTokenNeedsRefresh(options.app)) {
        return getDesktopSsoAccessToken() || "";
      }
      if (accessTokenRefreshPromise) {
        return accessTokenRefreshPromise;
      }
      accessTokenRefreshPromise = this.exchangeBrowserCookieAccessToken(fetchImpl)
        .finally(() => {
          accessTokenRefreshPromise = null;
        });
      return accessTokenRefreshPromise;
    },
    async restoreDesktopSsoSession(timeoutMs = 5_000) {
      if (restoreState !== "uninitialized") {
        return {
          state: restoreState,
          status: getDesktopSsoStatus(options.app),
          ...(restoreState === "authenticated" && getDesktopSsoAccessToken()
            ? { accessToken: getDesktopSsoAccessToken() || undefined }
            : {})
        } satisfies DesktopSsoRestoreResult;
      }
      if (!restorePromise) {
        restorePromise = performDesktopSsoSessionRestore(timeoutMs).finally(() => {
          restorePromise = null;
        });
      }
      return restorePromise;
    },
    async retryDesktopSsoSessionRestoreIfNeeded(timeoutMs = 5_000) {
      if (restoreState !== "temporarily_unavailable") {
        return {
          state: restoreState === "uninitialized"
            ? (getDesktopSsoStatus(options.app).authenticated ? "authenticated" : "signed_out")
            : restoreState,
          status: getDesktopSsoStatus(options.app),
          ...(getDesktopSsoAccessToken() ? { accessToken: getDesktopSsoAccessToken() || undefined } : {})
        } satisfies DesktopSsoRestoreResult;
      }
      if (!restorePromise) {
        restorePromise = performDesktopSsoSessionRestore(timeoutMs).finally(() => {
          restorePromise = null;
        });
      }
      return restorePromise;
    },
    async exchangeWebSession(idToken: string, fetchImpl: WebSessionExchangeFetch = fetch as unknown as WebSessionExchangeFetch) {
      const exchangeConfig = getDesktopSsoWebSessionExchangeConfig(options.app);
      const token = idToken.trim();
      if (!exchangeConfig || !token) {
        return false;
      }
      const response = await fetchImpl(exchangeConfig.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          provider: exchangeConfig.provider,
          id_token: token
        })
      });
      if (!response.ok) {
        throw new Error(`Desktop SSO web session exchange failed: ${await readDesktopSsoWebSessionExchangeError(response)}`);
      }
      const setCookieHeaders = getDesktopSsoSetCookieHeaders(response.headers);
      if (setCookieHeaders.length === 0) {
        return false;
      }
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await applyDesktopSsoSetCookieHeadersToSessions(
        targetSessions,
        [exchangeConfig.url, ...exchangeConfig.cookieOrigins],
        setCookieHeaders
      );
      return true;
    },
    async exchangeWebSessionTicket(ticket: string, fetchImpl: WebSessionExchangeFetch = fetch as unknown as WebSessionExchangeFetch) {
      const exchangeConfig = getDesktopSsoWebSessionExchangeConfig(options.app);
      const normalizedTicket = ticket.trim();
      if (!exchangeConfig || !normalizedTicket) {
        return null;
      }
      const response = await fetchImpl(exchangeConfig.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          provider: exchangeConfig.provider,
          ticket: normalizedTicket
        })
      });
      if (!response.ok) {
        throw new Error(`Desktop SSO web session exchange failed: ${await readDesktopSsoWebSessionExchangeError(response)}`);
      }
      const setCookieHeaders = getDesktopSsoSetCookieHeaders(response.headers);
      if (setCookieHeaders.length === 0) {
        return null;
      }
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await applyDesktopSsoSetCookieHeadersToSessions(
        targetSessions,
        [exchangeConfig.url, ...exchangeConfig.cookieOrigins],
        setCookieHeaders
      );
      if (typeof response.json !== "function") {
        return null;
      }
      const responseBody = await response.json();
      return createWebSessionClaims(getRecordValue(responseBody, "user"), exchangeConfig.url, exchangeConfig.claims);
    },
    async logoutWebSession(fetchImpl: WebSessionExchangeFetch = fetch as unknown as WebSessionExchangeFetch) {
      const exchangeConfig = getDesktopSsoWebSessionExchangeConfig(options.app);
      if (!exchangeConfig) {
        return false;
      }
      const logoutUrl = new URL("/api/auth/logout", exchangeConfig.url).toString();
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, logoutUrl);
      const headers: Record<string, string> = {
        Accept: "application/json"
      };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const csrfUrl = getDesktopSsoCookieCSRFUrl(options.app);
      if (csrfUrl) {
        const csrfResponse = await fetchImpl(csrfUrl, {
          method: "GET",
          headers: { ...headers }
        });
        if (!csrfResponse.ok || typeof csrfResponse.json !== "function") {
          throw new Error(`Desktop SSO CSRF request failed: ${await readDesktopSsoWebSessionExchangeError(csrfResponse)}`);
        }
        const csrfBody = await csrfResponse.json();
        const csrfToken = csrfBody && typeof csrfBody === "object" && !Array.isArray(csrfBody)
          ? String((csrfBody as Record<string, unknown>).csrfToken || "").trim()
          : "";
        if (!csrfToken) {
          throw new Error("Desktop SSO CSRF response did not include csrfToken.");
        }
        headers["X-CSRF-Token"] = csrfToken;
      }
      const response = await fetchImpl(logoutUrl, {
        method: "POST",
        headers,
        body: ""
      });
      if (!response.ok) {
        throw new Error(`Desktop SSO web session logout failed: ${await readDesktopSsoWebSessionExchangeError(response)}`);
      }
      return true;
    },
    async clearBrowserCookies() {
      const cookieDetails = getDesktopSsoProxyBrowserCookieDetails();
      const mirrorOrigins = getDesktopSsoCookieMirrorOrigins(options.app);
      const ssoSession = options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION);
      const targetSessions = [
        options.session.defaultSession,
        ssoSession
      ];
      await Promise.all(cookieDetails.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          try {
            await targetSession.cookies.remove(details.url, details.name);
          } catch {
            // Cookie removal is best effort; local Desktop auth state is already cleared.
          }
        })
      ));
      await Promise.all(targetSessions.flatMap((targetSession) =>
        mirrorOrigins.map(async (origin) => {
          const cookies = await targetSession.cookies.get({ url: origin });
          await Promise.all(cookies.map(async (cookie) => {
            try {
              await targetSession.cookies.remove(origin, cookie.name);
            } catch {
              // Cookie removal is best effort; local Desktop auth state is already cleared.
            }
          }));
        })
      ));
      try {
        const partitionCookies = await ssoSession.cookies.get({});
        await Promise.all(partitionCookies.map(async (cookie) => {
          const domain = cookie.domain?.replace(/^\./u, "") || "";
          if (!domain) {
            return;
          }
          const cookiePath = cookie.path?.startsWith("/") ? cookie.path : `/${cookie.path || ""}`;
          const cookieUrl = `${cookie.secure ? "https" : "http"}://${domain}${cookiePath}`;
          try {
            await ssoSession.cookies.remove(cookieUrl, cookie.name);
          } catch {
            // Logout clears the dedicated partition on a best-effort basis.
          }
        }));
      } catch {
        // Failure to enumerate the dedicated partition does not block local logout.
      }
    },
    async clearWebSessionCookies() {
      const clearCookies = getDesktopSsoWebSessionClearCookies(options.app);
      if (clearCookies.length === 0) {
        return;
      }
      const targetSessions = [
        options.session.defaultSession,
        options.session.fromPartition(DESKTOP_SSO_WEBVIEW_PARTITION)
      ];
      await Promise.all(clearCookies.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          try {
            await targetSession.cookies.remove(details.url, details.name);
          } catch {
            // Cookie removal is best effort; local Desktop auth state is already cleared.
          }
        })
      ));
    }
  };
}
