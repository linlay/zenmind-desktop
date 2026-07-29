import { safeConsoleError } from "../safe-console";
import { t } from "../i18n/main-i18n";
import { openDesktopSsoSiteTokenBridge } from "../sso-controller";

export interface SsoIpcHandlerOptions {
  app: any;
  desktopSsoController: {
    broadcastStatus: (status: any) => void;
    returnToApp: () => void;
    syncBrowserCookies: () => Promise<void>;
    exchangeBrowserCookieAccessToken: () => Promise<string>;
    refreshBrowserCookieAccessTokenIfNeeded?: (force?: boolean) => Promise<string>;
    exchangeWebSession: (idToken: string) => Promise<boolean>;
    exchangeWebSessionTicket?: (ticket: string) => Promise<any>;
    exchangeSiteTokenBridgeTicket?: (ticket: string) => Promise<any>;
    logoutWebSession?: () => Promise<boolean>;
    logoutSiteTokenBridge?: () => Promise<boolean>;
    clearBrowserCookies: () => Promise<void>;
    clearWebSessionCookies: () => Promise<void>;
    clearSiteTokenBridgeCookies?: () => Promise<void>;
    openBrowserUrl: (input: {
      url: string;
      label: string;
      browserOrigin?: string;
      resolveRedirect: boolean;
    }) => Promise<{ ok: boolean; message?: string }>;
    openEmbeddedLoginDialog: (input: {
      url: string;
      label: string;
      browserOrigin?: string;
      resolveRedirect: boolean;
    }) => Promise<{ ok: boolean; message?: string }>;
    openSystemBrowserUrl: (input: {
      url: string;
      label: string;
    }) => Promise<{ ok: boolean; message?: string }>;
  };
  getDesktopSsoStatus: (app: any) => any | Promise<any>;
  startDesktopSsoLogin: (app: any, options: {
    onBeforeStatusChanged: (status: any, context?: { idToken?: string; ticket?: string }) => Promise<any>;
    onAfterStatusChanged?: (status: any, context?: { idToken?: string; ticket?: string }) => Promise<void>;
    onSiteTokenBridgeTicket?: (ticket: string, context?: { required?: boolean }) => Promise<void>;
    onStatusChanged: (status: any) => void;
    onReturnToAppRequested: () => void;
  }) => Promise<any>;
  startDesktopSsoSiteTokenBridge?: (app: any) => any;
  logoutDesktopSso: (app: any, options: {
    onStatusChanged: (status: any) => void;
  }) => Promise<any>;
  failDesktopSsoFlow: (message: string) => any;
  cancelDesktopSsoLogin: (app: any) => any;
  issueAgentAccessToken: (app: any, reason: any) => Promise<any> | any;
  refreshKanbanConnection?: () => void;
  stopTunnelHubRuntime?: () => Promise<unknown> | unknown;
  refreshEnterpriseChat?: () => Promise<unknown> | unknown;
  stopEnterpriseChat?: () => Promise<unknown> | unknown;
}

