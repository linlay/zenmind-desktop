import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { STORAGE_NAMESPACE } from "../shared/generated/brand";
import { readInstalledRecords, removeInstalledRecord } from "./marketplace/common";
import { t } from "./i18n/main-i18n";
import {
  getElectronUserDataRoot,
  getPluginsRoot,
  getSecretsRoot,
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServiceStateRoot
} from "./user-paths";

export const RETIRED_PLUGIN_IDS = ["pan-webclient"] as const;

const retiredPluginIdSet = new Set<string>(RETIRED_PLUGIN_IDS);
const retiredPanPrivateKeyFileNames = [
  "pan-app-private-key.pem",
  "pan-private-key.pem"
] as const;
const retiredPanPartitionNames = [
  `${STORAGE_NAMESPACE}-service-pan-webclient`,
  `${STORAGE_NAMESPACE}-plugin-settings-pan-webclient`
] as const;

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

  const secretsRoot = getSecretsRoot(app);
  for (const fileName of retiredPanPrivateKeyFileNames) {
    removePathBestEffort(path.join(secretsRoot, fileName), warn);
  }

  const partitionsRoot = path.join(getElectronUserDataRoot(app), "Partitions");
  for (const partitionName of retiredPanPartitionNames) {
    removePathBestEffort(path.join(partitionsRoot, partitionName), warn);
  }
}

export const __testInternals = {
  retiredPanPartitionNames,
  retiredPanPrivateKeyFileNames
};
