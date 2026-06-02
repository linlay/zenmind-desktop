export interface SsoIpcHandlerOptions {
  app: any;
  desktopSsoController: {
    broadcastStatus: (status: any) => void;
    syncBrowserCookies: () => Promise<void>;
    exchangeBrowserCookieAccessToken: () => Promise<string>;
    clearBrowserCookies: () => Promise<void>;
    openBrowserUrl: (input: {
      url: string;
      label: string;
      browserOrigin?: string;
      resolveRedirect: boolean;
    }) => Promise<{ ok: boolean; message?: string }>;
  };
  getDesktopSsoStatus: (app: any) => any | Promise<any>;
  startDesktopSsoLogin: (app: any, options: {
    onBeforeStatusChanged: (status: any) => Promise<void>;
    onStatusChanged: (status: any) => void;
  }) => Promise<any>;
  logoutDesktopSso: (app: any, options: {
    onStatusChanged: (status: any) => void;
  }) => Promise<any>;
  failDesktopSsoFlow: (message: string) => any;
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
    issueAgentAccessToken
  } = options;

  ipcMain.handle("sso.getStatus", async () => getDesktopSsoStatus(app));

  ipcMain.handle("agentAuth.issueAccessToken", async (_event: any, reason: "missing" | "unauthorized") => {
    return issueAgentAccessToken(app, reason);
  });

  ipcMain.handle("sso.startLogin", async () => {
    const result = await startDesktopSsoLogin(app, {
      onBeforeStatusChanged: async (status: any) => {
        if (status.authenticated) {
          await desktopSsoController.syncBrowserCookies();
          await desktopSsoController.exchangeBrowserCookieAccessToken();
        }
      },
      onStatusChanged: desktopSsoController.broadcastStatus
    });
    if (result.ok && result.authorizeUrl) {
      const browserOpenResult = await desktopSsoController.openBrowserUrl({
        url: result.browserUrl || result.authorizeUrl,
        label: "IAM 登录",
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

  ipcMain.handle("sso.logout", async () => {
    const result = await logoutDesktopSso(app, {
      onStatusChanged: desktopSsoController.broadcastStatus
    });
    await desktopSsoController.clearBrowserCookies();
    if (result.ok && result.logoutUrl) {
      const browserOpenResult = await desktopSsoController.openBrowserUrl({
        url: result.browserUrl || result.logoutUrl,
        label: "IAM 登出",
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
