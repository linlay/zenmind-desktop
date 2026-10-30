import type {
  DesktopSsoControllerOptions,
  DesktopSsoRestoreResult,
  BrowserCookieFetch,
  CookieAccessTokenFetch,
  DesktopSsoStatus,
  EmbeddedLoginDialogOpenInput,
  BrowserOpenResult,
  WebSessionExchangeFetch
} from "./sso-controller-model";
import { safeConsoleError } from "../../support/logging/safe-console";
import {
  getDesktopSsoBrowserSessionConfig,
  getDesktopSsoCookieUserInfoConfig,
  parseDesktopSsoCookieUserInfo,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  exchangeConfiguredDesktopSsoCookieForAccessToken,
  getDesktopSsoBusinessTokenCookieDetails,
  getDesktopSsoWebSessionClearCookies,
  getDesktopSsoBusinessTokenCookieLookups,
  getDesktopSsoBusinessToken,
  completeDesktopSsoRestoredBrowserSession,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  completeDesktopSsoBrowserUserInfo,
  persistDesktopSsoAccessToken,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoCookieCSRFUrl
} from "./sso-browser-session";
import {
  buildDesktopSsoCookieHeader,
  mirrorDesktopSsoSetCookieHeaders,
  focusMainWindowAfterDesktopSso,
  resolveDesktopSsoNavigationUrl
} from "./sso-browser-navigation";
import { DesktopSsoRestoreRequestError } from "./sso-controller-model";
import { readDesktopSsoWebSessionExchangeError, createWebSessionClaims, getRecordValue } from "./sso-browser-response";
import { getDesktopSsoSetCookieHeaders, rewriteDesktopSsoUrlOrigin, applyDesktopSsoSetCookieHeadersToSessions } from "./sso-browser-cookies";
import { getDesktopSsoCookieMirrorOrigins, getDesktopSsoProxyBrowserCookieDetails } from "./sso-proxy";
import {
  prepareDesktopSsoSessionRestore,
  clearDesktopSsoLocalSession,
  markDesktopSsoRestoreTemporarilyUnavailable,
  getDesktopSsoStatus
} from "./sso-restore";
import { readDesktopSsoIdToken, desktopSsoIdTokenNeedsRefresh } from "./sso-session";
import { loadDesktopSsoConfig } from "./sso-config";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopSsoBrowserUserAgent } from "../../infrastructure/electron/platform-adapter";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";
import { desktopSsoRuntimeState, subscribeDesktopSsoCredentialRevocation } from "./sso-state";
import { createSsoCredentialStore } from "./sso-credentials";
import { requestSsoTokens, SsoTokenRequestError } from "./sso-token-client";
import { readJsonPathValue } from "./sso-cookie-token";
import { removeIdTokenFile } from "./sso-session";
import { getJwtPayload } from "./sso-claims";
import { SsoKnownFailure, describeSsoFailure, type SsoFailureStage } from "./sso-failures";