export function registerSsoIpcHandlers(ipcMain: any, options: SsoIpcHandlerOptions) {
  const {
    app,
    desktopSsoController,
    getDesktopSsoStatus,
    startDesktopSsoLogin,
    logoutDesktopSso,
    failDesktopSsoFlow,
    cancelDesktopSsoLogin,
    issueAgentAccessToken
  } = options;

  ipcMain.handle("sso.getStatus", async () => {
    try {
      await desktopSsoController.refreshBrowserCookieAccessTokenIfNeeded?.();
    } catch (error) {
      safeConsoleError("failed to refresh desktop sso token while reading status", error);
    }
    return getDesktopSsoStatus(app);
  });

  ipcMain.handle("agentAuth.issueAccessToken", async (_event: any, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });

  ipcMain.handle("sso.startLogin", async () => {
    async function openConfiguredDesktopSsoSiteTokenBridge() {
      const bridgeStart = options.startDesktopSsoSiteTokenBridge?.(app);
      if (bridgeStart?.configured && bridgeStart.startUrl) {
        const bridgeOpenResult = await openDesktopSsoSiteTokenBridge(desktopSsoController, bridgeStart);
        if (!bridgeOpenResult.ok && bridgeStart.required) {
          throw new Error(bridgeOpenResult.message || bridgeStart.message || "Desktop SSO site token bridge open failed");
        }
        return true;
      }
      if (bridgeStart?.configured && bridgeStart.required) {
        throw new Error(bridgeStart.message || "Desktop SSO site token bridge is unavailable");
      }
      return false;
    }

    const result = await startDesktopSsoLogin(app, {
      onBeforeStatusChanged: async (status: any, context?: { idToken?: string; ticket?: string }) => {
        if (status.authenticated) {
          if (context?.ticket) {
            return desktopSsoController.exchangeWebSessionTicket?.(context.ticket);
          }
          await desktopSsoController.syncBrowserCookies();
          await desktopSsoController.exchangeBrowserCookieAccessToken();
          await desktopSsoController.exchangeWebSession(context?.idToken || "");
        }
        return undefined;
      },
      onAfterStatusChanged: async (status: any) => {
        if (status.authenticated) {
          const openedLegacyBridge = await openConfiguredDesktopSsoSiteTokenBridge();
          if (!openedLegacyBridge) {
            await desktopSsoController.exchangeBrowserCookieAccessToken();
          }
          options.refreshKanbanConnection?.();
          void Promise.resolve(options.refreshEnterpriseChat?.()).catch((error) => {
            safeConsoleError("failed to refresh enterprise chat after desktop sso login", error);
          });
        }
      },
      onSiteTokenBridgeTicket: async (ticket: string) => {
        const exchanged = await desktopSsoController.exchangeSiteTokenBridgeTicket?.(ticket);
        if (!exchanged) {
          throw new Error("Desktop SSO site token bridge exchange did not return a site token.");
        }
        options.refreshKanbanConnection?.();
      },
      onStatusChanged: desktopSsoController.broadcastStatus,
      onReturnToAppRequested: desktopSsoController.returnToApp
    });
    if (result.ok && result.authorizeUrl) {
      const browserOpenResult = result.openMode === "system"
        ? await desktopSsoController.openSystemBrowserUrl({
          url: result.authorizeUrl,
          label: result.browserLabel || t("sso.iamLogin")
        })
        : await desktopSsoController.openEmbeddedLoginDialog({
          url: result.browserUrl || result.authorizeUrl,
          label: result.browserLabel || t("sso.iamLogin"),
          browserOrigin: result.browserUrl ? undefined : result.browserOrigin,
          resolveRedirect: Boolean(result.browserUrl)
        });
      if (!browserOpenResult.ok) {
        const message = browserOpenResult.message || "Desktop SSO browser open failed";
        const status = failDesktopSsoFlow(message);
        desktopSsoController.broadcastStatus(status);
        return {
          ...result,
          ok: false,
          status,
          message
        };
      }
    }
    return result;
  });

  ipcMain.handle("sso.cancelLogin", async () => {
    const status = cancelDesktopSsoLogin(app);
    desktopSsoController.broadcastStatus(status);
    return {
      ok: true,
      status,
      message: status.message
    };
  });

  ipcMain.handle("sso.logout", async () => {
    try {
      await desktopSsoController.logoutWebSession?.();
    } catch (error) {
      safeConsoleError("failed to logout desktop sso web session", error);
    }
    try {
      await desktopSsoController.logoutSiteTokenBridge?.();
    } catch (error) {
      safeConsoleError("failed to logout desktop sso site token bridge", error);
    }
    const result = await logoutDesktopSso(app, {
      onStatusChanged: desktopSsoController.broadcastStatus
    });
    if (result.ok) {
      try {
        await options.stopEnterpriseChat?.();
      } catch (error) {
        safeConsoleError("failed to stop enterprise chat after desktop sso logout", error);
      }
      try {
        await options.stopTunnelHubRuntime?.();
      } catch (error) {
        safeConsoleError("failed to stop Tunnel Hub after desktop sso logout", error);
      }
    }
    await desktopSsoController.clearBrowserCookies();
    await desktopSsoController.clearWebSessionCookies();
    await desktopSsoController.clearSiteTokenBridgeCookies?.();
    if (result.ok && result.logoutUrl) {
      const browserOpenResult = result.openMode === "system"
        ? await desktopSsoController.openSystemBrowserUrl({
          url: result.logoutUrl,
          label: result.browserLabel || t("sso.iamLogout")
        })
        : await desktopSsoController.openBrowserUrl({
          url: result.browserUrl || result.logoutUrl,
          label: result.browserLabel || t("sso.iamLogout"),
          browserOrigin: result.browserUrl ? undefined : result.browserOrigin,
          resolveRedirect: false
        });
      if (!browserOpenResult.ok) {
        const message = browserOpenResult.message || "Desktop SSO browser open failed";
        const status = failDesktopSsoFlow(message);
        desktopSsoController.broadcastStatus(status);
        return {
          ...result,
          ok: false,
          status,
          message
        };
      }
    }
    return result;
  });
}
