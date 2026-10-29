import type { App } from "electron";
import type { WebappRuntimeState } from "../../../shared/contracts";
import type { WebsIntegrationPorts } from "./integration-ports";
import type { ShareServicePort } from "../../support/share-ports";
import { createWebappShareReceivers } from "./webapps/share-receiver";
import { createPublishedWebappShare } from "./webapps/share-publish";
import { t } from "../../support/i18n/main-i18n";
import { disposeWebappInstallation, type WebappDisposalTarget } from "./webapps/actions";
import { createWebappManager } from "./webapps/manager";
import {
  createDesktopMobileWebappCatalog,
  readDesktopMobileWebappItem
} from "./webapps/mobile-catalog";
import { restorePublishedWebapps } from "./webapps/publication-runtime";
import {
  getWebappPublishStatus,
  publishWebapp,
  unpublishWebapp
} from "./webapps/publisher";

export function createWebsFacade(ports: WebsIntegrationPorts) {
  const webappManager = createWebappManager(ports);
  const webappRuntime = webappManager.runtime;
  const webappWindowManager = webappManager.windowManager;
  let shareReceivers: ReturnType<typeof createWebappShareReceivers> | undefined;
  let shares: ShareServicePort | undefined;
  return {
    webappManager,
    webappRuntime,
    webappWindowManager,
    configureShares(app: App, service: ShareServicePort, open: (id: string, signal: AbortSignal) => Promise<void>) {
      shares = service;
      shareReceivers?.dispose();
      shareReceivers = createWebappShareReceivers({
        shares: service, open, listInstalled: () => webappManager.listInstalled(app), getState: id => webappRuntime.getStatus(app, id),
        onError: () => console.warn("[webapp] share receiver registration failed"),
      });
      shareReceivers.sync();
    },
    syncShareReceivers: () => shareReceivers?.sync(),
    sharePublishedWebapp(app: App, id: unknown) {
      if (!shares) return Promise.resolve({ ok: false as const, message: t("webapp.shareUnavailable") });
      return createPublishedWebappShare(app, shares, id, ports);
    },
    receiveSharedContext: (id: string, action: string, input: Record<string, unknown>, signal: AbortSignal | undefined) => {
      if (!shareReceivers) throw new Error("WebApp share receivers are unavailable");
      return shareReceivers.handle(id, action, input, signal);
    },
    disposeShareReceivers: () => shareReceivers?.dispose(),
    createDesktopMobileWebappCatalog: (app: App) =>
      createDesktopMobileWebappCatalog(app, ports, webappManager),
    readDesktopMobileWebappItem: (app: App, id: string) =>
      readDesktopMobileWebappItem(app, id, ports, webappManager),
    restorePublishedWebapps: (app: App) =>
      restorePublishedWebapps(app, ports, webappRuntime),
    getWebappPublishStatus: (app: App, id: string) =>
      getWebappPublishStatus(app, id, ports),
    publishWebapp: (app: App, id: string, runtime: WebappRuntimeState | null) =>
      publishWebapp(app, id, runtime, ports),
    unpublishWebapp: (app: App, id: string) => unpublishWebapp(app, id, ports),
    disposeWebappInstallation: (
      app: App,
      target: WebappDisposalTarget,
      stopMessage: string
    ) => disposeWebappInstallation(app, target, stopMessage, ports, {
      runtime: webappRuntime,
      windowManager: webappWindowManager
    })
  };
}

export type WebsFacade = ReturnType<typeof createWebsFacade>;
