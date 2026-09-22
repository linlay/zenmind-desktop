import { hosts } from "./webclient-host-runtime";
import { ensureBrowserWebclient, getBrowserWebclientState, stopBrowserWebclient } from "./browser-webclient-runtime";
import { t } from "../../support/i18n/main-i18n";

interface BrowserWebclientIpcOptions {
  app: any;
  getMainWindow?: () => { webContents: any } | null;
  openBrowserExternal?: (url: string) => Promise<void>;
  platform?: NodeJS.Platform;
  getServiceState: (app: any, serviceId: string) => Promise<any>;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
}

export function registerBrowserWebclientIpc(ipcMain: any, options: BrowserWebclientIpcOptions) {
  function trusted(event: any) {
    const contents = options.getMainWindow?.()?.webContents;
    return contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  }
  ipcMain.handle("services.getBrowserWebclient", (event: any) => {
    if (!trusted(event)) throw new Error("Untrusted browser service caller");
    return getBrowserWebclientState();
  });
  ipcMain.handle("services.stopBrowserWebclient", async (event: any) => {
    if (!trusted(event)) return { ok: false, running: false, url: "", message: t("settings.localServices.browserOpenFailed") };
    return options.runServiceMutation(async () => ({ ok: true, ...await stopBrowserWebclient() }));
  });
  const startOrOpen = (open: boolean) => async (event: any) => {
    if (!trusted(event)) return { ok: false, running: false, url: "", message: t("settings.localServices.browserOpenFailed") };
    return options.runServiceMutation(async () => {
      try {
        if (!trusted(event)) throw new Error("Caller closed");
        const states = await Promise.all(["agent-platform", "agent-webclient"].map(id => options.getServiceState(options.app, id)));
        if (states.some(state => state.status !== "running")) {
          return { ok: false, ...getBrowserWebclientState(), message: t("settings.localServices.browserDependencies") };
        }
        const record = hosts.get("agent-webclient");
        if (!record || (open && !options.openBrowserExternal)) throw new Error("Browser service unavailable");
        if (open && !getBrowserWebclientState().running) throw new Error("Browser service stopped");
        const host = await ensureBrowserWebclient(record);
        if (!open) return { ok: true, ...getBrowserWebclientState() };
        const launchUrl = await host.launchUrl();
        if (!trusted(event) || hosts.get("agent-webclient") !== record || getBrowserWebclientState().url !== host.url) throw new Error("Browser launch cancelled");
        // Electron delegates to the OS default browser on both platforms; never invoke a shell command.
        if (options.platform === "win32") await options.openBrowserExternal!(launchUrl);
        else if (options.platform === "darwin") await options.openBrowserExternal!(launchUrl);
        else await options.openBrowserExternal!(launchUrl);
        return { ok: true, ...getBrowserWebclientState() };
      } catch {
        return { ok: false, ...getBrowserWebclientState(), message: t("settings.localServices.browserOpenFailed") };
      }
    });
  };
  ipcMain.handle("services.startBrowserWebclient", startOrOpen(false));
  ipcMain.handle("services.openBrowserWebclient", startOrOpen(true));
}
