import type {
  KanbanCloudConfig,
  KanbanCloudConfigResult,
  KanbanCurrentUser,
  KanbanSettingsInput,
  KanbanSettingsResult
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { getDesktopDeviceId, readDesktopSsoAccessTokenUser } from "../identity";
import { KanbanConnectionFallbackState, getKanbanConfigPath, getKanbanDeviceInfo, readKanbanCloudConfig, readKanbanSettings, resolveKanbanWsConnection, saveKanbanSettings, writeKanbanCloudConfig } from "./runtime-config";
import { KanbanRuntimeOptions } from "./runtime-options";
import {
  KanbanDesktopWsClient,
  type KanbanDesktopConnectionState
} from "./ws-client";

export interface RuntimeSettingsDependencies {
  refreshConnection(options?: { forceReconnect?: boolean }): void;
  commandReceiptRetryTimer: NodeJS.Timeout | null;
  connectionFallbackState: KanbanConnectionFallbackState;
  negotiatedContractVersion: string;
  negotiatedCapabilities: string[];
  readonly wsClient: Pick<KanbanDesktopWsClient, "stop" | "start" | "getState">;
  notifyChanged(): void;
  readonly options: Pick<KanbanRuntimeOptions, "app" | "canUseDesktopSsoCredentials">;
  connectionState: KanbanDesktopConnectionState;
}

export function start(dependencies: RuntimeSettingsDependencies) {
  dependencies.refreshConnection();
}

export function stop(dependencies: RuntimeSettingsDependencies) {
  if (dependencies.commandReceiptRetryTimer) {
    clearTimeout(dependencies.commandReceiptRetryTimer);
    dependencies.commandReceiptRetryTimer = null;
  }
  dependencies.connectionFallbackState = "disabled";
  dependencies.negotiatedContractVersion = "";
  dependencies.negotiatedCapabilities = [];
  dependencies.wsClient.stop();
}

export function refreshDeviceInfo(dependencies: RuntimeSettingsDependencies) {
  dependencies.refreshConnection({ forceReconnect: true });
  dependencies.notifyChanged();
}

export function getCloudConfig(dependencies: RuntimeSettingsDependencies): KanbanCloudConfigResult {
  dependencies.refreshConnection();
  return {
    ok: true,
    message: t("kanban.runtime.cloudConfigLoaded"),
    config: readKanbanCloudConfig(dependencies.options.app),
    configPath: getKanbanConfigPath(dependencies.options.app),
    connectionState: dependencies.connectionState
  };
}

export function getSettings(dependencies: RuntimeSettingsDependencies): KanbanSettingsResult {
  dependencies.refreshConnection();
  return {
    ok: true,
    message: t("kanban.runtime.settingsLoaded"),
    settings: readKanbanSettings(dependencies.options.app),
    configPath: getKanbanConfigPath(dependencies.options.app),
    connectionState: dependencies.connectionState
  };
}

export function saveCloudConfig(dependencies: RuntimeSettingsDependencies, input: KanbanCloudConfig): KanbanCloudConfigResult {
  const config = writeKanbanCloudConfig(dependencies.options.app, input);
  dependencies.refreshConnection({ forceReconnect: true });
  return {
    ok: true,
    message: config.serverUrl ? t("kanban.runtime.cloudConfigSavedReconnect") : t("kanban.runtime.cloudConfigSavedClosed"),
    config,
    configPath: getKanbanConfigPath(dependencies.options.app),
    connectionState: dependencies.connectionState
  };
}

export function saveSettings(dependencies: RuntimeSettingsDependencies, input: KanbanSettingsInput): KanbanSettingsResult {
  const settings = saveKanbanSettings(dependencies.options.app, input);
  dependencies.refreshConnection({ forceReconnect: true });
  const requestedEnable = input.enabled === true;
  return {
    ok: true,
    message: requestedEnable && !settings.enabled
      ? t("kanban.runtime.settingsNeedsCloudConfig")
      : settings.enabled
        ? t("kanban.runtime.settingsSaved")
        : t("kanban.runtime.disabled"),
    settings,
    configPath: getKanbanConfigPath(dependencies.options.app),
    connectionState: dependencies.connectionState
  };
}

export function currentUser(dependencies: RuntimeSettingsDependencies): KanbanCurrentUser {
  const user = dependencies.options.canUseDesktopSsoCredentials?.() === false
    ? null
    : readDesktopSsoAccessTokenUser(dependencies.options.app);
  if (user?.sub?.trim()) {
    return {
      id: user.sub.trim(),
      name: user.name?.trim() || user.email?.trim() || user.sub.trim(),
      email: user.email?.trim() || "",
      source: "sso"
    };
  }
  const deviceId = getDesktopDeviceId(dependencies.options.app);
  const deviceInfo = getKanbanDeviceInfo(dependencies.options.app);
  return {
    id: `device:${deviceId}`,
    name: deviceInfo.deviceName,
    email: "",
    source: "device"
  };
}

export function refreshConnection(dependencies: RuntimeSettingsDependencies, options: { forceReconnect?: boolean } = {}) {
  const resolution = resolveKanbanWsConnection(dependencies.options.app, dependencies.options.canUseDesktopSsoCredentials?.() !== false);
  dependencies.connectionFallbackState = resolution.fallbackState;
  dependencies.wsClient.start(resolution.config, options.forceReconnect ? { forceReconnect: true } : undefined);
  dependencies.connectionState = resolution.config ? dependencies.wsClient.getState() : resolution.fallbackState;
}