export function createDesktopSsoController(options: DesktopSsoControllerOptions) {
  let accessTokenRefreshPromise: Promise<string> | null = null;
  let restorePromise: Promise<DesktopSsoRestoreResult> | null = null;
  let restoreState: DesktopSsoRestoreResult["state"] | "uninitialized" = "uninitialized";
  const credentials = createSsoCredentialStore(options.app, options.platform);
  let oidcBlocked = false;
  let oidcGeneration = desktopSsoRuntimeState.credentialGeneration;
  let oidcFlight: Promise<string> | null = null;
  let oidcFlightGeneration = -1;
  let oidcAbort: AbortController | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduledRenewalExpiry = 0;
  const clearTimers = () => { clearTimeout(renewalTimer); clearTimeout(expiryTimer); };
  const unsubscribeRevocation = subscribeDesktopSsoCredentialRevocation(() => {
    // Expiry withdraws the published proof but may still accept this account's in-flight renewal.
    if (oidcFlightGeneration !== desktopSsoRuntimeState.credentialGeneration) {
      oidcAbort?.abort(); scheduledRenewalExpiry = 0;
    }
    clearTimers();
  });
  if (typeof options.app.once === "function") options.app.once("before-quit", () => {
    oidcAbort?.abort(); clearTimers(); unsubscribeRevocation();
  });

  function scheduleOidcRenewal(idToken: string) {
    clearTimers();
    const payload = getJwtPayload(idToken);
    const expiry = Number(payload.exp) * 1000;
    const lifetime = typeof payload.iat === "number" && payload.iat * 1000 < expiry ? expiry - payload.iat * 1000 : 75 * 60_000;
    const skew = Math.min(15 * 60_000, lifetime * 0.2);
    const arm = (at: number, action: () => void, assign: (timer: ReturnType<typeof setTimeout>) => void) => {
      const tick = () => {
        const remaining = at - Date.now();
        const timer = setTimeout(remaining > 2_147_483_647 ? tick : action, Math.max(1, Math.min(2_147_483_647, remaining)));
        assign(timer); timer.unref();
      };
      tick();
    };
    // Never re-arm automatic renewal for an upstream response with unchanged expiry.
    if (scheduledRenewalExpiry !== expiry) {
      scheduledRenewalExpiry = expiry;
      arm(expiry - skew, () => { void exchangeOidcTokens().catch(() => {}); }, timer => { renewalTimer = timer; });
    }
    arm(expiry, () => {
      if (getDesktopSsoBusinessToken() !== idToken) return;
      const status = markDesktopSsoRestoreTemporarilyUnavailable(options.app, t("sso.restoreTemporarilyUnavailable"));
      const removalError = removeIdTokenFile(options.app, false);
      if (removalError) safeConsoleError("failed to withdraw expired SSO ID token", { errorType: removalError.name });
      restoreState = "temporarily_unavailable";
      options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      publishRestoreResult({ state: restoreState, status });
    }, timer => { expiryTimer = timer; });
  }

  function currentOidcConfig() {
    const config = loadDesktopSsoConfig(options.app).config;
    return config?.tokenExchange ? config : null;
  }

  async function exchangeOidcTokens(interactive = false, fetchImpl?: CookieAccessTokenFetch) {
    const config = currentOidcConfig();
    if (!config) return "";
    // A market retry must not complete or close a user's in-progress login.
    if (!interactive && desktopSsoRuntimeState.pendingLogin) {
      throw new Error(t("sso.waitingForIam"));
    }
    if (oidcGeneration !== desktopSsoRuntimeState.credentialGeneration) {
      oidcBlocked = false;
      oidcGeneration = desktopSsoRuntimeState.credentialGeneration;
    }
    if (oidcFlight && oidcFlightGeneration === desktopSsoRuntimeState.credentialGeneration) return oidcFlight;
    oidcAbort?.abort();
    if (!interactive && oidcBlocked) throw new Error("SSO automatic renewal stopped; sign in or retry manually.");
    const generation = desktopSsoRuntimeState.credentialGeneration;
    oidcFlightGeneration = generation;
    const abort = new AbortController();
    oidcAbort = abort;
    const current = () => generation === desktopSsoRuntimeState.credentialGeneration &&
      currentOidcConfig()?.tokenExchange?.url === config.tokenExchange!.url &&
      currentOidcConfig()?.tokenRefresh?.url === config.tokenRefresh!.url;
    const request = fetchImpl || ((url, init) => options.session.defaultSession.fetch(url, init));
    const operation = (async () => {
      let stage: SsoFailureStage = "readCredentials";
      try {
        const previous = interactive ? null : credentials.read(new URL(config.tokenExchange!.url).origin);
        stage = "readCookie";
        const cookie = previous?.refreshToken ? undefined :
          await buildDesktopSsoCookieHeader(options.session.defaultSession, config.tokenExchange!.url);
        if (!current()) return "";
        if (!previous?.refreshToken && !cookie) throw new SsoTokenRequestError(401);
        stage = "tokenRequest";
        const next = await requestSsoTokens(config, request, {
          previous, cookie, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)])
        });
        if (!current()) return "";
        // A rotated refresh token must survive a later userinfo/Cookie publication failure.
        stage = "saveCredentials";
        if (previous) credentials.save(next);
        const userConfig = config.userInfo!;
        stage = "accountRequest";
        const response = await request(userConfig.url, {
          method: "GET", credentials: "omit", redirect: "manual", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
          headers: { Accept: "application/json", Authorization: `Bearer ${next.idToken}` }
        });
        if (!current()) return "";
        // A downstream userinfo rejection does not prove the refresh token invalid.
        if (!response.ok) throw new SsoKnownFailure("accountHttp", response.status);
        stage = "accountParse";
        let value: unknown;
        try { value = await response.json(); } catch { throw new SsoKnownFailure("accountJson"); }
        if (!current()) return "";
        const field = (key: string) => {
          const raw = readJsonPathValue(value, key);
          return typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
        };
        const user = {
          sub: field(userConfig.subPath), name: field(userConfig.namePath),
          email: field(userConfig.emailPath), avatarUrl: field(userConfig.avatarUrlPath)
        };
        if (!user.sub) throw new SsoKnownFailure("accountMissing");
        if (previous?.accountId && previous.accountId !== user.sub) throw new SsoKnownFailure("accountChanged");
        next.accountId = user.sub;
        stage = "saveCredentials";
        credentials.save(next);
        stage = "syncCookies";
        await syncAccessTokenCookies(next.idToken);
        if (!current()) return "";
        stage = "publishSession";
        const status = completeDesktopSsoRestoredBrowserSession(options.app, next.idToken, user);
        scheduleOidcRenewal(next.idToken);
        restoreState = "authenticated";
        oidcBlocked = false;
        options.getMainWindow()?.webContents.send("sso.statusChanged", status);
        publishRestoreResult({ state: "authenticated", status, accessToken: next.idToken });
        return next.idToken;
      } catch (error) {
        if (!current()) return "";
        const failure = describeSsoFailure(stage, error);
        safeConsoleError("SSO operation failed", { stage: failure.stage, code: failure.code, status: failure.status });
        oidcBlocked = true;
        const definitive = error instanceof SsoTokenRequestError && error.status === 401;
        const expired = desktopSsoIdTokenNeedsRefresh(options.app, 0);
        if (definitive || expired || !getDesktopSsoStatus(options.app).authenticated) {
          const status = definitive
            ? clearDesktopSsoLocalSession(options.app, t("sso.restoreSessionExpired"))
            : markDesktopSsoRestoreTemporarilyUnavailable(options.app, failure.message);
          restoreState = definitive ? "signed_out" : "temporarily_unavailable";
          removeIdTokenFile(options.app, definitive);
          await clearDesktopSsoAccessTokenCookies();
          if (definitive) await clearRestoredDesktopSsoCookies();
          options.getMainWindow()?.webContents.send("sso.statusChanged", status);
          publishRestoreResult({ state: restoreState, status });
        }
        // No response body or transport exception (which may contain credentials) crosses this boundary.
        throw new Error(failure.message);
      }
    })();
    const flight = operation.finally(() => {
      if (oidcFlight === flight) { oidcFlight = null; oidcAbort = null; }
    });
    oidcFlight = flight;
    return flight;
  }

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
    const ssoSession = options.session.defaultSession;
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

  async function probeBrowserUserInfo(signal: AbortSignal, bearerToken?: string) {
    const config = getDesktopSsoCookieUserInfoConfig(options.app);
    if (!config) {
      return undefined;
    }
    const ssoSession = options.session.defaultSession;
    const cookieHeader = await buildDesktopSsoCookieHeader(ssoSession, config.url);
    if (!cookieHeader && !bearerToken) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO browser userinfo cookie is missing.", 401);
    }
    const response = await ssoSession.fetch(config.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
      },
      ...(bearerToken ? { redirect: "manual" as const } : {}),
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
    const targetSessions = [options.session.defaultSession];
    await Promise.all(targetSessions.map(async (targetSession) => {
      await targetSession.cookies.flushStore();
      if (typeof targetSession.flushStorageData === "function") {
        await targetSession.flushStorageData();
      }
    }));
  }

  async function exchangeBrowserCookieAccessToken(
    fetchImpl?: CookieAccessTokenFetch,
    exchangeOptions: { signal?: AbortSignal; persist?: boolean; requireCookie?: boolean; syncCookies?: boolean; bearerToken?: string } = {}
  ) {
    if (currentOidcConfig()) return exchangeOidcTokens(true, fetchImpl);
    const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(options.app);
    if (!exchangeUrl) {
      return "";
    }
    const ssoSession = options.session.defaultSession;
    const bearerToken = exchangeOptions.bearerToken;
    const cookieHeader = bearerToken === undefined
      ? await buildDesktopSsoCookieHeader(ssoSession, exchangeUrl)
      : "";
    if (bearerToken !== undefined && !bearerToken.trim()) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO refresh token is missing.", 401);
    }
    if (!cookieHeader && exchangeOptions.requireCookie) {
      throw new DesktopSsoRestoreRequestError("Desktop SSO access-token exchange cookie is missing.", 401);
    }
    const accessTokenFetch = fetchImpl || ((url, init) => ssoSession.fetch(url, init));
    const request: CookieAccessTokenFetch = async (url, init) => {
      if (bearerToken !== undefined && url !== exchangeUrl && url !== getDesktopSsoCookieCSRFUrl(options.app)) {
        throw new Error("Desktop SSO token exchange destination changed.");
      }
      // Use one configured credential source. Stale browser cookies must not
      // override a restored Bearer session, including after a business 401.
      const headers = bearerToken === undefined ? init?.headers : {
        ...Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([key]) =>
          !["cookie", "authorization"].includes(key.toLowerCase()))),
        ...(url === exchangeUrl ? { Authorization: `Bearer ${bearerToken}` } : {})
      };
      return accessTokenFetch(url, {
        ...init,
        headers,
        ...(bearerToken !== undefined ? { credentials: "omit" as const, redirect: "manual" as const } : {}),
        ...(exchangeOptions.signal ? { signal: exchangeOptions.signal } : {})
      });
    };
    const accessToken = await exchangeConfiguredDesktopSsoCookieForAccessToken(
      options.app,
      cookieHeader,
      request,
      { persist: exchangeOptions.persist }
    );
    if (!accessToken) {
      return "";
    }
    if (exchangeOptions.syncCookies !== false) {
      await syncAccessTokenCookies(accessToken);
    }
    return accessToken;
  }

  async function syncAccessTokenCookies(accessToken: string) {
    const details = getDesktopSsoBusinessTokenCookieDetails(options.app, accessToken);
    await Promise.all(details.map((cookie) => options.session.defaultSession.cookies.set(cookie)));
    await flushDesktopSsoSessions();
  }

  async function clearRestoredDesktopSsoCookies() {
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
      await flushDesktopSsoSessions();
    } catch {
      // Cookie cleanup remains best effort after the canonical files are cleared.
    }
  }

  async function clearDesktopSsoAccessTokenCookies() {
    const targetSessions = [options.session.defaultSession];
    const cookieLookups = getDesktopSsoBusinessTokenCookieLookups(options.app);
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
    if (currentOidcConfig()) {
      prepareDesktopSsoSessionRestore(options.app);
      try { await exchangeOidcTokens(); } catch { /* Classified and published by the coordinator. */ }
      return { state: restoreState === "uninitialized" ? "signed_out" : restoreState, status: getDesktopSsoStatus(options.app) };
    }
    const wasTemporarilyUnavailable = restoreState === "temporarily_unavailable";
    const preparation = prepareDesktopSsoSessionRestore(options.app);
    console.info("[sso-restore] preparation", {
      requiresRemoteValidation: preparation.requiresRemoteValidation,
      clearCookies: preparation.clearCookies === true
    });
    if (preparation.clearCookies) {
      await clearRestoredDesktopSsoCookies();
    }
    if (!preparation.requiresRemoteValidation) {
      const result: DesktopSsoRestoreResult = {
        state: preparation.status.authenticated ? "authenticated" : "signed_out",
        status: preparation.status,
        ...(preparation.status.authenticated && getDesktopSsoBusinessToken()
          ? { accessToken: getDesktopSsoBusinessToken() || undefined }
          : {})
      };
      restoreState = result.state;
      return publishRestoreResult(result);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const restoreAuthMode = preparation.authMode || "cookie";
    let stage = "clear-derived-cookie";
    try {
      // Saved credentials remain private recovery candidates. Only explicitly
      // configured Bearer restoration may present the token to the login origin.
      const candidateToken = restoreAuthMode === "bearer" ? readDesktopSsoIdToken(options.app) : "";
      if (restoreAuthMode === "bearer" && !candidateToken) {
        throw new DesktopSsoRestoreRequestError("Desktop SSO restore token is missing.", 401);
      }
      await clearDesktopSsoAccessTokenCookies();
      stage = "session-probe";
      const browserSession = restoreAuthMode === "cookie"
        ? await probeBrowserSession(undefined, abortController.signal)
        : null;
      let exchangeStatus: number | undefined;
      stage = "token-exchange";
      const accessToken = await exchangeBrowserCookieAccessToken(async (url, init) => {
        const response = await options.session.defaultSession.fetch(url, init);
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
        ...(restoreAuthMode === "bearer" ? { bearerToken: candidateToken } : {}),
        requireCookie: restoreAuthMode === "cookie",
        syncCookies: restoreAuthMode === "cookie"
      });
      if (!accessToken) {
        throw new DesktopSsoRestoreRequestError("Desktop SSO access-token exchange returned no token.", exchangeStatus);
      }
      // Cookie recovery may need the newly exchanged token Cookie for userinfo.
      // Bearer recovery validates identity with the returned token before writing
      // that Cookie. Both keep canonical credentials unpublished until confirmed.
      stage = "userinfo-probe";
      const stableUserInfo = browserSession?.userInfo || await probeBrowserUserInfo(
        abortController.signal,
        restoreAuthMode === "bearer" ? accessToken : undefined
      );
      if (!stableUserInfo?.sub.trim()) {
        throw new Error("Desktop SSO restore did not return a stable user id.");
      }
      stage = "persist-session";
      if (restoreAuthMode === "bearer") {
        await syncAccessTokenCookies(accessToken);
      }
      const status = completeDesktopSsoRestoredBrowserSession(options.app, accessToken, stableUserInfo);
      console.info("[sso-restore] authenticated");
      const result: DesktopSsoRestoreResult = { state: "authenticated", status, accessToken };
      restoreState = result.state;
      if (wasTemporarilyUnavailable) {
        options.getMainWindow()?.webContents.send("sso.statusChanged", status);
      }
      return publishRestoreResult(result);
    } catch (error) {
      console.warn("[sso-restore] failed", {
        stage,
        httpStatus: error instanceof DesktopSsoRestoreRequestError ? error.status : undefined,
        errorType: error instanceof Error ? error.name : "unknown"
      });
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
    async retrySession() {
      if (!currentOidcConfig()) return getDesktopSsoStatus(options.app);
      if (restoreState === "signed_out") return getDesktopSsoStatus(options.app);
      oidcBlocked = false;
      try { await exchangeOidcTokens(); } catch { /* Return the classified public status only. */ }
      return getDesktopSsoStatus(options.app);
    },
    returnToApp() {
      focusMainWindowAfterDesktopSso(options);
    },
    broadcastStatus(status: DesktopSsoStatus) {
      if (status.authenticated && !status.pending) {
        restoreState = "authenticated";
        publishRestoreResult({
          state: "authenticated",
          status,
          ...(getDesktopSsoBusinessToken() ? { accessToken: getDesktopSsoBusinessToken() || undefined } : {})
        });
      } else if (!status.authenticated && !status.pending) {
        restoreState = "signed_out";
        publishRestoreResult({ state: "signed_out", status });
      }
      // Background renewal also publishes authenticated states. Only an explicit
      // login callback or return-to-app action may restore/focus the window.
      options.getMainWindow()?.webContents.send("sso.statusChanged", status);
    },
    async openBrowserUrl(input: {
      url: string;
      label?: string;
      browserOrigin?: string;
      resolveRedirect?: boolean;
    }) {
      const ssoSession = options.session.defaultSession;
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
      const ssoSession = options.session.defaultSession;
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
      const defaultSession = options.session.defaultSession;
      await Promise.all(cookieDetails.map((details) => defaultSession.cookies.set(details)));
      await flushDesktopSsoSessions();
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
      const ssoSession = options.session.defaultSession;
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
    async ensureBusinessToken(force = false, fetchImpl?: CookieAccessTokenFetch) {
      if (currentOidcConfig()) {
        if (!force && getDesktopSsoStatus(options.app).authenticated && !desktopSsoIdTokenNeedsRefresh(options.app)) {
          return getDesktopSsoBusinessToken() || "";
        }
        // Expiry must withdraw a previously published token even after the retry budget is exhausted.
        if (oidcBlocked && getDesktopSsoStatus(options.app).authenticated && desktopSsoIdTokenNeedsRefresh(options.app, 0)) {
          removeIdTokenFile(options.app, false);
          const status = markDesktopSsoRestoreTemporarilyUnavailable(options.app, t("sso.restoreTemporarilyUnavailable"));
          restoreState = "temporarily_unavailable";
          publishRestoreResult({ state: restoreState, status });
        }
        if (restoreState === "signed_out") return "";
        return exchangeOidcTokens(false, fetchImpl);
      }
      const status = getDesktopSsoStatus(options.app);
      if (!status.authenticated || !getDesktopSsoCookieAccessTokenExchangeUrl(options.app)) {
        return "";
      }
      if (!force && !desktopSsoIdTokenNeedsRefresh(options.app)) {
        return getDesktopSsoBusinessToken() || "";
      }
      if (accessTokenRefreshPromise) {
        return accessTokenRefreshPromise;
      }
      const previousToken = getDesktopSsoBusinessToken();
      const useBearer = loadDesktopSsoConfig(options.app).config?.sessionRestore?.authMode === "bearer";
      const isCurrentSession = () => getDesktopSsoBusinessToken() === previousToken &&
        getDesktopSsoStatus(options.app).updatedAt === status.updatedAt;
      const request = fetchImpl || ((url, init) => options.session.defaultSession.fetch(url, init));
      accessTokenRefreshPromise = exchangeBrowserCookieAccessToken(async (url, init) => {
        const response = await request(url, { ...init, redirect: "manual" });
        const httpStatus = response.status || 0;
        if ([401, 403, 204].includes(httpStatus) || (httpStatus >= 300 && httpStatus < 400)) {
          throw new DesktopSsoRestoreRequestError("Desktop SSO refresh rejected the upstream session.", response.status);
        }
        return response;
      }, {
        persist: false, syncCookies: false, signal: AbortSignal.timeout(5_000),
        ...(useBearer ? { bearerToken: previousToken || "" } : {})
      })
        .then(async (token) => {
          if (!isCurrentSession()) return "";
          if (!token) throw new Error("Desktop SSO refresh returned no access token.");
          await syncAccessTokenCookies(token);
          if (!isCurrentSession()) return "";
          persistDesktopSsoAccessToken(options.app, token);
          return token;
        })
        .catch(async (error: unknown) => {
          // A late refresh must not sign out a newly logged-in account.
          if (!isCurrentSession()) return "";
          const definitive = isDefinitiveRestoreFailure(error);
          // A business 401 can request renewal without proving the Desktop identity invalid.
          // Force bypasses the refresh schedule, not the validity of the current session.
          if (!definitive && !desktopSsoIdTokenNeedsRefresh(options.app, 0)) throw error;
          const nextStatus = definitive
            ? clearDesktopSsoLocalSession(options.app, t("sso.restoreSessionExpired"))
            : markDesktopSsoRestoreTemporarilyUnavailable(options.app, t("sso.restoreTemporarilyUnavailable"));
          restoreState = definitive ? "signed_out" : "temporarily_unavailable";
          options.getMainWindow()?.webContents.send("sso.statusChanged", nextStatus);
          publishRestoreResult({ state: restoreState, status: nextStatus });
          if (definitive) await clearRestoredDesktopSsoCookies();
          throw error;
        })
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
          ...(restoreState === "authenticated" && getDesktopSsoBusinessToken()
            ? { accessToken: getDesktopSsoBusinessToken() || undefined }
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
      if (currentOidcConfig() && oidcBlocked) return { state: restoreState === "uninitialized" ? "signed_out" as const : restoreState, status: getDesktopSsoStatus(options.app) };
      if (restoreState !== "temporarily_unavailable") {
        return {
          state: restoreState === "uninitialized"
            ? (getDesktopSsoStatus(options.app).authenticated ? "authenticated" : "signed_out")
            : restoreState,
          status: getDesktopSsoStatus(options.app),
          ...(getDesktopSsoBusinessToken() ? { accessToken: getDesktopSsoBusinessToken() || undefined } : {})
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
      const targetSessions = [options.session.defaultSession];
      await applyDesktopSsoSetCookieHeadersToSessions(
        targetSessions,
        [exchangeConfig.url, ...exchangeConfig.cookieOrigins],
        setCookieHeaders
      );
      await flushDesktopSsoSessions();
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
      const targetSessions = [options.session.defaultSession];
      await applyDesktopSsoSetCookieHeadersToSessions(
        targetSessions,
        [exchangeConfig.url, ...exchangeConfig.cookieOrigins],
        setCookieHeaders
      );
      await flushDesktopSsoSessions();
      if (typeof response.json !== "function") {
        return null;
      }
      const responseBody = await response.json();
      return createWebSessionClaims(getRecordValue(responseBody, "user"), exchangeConfig.url, exchangeConfig.claims);
    },
    async logoutWebSession(fetchImpl: WebSessionExchangeFetch = fetch as unknown as WebSessionExchangeFetch) {
      const oidcConfig = currentOidcConfig();
      if (oidcConfig) {
        desktopSsoRuntimeState.credentialGeneration++;
        oidcAbort?.abort();
        const url = oidcConfig.logoutUrl;
        if (!url) return false;
        const cookie = await buildDesktopSsoCookieHeader(options.session.defaultSession, url);
        const response = await options.session.defaultSession.fetch(url, {
          method: "GET", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(5_000),
          headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) }
        });
        if (response.status !== 401 && !response.ok && !(response.status >= 300 && response.status < 400)) {
          throw new Error(`SSO logout request failed (${response.status}).`);
        }
        return true;
      }
      const exchangeConfig = getDesktopSsoWebSessionExchangeConfig(options.app);
      if (!exchangeConfig) {
        return false;
      }
      const logoutUrl = new URL("/api/auth/logout", exchangeConfig.url).toString();
      const ssoSession = options.session.defaultSession;
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
      const defaultSession = options.session.defaultSession;
      await Promise.all(cookieDetails.map(async (details) => {
        try {
          await defaultSession.cookies.remove(details.url, details.name);
        } catch {
          // Cookie removal is best effort; local Desktop auth state is already cleared.
        }
      }));
      // The default Session also contains unrelated Website cookies. Only clear
      // configured identity origins, never enumerate and wipe the whole store.
      await clearRestoredDesktopSsoCookies();
    },
    async clearWebSessionCookies() {
      const clearCookies = getDesktopSsoWebSessionClearCookies(options.app);
      if (clearCookies.length === 0) {
        return;
      }
      const targetSessions = [options.session.defaultSession];
      await Promise.all(clearCookies.flatMap((details) =>
        targetSessions.map(async (targetSession) => {
          try {
            await targetSession.cookies.remove(details.url, details.name);
          } catch {
            // Cookie removal is best effort; local Desktop auth state is already cleared.
          }
        })
      ));
      await flushDesktopSsoSessions();
    }
  };
}
