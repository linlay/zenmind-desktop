import type { App } from "electron";
import type { ServiceCommandResult, ServiceState } from "../../../shared/contracts";
import { emitPluginBridgeHook } from "./bridge";
import { getService } from "../services";
import { t } from "../../support/i18n/main-i18n";

export async function invokePluginDesktopAction({
  app,
  serviceId,
  actionId,
  getServiceState,
  handleServiceStart
}: {
  app: App;
  serviceId: string;
  actionId: string;
  getServiceState: (app: App, serviceId: string) => Promise<ServiceState>;
  handleServiceStart: (serviceId: string) => Promise<ServiceCommandResult>;
}): Promise<ServiceCommandResult> {
  const service = getService(String(serviceId || ""));
  if (service.kind !== "plugin") {
    throw new Error(`service ${serviceId} is not a plugin`);
  }
  const action = service.desktop.actions.find((item) => item.id === String(actionId || "").trim());
  if (!action) {
    throw new Error(`unknown plugin action: ${actionId}`);
  }
  let current = await getServiceState(app, service.id);
  if (action.requiresRunning && current.status !== "running") {
    const startResult = await handleServiceStart(service.id);
    if (!startResult.ok) {
      return startResult;
    }
    current = startResult.service ?? await getServiceState(app, service.id);
  }
  emitPluginBridgeHook(`plugin.actionInvoked:${action.id}`, {
    pluginId: service.id,
    actionId: action.id
  });
  return {
    ok: true,
    message: t("pluginActions.executed", { serviceName: service.name, actionLabel: action.label }),
    service: current
  };
}
