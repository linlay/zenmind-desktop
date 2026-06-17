import { safeConsoleError } from "../safe-console";
import { t } from "../i18n/main-i18n";

export interface SsoIpcHandlerOptions {
  app: any;
  desktopSsoController: {
    broadcastStatus: (status: any) => void;
    returnToApp: () => void;
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
    onStatusChanged: (status: any) => void;
    onReturnToAppRequested: () => void;
  }) => Promise<any>;
  logoutDesktopSso: (app: any, options: {
    onStatusChanged: (status: any) => void;
  }) => Promise<any>;
  failDesktopSsoFlow: (message: string) => any;
  cancelDesktopSsoLogin: (app: any) => any;
  issueAgentAccessToken: (app: any, reason: any) => Promise<any> | any;
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
          await desktopSsoController.exchangeBrowserCookieAccessToken();
          await desktopSsoController.exchangeWebSession(context?.idToken || "");
        }
        return undefined;
      },
      onStatusChanged: desktopSsoController.broadcastStatus,
      onReturnToAppRequested: desktopSsoController.returnToApp
    });
    if (result.ok && result.authorizeUrl) {
      const browserOpenResult = result.openMode === "system"
        ? await desktopSsoController.openSystemBrowserUrl({
          url: result.authorizeUrl,
          label: t("sso.googleLogin")
        })
        : await desktopSsoController.openEmbeddedLoginDialog({
          url: result.browserUrl || result.authorizeUrl,
          label: t("sso.iamLogin"),
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
    const result = await logoutDesktopSso(app, {
      onStatusChanged: desktopSsoController.broadcastStatus
    });
    await desktopSsoController.clearBrowserCookies();
    await desktopSsoController.clearWebSessionCookies();
    if (result.ok && result.logoutUrl) {
      const browserOpenResult = result.openMode === "system"
        ? await desktopSsoController.openSystemBrowserUrl({
          url: result.logoutUrl,
          label: t("sso.iamLogout")
        })
        : await desktopSsoController.openBrowserUrl({
          url: result.browserUrl || result.logoutUrl,
          label: t("sso.iamLogout"),
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
