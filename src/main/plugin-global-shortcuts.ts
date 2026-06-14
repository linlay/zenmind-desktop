import type { globalShortcut as ElectronGlobalShortcut, App } from "electron";
import type { PluginGlobalShortcutStatus } from "../shared/contracts";
import { readPluginSettingsSnapshot } from "./plugin-settings";
import { getAllServices } from "./services/service-registry";

type GlobalShortcutRegistry = typeof ElectronGlobalShortcut;

type RefreshPluginGlobalShortcutOptions = {
  app: App;
  globalShortcut: GlobalShortcutRegistry;
  platform?: NodeJS.Platform;
  invokePluginAction: (serviceId: string, actionId: string) => void;
};

const registeredShortcuts = new Map<string, string>();
const shortcutStatuses = new Map<string, PluginGlobalShortcutStatus>();

function statusKey(pluginId: string, actionId: string) {
  return `${pluginId}:${actionId}`;
}

function statusFor(
  pluginId: string,
  actionId: string,
  settingKey: string,
  accelerator: string,
  patch: Pick<PluginGlobalShortcutStatus, "enabled" | "reason" | "message">
): PluginGlobalShortcutStatus {
  return {
    pluginId,
    actionId,
    settingKey,
    accelerator,
    ...patch
  };
}

export function getPluginGlobalShortcutStatuses(pluginId?: string) {
  const values = [...shortcutStatuses.values()];
  return pluginId ? values.filter((status) => status.pluginId === pluginId) : values;
}

export function unregisterPluginGlobalShortcuts(globalShortcut: GlobalShortcutRegistry) {
  for (const accelerator of registeredShortcuts.values()) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Ignore stale accelerator cleanup failures; a later refresh will report status.
    }
  }
  registeredShortcuts.clear();
}

export function refreshPluginGlobalShortcuts(options: RefreshPluginGlobalShortcutOptions) {
  unregisterPluginGlobalShortcuts(options.globalShortcut);
  shortcutStatuses.clear();
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";

  const claimedAccelerators = new Map<string, string>();
  for (const service of getAllServices()) {
    if (service.kind !== "plugin") {
      continue;
    }
    for (const action of service.desktop.actions) {
      const settingKey = action.globalShortcut?.settingKey;
      if (!settingKey) {
        continue;
      }

      let accelerator = "";
      try {
        const snapshot = readPluginSettingsSnapshot(
          options.app,
          service.id,
          [],
          isWindows ? "win32" : isMac ? "darwin" : "linux"
        );
        const value = snapshot.values[settingKey];
        accelerator = typeof value === "string" ? value.trim() : "";
      } catch (error) {
        shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
          service.id,
          action.id,
          settingKey,
          "",
          {
            enabled: false,
            reason: "settings-error",
            message: error instanceof Error ? error.message : String(error)
          }
        ));
        continue;
      }

      if (!accelerator) {
        shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
          service.id,
          action.id,
          settingKey,
          accelerator,
          {
            enabled: false,
            reason: "missing",
            message: "快捷键未设置。"
          }
        ));
        continue;
      }

      const claimedBy = claimedAccelerators.get(accelerator);
      if (claimedBy) {
        const previous = shortcutStatuses.get(claimedBy);
        if (previous?.enabled) {
          try {
            options.globalShortcut.unregister(previous.accelerator);
          } catch {
            // Ignore unregister failure and mark both actions as conflicted below.
          }
          registeredShortcuts.delete(claimedBy);
          shortcutStatuses.set(claimedBy, {
            ...previous,
            enabled: false,
            reason: "conflict",
            message: `快捷键与 ${service.name} / ${action.label} 冲突。`
          });
        }
        shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
          service.id,
          action.id,
          settingKey,
          accelerator,
          {
            enabled: false,
            reason: "conflict",
            message: "快捷键与其他插件动作冲突。"
          }
        ));
        continue;
      }
      claimedAccelerators.set(accelerator, statusKey(service.id, action.id));

      try {
        const registered = options.globalShortcut.register(accelerator, () => {
          options.invokePluginAction(service.id, action.id);
        });
        if (!registered) {
          shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
            service.id,
            action.id,
            settingKey,
            accelerator,
            {
              enabled: false,
              reason: "registration-failed",
              message: "系统拒绝注册该全局快捷键，可能已被系统或其他应用占用。"
            }
          ));
          continue;
        }
        registeredShortcuts.set(statusKey(service.id, action.id), accelerator);
        shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
          service.id,
          action.id,
          settingKey,
          accelerator,
          {
            enabled: true,
            message: "全局快捷键已启用。"
          }
        ));
      } catch (error) {
        shortcutStatuses.set(statusKey(service.id, action.id), statusFor(
          service.id,
          action.id,
          settingKey,
          accelerator,
          {
            enabled: false,
            reason: "invalid",
            message: error instanceof Error ? error.message : String(error)
          }
        ));
      }
    }
  }

  return getPluginGlobalShortcutStatuses();
}
