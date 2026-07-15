import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { readInstalledRecords, removeInstalledRecord } from "./marketplace/common";
import { t } from "./i18n/main-i18n";
import {
  getPluginsRoot,
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServiceStateRoot
} from "./user-paths";

export const RETIRED_PLUGIN_IDS = [] as const;

const retiredPluginIdSet = new Set<string>(RETIRED_PLUGIN_IDS);

export function isRetiredPluginId(pluginId: string | null | undefined) {
  return Boolean(pluginId && retiredPluginIdSet.has(pluginId));
}

export function assertPluginNotRetired(pluginId: string) {
  if (isRetiredPluginId(pluginId)) {
    throw new Error(t("plugin.retired", { id: pluginId }));
  }
}

function removePathBestEffort(targetPath: string, warn: (message: string, error: unknown) => void) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    warn(`failed to remove retired plugin path: ${targetPath}`, error);
  }
}

export function cleanupRetiredPluginUserData(
  app: App,
  options: { warn?: (message: string, error: unknown) => void } = {}
) {
  const warn = options.warn ?? ((message, error) => console.warn(`[main] ${message}`, error));

  for (const pluginId of RETIRED_PLUGIN_IDS) {
    removePathBestEffort(path.join(getPluginsRoot(app), pluginId), warn);
    removePathBestEffort(getServiceConfigRoot(app, pluginId, "plugin"), warn);
    removePathBestEffort(getServiceDataRoot(app, pluginId, "plugin"), warn);
    removePathBestEffort(getServiceStateRoot(app, pluginId, "plugin"), warn);
    removePathBestEffort(getServiceLogsRoot(app, pluginId, "plugin"), warn);
    try {
      if (readInstalledRecords(app).some((record) => record.id === pluginId && record.type === "plugin")) {
        removeInstalledRecord(app, pluginId, "plugin");
      }
    } catch (error) {
      warn(`failed to remove retired plugin marketplace record: ${pluginId}`, error);
    }
  }
}

export const __testInternals = {};
