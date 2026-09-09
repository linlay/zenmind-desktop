import {
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
  readDesktopSsoAccessToken,
  prepareDesktopSsoSessionRestore
} from "./oidc-sso";
import { getDesktopSsoBrowserUserAgent } from "../../infrastructure/electron/platform-adapter";
import { safeConsoleError } from "../../support/logging/safe-console";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";
import { t } from "../../support/i18n/main-i18n";
import { BrowserCookieFetch, BrowserOpenResult, CookieAccessTokenFetch, DesktopSsoControllerOptions, DesktopSsoRestoreRequestError, DesktopSsoRestoreResult, DesktopSsoStatus, EmbeddedLoginDialogOpenInput, WebSessionExchangeFetch, applyDesktopSsoSetCookieHeadersToSessions, buildDesktopSsoCookieHeader, createWebSessionClaims, focusMainWindowAfterDesktopSso, getDesktopSsoSetCookieHeaders, getRecordValue, mirrorDesktopSsoSetCookieHeaders, readDesktopSsoWebSessionExchangeError, resolveDesktopSsoNavigationUrl, rewriteDesktopSsoUrlOrigin } from "./sso-controller.part-1";

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
    exchangeOptions: { signal?: AbortSignal; persist?: boolean; requireCookie?: boolean; syncCookies?: boolean } = {}
  ) {
    const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(options.app);
    if (!exchangeUrl) {
      return "";
    }
    const ssoSession = options.session.defaultSession;
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
    if (exchangeOptions.syncCookies !== false) {
      await syncAccessTokenCookies(accessToken);
    }
    return accessToken;
  }

  async function syncAccessTokenCookies(accessToken: string) {
    const details = getDesktopSsoAccessTokenCookieDetails(options.app, accessToken);
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
        ...(preparation.status.authenticated && getDesktopSsoAccessToken()
          ? { accessToken: getDesktopSsoAccessToken() || undefined }
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
      const candidateToken = restoreAuthMode === "bearer" ? readDesktopSsoAccessToken(options.app) : "";
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
        const exchangeUrl = getDesktopSsoCookieAccessTokenExchangeUrl(options.app);
        const useBearer = restoreAuthMode === "bearer" && url === exchangeUrl;
        const response = await options.session.defaultSession.fetch(url, {
          ...init,
          ...(useBearer ? {
            headers: { ...init?.headers, Authorization: `Bearer ${candidateToken}` },
            redirect: "manual" as const
          } : {})
        });
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
