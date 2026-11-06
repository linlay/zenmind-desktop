import type { App } from "electron";
import { serializePluginOperation } from "./lifecycle-queue";
import type { ServicesFacade } from "../services";
import type { WebappManager } from "../webs";
import type { PluginEngineHost, PluginInstallSource } from "./agent-engines";
import { getAgentEngineSync } from "./engine-resources";
import { installPluginFromArchive, uninstallPlugin } from "./loader";

export type PluginLifecycleServices = Pick<
  ServicesFacade,
  "initializeService" | "getServiceState" | "stopService"
>;

export function createPluginLifecycle(services: PluginLifecycleServices, webapps: WebappManager, engineHost?: PluginEngineHost) {
  return {
    installFromArchive: (app: App, archivePath: string, source?: PluginInstallSource) =>
      serializePluginOperation(app, async () => {
        const result = await installPluginFromArchive(app, archivePath, services.initializeService, engineHost, source);
        if (result.ok) await getAgentEngineSync(app)?.installed(result.serviceId);
        return result;
      }),
    uninstall: (app: App, serviceId: string) =>
      serializePluginOperation(app, () => uninstallPlugin(app, serviceId, services, webapps, engineHost))
  };
}

export type PluginLifecycle = ReturnType<typeof createPluginLifecycle>;
