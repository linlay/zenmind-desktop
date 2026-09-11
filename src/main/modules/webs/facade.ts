import type { App } from "electron";
import type { WebappRuntimeState } from "../../../shared/contracts";
import type { WebsIntegrationPorts } from "./integration-ports";
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
  return {
    webappManager,
    webappRuntime,
    webappWindowManager,
    createDesktopMobileWebappCatalog: (app: App) =>
      createDesktopMobileWebappCatalog(app, ports, webappRuntime),
    readDesktopMobileWebappItem: (app: App, id: string) =>
      readDesktopMobileWebappItem(app, id, ports, webappRuntime),
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
