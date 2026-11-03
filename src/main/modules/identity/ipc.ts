import { safeConsoleError } from "../../support/logging/safe-console";
import { t } from "../../support/i18n/main-i18n";

export interface SsoIpcHandlerOptions {
  app: any;
  desktopSsoController: {
    broadcastStatus: (status: any) => void;
    returnToApp: () => void;
    retrySession?: () => Promise<any>;
    syncBrowserCookies: () => Promise<void>;
    exchangeBrowserCookieAccessToken: () => Promise<string>;
    exchangeWebSession: (idToken: string) => Promise<boolean>;
    exchangeWebSessionTicket?: (ticket: string) => Promise<any>;
    logoutWebSession?: () => Promise<boolean>;
    clearBrowserCookies: () => Promise<void>;
    clearWebSessionCookies: () => Promise<void>;
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
    onStatusChanged: (status: any) => void;
    onReturnToAppRequested: () => void;
  }) => Promise<any>;
  logoutDesktopSso: (app: any, options: {
    onStatusChanged: (status: any) => void;
  }) => Promise<any>;
  failDesktopSsoFlow: (message: string) => any;
  cancelDesktopSsoLogin: (app: any) => any;
  issueAgentAccessToken: (app: any, reason: any) => Promise<any> | any;
  stopTunnelHubRuntime?: () => Promise<unknown> | unknown;
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

  ipcMain.handle("sso.retrySession", async () => desktopSsoController.retrySession?.() || getDesktopSsoStatus(app));
  // Reading status never drives Identity network work; renderer status listeners would otherwise
  // turn every published status into another renewal. Identity's own schedule owns recovery.
  ipcMain.handle("sso.getStatus", async () => getDesktopSsoStatus(app));

  ipcMain.handle("agentAuth.issueAccessToken", async (_event: any, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });

  ipcMain.handle("sso.startLogin", async () => {
    const result = await startDesktopSsoLogin(app, {
      onBeforeStatusChanged: async (status: any, context?: { idToken?: string; ticket?: string }) => {
        if (status.authenticated) {
          if (context?.ticket) {
            return desktopSsoController.exchangeWebSessionTicket?.(context.ticket);
          }
          await desktopSsoController.syncBrowserCookies();
          await desktopSsoController.exchangeWebSession(context?.idToken || "");
        }
        return undefined;
      },
      onAfterStatusChanged: async (status: any) => {
        // Downstream services start from the single identity dispatcher once login is published.
        if (status.authenticated) {
          await desktopSsoController.exchangeBrowserCookieAccessToken();
        }
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
      await options.stopTunnelHubRuntime?.();
    } catch (error) {
      safeConsoleError("failed to stop Tunnel Hub during desktop sso logout", error);
    }
    try {
      await desktopSsoController.logoutWebSession?.();
    } catch (error) {
      safeConsoleError("failed to logout desktop sso web session", error);
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
    }
    await desktopSsoController.clearBrowserCookies();
    await desktopSsoController.clearWebSessionCookies();
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
