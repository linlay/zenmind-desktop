import { type App } from "electron";
import { type ServiceId, type ServiceCommandResult } from "../../../../shared/contracts";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getService } from "../service-registry";
import { getServiceState } from "./service-state";
import { t } from "../../../support/i18n/main-i18n";
import { integrationPorts } from "./manager-contracts";
import { isHostManagedService } from "./host-policy";
import { stopAgentWebclientHost } from "../agent-webclient-host";
import { startedThisSession } from "./session-state";
import { attachServiceVerification } from "./verification";
import { runServiceCommand } from "./service-command";
import { getInstallDir, getServiceLayout } from "./layout";
import fs from "node:fs";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import { ensureManagedServiceStoppedForPlatform } from "./managed-cleanup";

export async function stopService(
  app: App,
  serviceId: ServiceId,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId, { integrationPorts: ports });
  if (service.serviceMode === "resource") {
    if (!current.installed) {
      return {
        ok: true,
        message: t("service.notInstalled", { name: service.name }),
        service: current
      };
    }
    if (current.status === "initialization-required" || current.status === "error") {
      return {
        ok: false,
        message: current.message,
        service: current
      };
    }
    if (current.status !== "running") {
      return {
        ok: true,
        message: t("service.notLoaded", { name: service.name }),
        service: current
      };
    }
    await integrationPorts(ports).stopPluginResources(app, service);
    const result = {
      ok: true,
      message: t("service.stopped", { name: service.name }),
      service: await getServiceState(app, serviceId, { integrationPorts: ports })
    } satisfies ServiceCommandResult;
    if (service.kind === "plugin") {
      integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: result.service });
    }
    return result;
  }
  if (!current.installed) {
    return {
      ok: true,
      message: t("service.notInstalled", { name: service.name }),
      service: current
    };
  }
  if (current.status !== "running") {
    return {
      ok: true,
      message: t("service.currentlyNotRunning", { name: service.name }),
      service: current
    };
  }

  if (isHostManagedService(service)) {
    await stopAgentWebclientHost(service.id);
    startedThisSession.delete(serviceId);
    const result = {
      ok: true,
      message: t("service.stopped", { name: service.name }),
      service: await getServiceState(app, serviceId, { integrationPorts: ports })
    } satisfies ServiceCommandResult;
    const verified = await attachServiceVerification(
      app,
      serviceId,
      result,
      "stopped",
      t("service.stopCommandExecuted", { name: service.name }),
      { integrationPorts: ports }
    );
    if (service.kind === "plugin" && verified.ok) {
      integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
    }
    return verified;
  }

  const result = await runServiceCommand(app, service, service.stopCommand, t("service.stopped", { name: service.name }), {
    refreshBuiltinAsset: false,
    commandKind: "stop",
    integrationPorts: ports
  });
  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const envPath = layout.envPath;
  const env = fs.existsSync(envPath) ? readEnvFile(envPath) : new Map<string, string>();
  const stopVerification = ensureManagedServiceStoppedForPlatform(service, layout, env);
  if (!stopVerification.ok) {
    throw new Error(stopVerification.message);
  }
  startedThisSession.delete(serviceId);

  const verified = await attachServiceVerification(
    app,
    serviceId,
    result,
    "stopped",
    t("service.stopCommandExecuted", { name: service.name }),
    { integrationPorts: ports }
  );
  if (service.kind === "plugin" && verified.ok) {
    integrationPorts(ports).emitPluginBridgeHook("plugin.stopped", { pluginId: service.id, service: verified.service });
  }
  return verified;
}
