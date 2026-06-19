import type { App, BrowserWindow } from "electron";
import type { ServiceOpenLogViewerRequest } from "../../shared/contracts";
import { installDesktopConsoleLogTee } from "./desktop";
import { createLogStreamSubscriptionRegistry } from "./subscriptions";
import { LogViewerWindowController } from "./viewer-window";

export type LogsRuntimeOptions = {
  app: App;
  platform: NodeJS.Platform;
  preloadPath: string;
  routePath: string;
  getOwnerWindow: () => BrowserWindow | null;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
};

export function createLogsRuntime(options: LogsRuntimeOptions) {
  const logViewerWindowController = new LogViewerWindowController({
    preloadPath: options.preloadPath,
    routePath: options.routePath,
    platform: options.platform,
    getOwnerWindow: options.getOwnerWindow,
    loadRendererRoute: options.loadRendererRoute,
    onRendererError: options.onRendererError
  });
  const serviceLogSubscriptions = createLogStreamSubscriptionRegistry();
  const desktopLogSubscriptions = createLogStreamSubscriptionRegistry();

  return {
    installConsoleTee() {
      installDesktopConsoleLogTee(options.app);
    },
    openLogViewerWindow(request: ServiceOpenLogViewerRequest) {
      return logViewerWindowController.open(request);
    },
    closeLogViewerWindow() {
      return logViewerWindowController.close();
    },
    minimizeLogViewerWindow() {
      return logViewerWindowController.minimize();
    },
    maximizeLogViewerWindow() {
      return logViewerWindowController.maximize();
    },
    getLogViewerWindow() {
      return logViewerWindowController.getWindow();
    },
    getServiceLogSubscriptions() {
      return serviceLogSubscriptions;
    },
    getDesktopLogSubscriptions() {
      return desktopLogSubscriptions;
    },
    dispose() {
      serviceLogSubscriptions.clear();
      desktopLogSubscriptions.clear();
      logViewerWindowController.close();
    }
  };
}

export type LogsRuntime = ReturnType<typeof createLogsRuntime>;
