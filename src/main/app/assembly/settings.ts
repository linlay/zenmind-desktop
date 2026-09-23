import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import { EnterpriseChatRuntime, readEnterpriseImSettings } from "../../modules/enterprise-chat";
import {
  createDesktopSsoController
} from "../../modules/identity";
import { isDesktopPetSupportedPlatform, type DesktopPetRuntime } from "../../modules/pet";
import { createSettingsRuntime } from "../../modules/settings";
import { type AppShellRuntime } from "../../modules/shell";
import { createLogsRuntime } from "../../support/logging/runtime";
export interface AssembleSettingsRuntimeDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly petRuntime: Pick<DesktopPetRuntime, "getWindow" | "reloadSettings" | "getSettings">;
  readonly logsRuntime: Pick<ReturnType<typeof createLogsRuntime>, "getLogViewerWindow">;
  readonly buildApplicationMenu: AppShellRuntime["buildApplicationMenu"];
  readonly appShellRuntime: Pick<AppShellRuntime, "refreshTrayContextMenu">;
  readonly showDesktopPetWindow: DesktopPetRuntime["showWindow"];
  readonly hideDesktopPetWindow: DesktopPetRuntime["hideWindow"];
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "broadcastStatus">;
  readonly notifyServicesChanged: () => void;
  readonly emitKanbanChanged: () => void;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "refreshDesktopActionBridge">;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "reloadConfiguration">;
}

export function assembleSettingsRuntime(dependencies: AssembleSettingsRuntimeDependencies) {
  return createSettingsRuntime({
    app,
    platform: dependencies.startupPlatform,
    getMainWindow: dependencies.getMainWindow,
    getDesktopPetWindow: dependencies.petRuntime.getWindow,
    getLogViewerWindow: () => dependencies.logsRuntime.getLogViewerWindow(),
    buildApplicationMenu: dependencies.buildApplicationMenu,
    refreshTrayContextMenu: () => dependencies.appShellRuntime.refreshTrayContextMenu(),
    reloadDesktopPetSettings: dependencies.petRuntime.reloadSettings,
    getDesktopPetEnabled: () => dependencies.petRuntime.getSettings()?.enabled === true,
    isDesktopPetSupported: () => isDesktopPetSupportedPlatform(dependencies.startupPlatform),
    showDesktopPetWindow: () => dependencies.showDesktopPetWindow(),
    hideDesktopPetWindow: () => dependencies.hideDesktopPetWindow(),
    broadcastDesktopSsoStatus: (status) => dependencies.desktopSsoController.broadcastStatus(status),
    notifyServicesChanged: dependencies.notifyServicesChanged,
    emitKanbanChanged: dependencies.emitKanbanChanged,
    refreshDesktopActionBridge: () => dependencies.assistantBridgeRuntime.refreshDesktopActionBridge(),
    refreshEnterpriseChat: () => {
      void dependencies.enterpriseChatRuntime.reloadConfiguration(readEnterpriseImSettings(app, dependencies.startupPlatform).enabled);
    }
  });
}

