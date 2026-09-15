import type { App } from "electron";
import type { ServicesFacade } from "../services";
import type { WebappManager } from "../webs";
import { installPluginFromArchive, uninstallPlugin } from "./loader";

export type PluginLifecycleServices = Pick<
  ServicesFacade,
  "initializeService" | "getServiceState" | "stopService"
>;

export function createPluginLifecycle(services: PluginLifecycleServices, webapps: WebappManager) {
  return {
    installFromArchive: (app: App, archivePath: string) =>
      installPluginFromArchive(app, archivePath, services.initializeService),
    uninstall: (app: App, serviceId: string) =>
      uninstallPlugin(app, serviceId, services, webapps)
  };
}

export type PluginLifecycle = ReturnType<typeof createPluginLifecycle>;
