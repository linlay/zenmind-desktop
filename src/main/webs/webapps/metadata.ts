import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WebappEntry, WebappSourceKind } from "../../../shared/contracts";
import { readInstalledRecords } from "../../marketplace/common";
import { getAllServices } from "../../services/service-registry";
import { getDesktopWebappsDataRoot, getServiceStateRoot } from "../../user-paths";
import { normalizeWebId } from "../common";

type PluginResourceOwnership = {
  webapps?: Record<string, { updatedAt: string }>;
};

function getPluginResourceOwnershipPath(app: App, pluginId: string) {
  return path.join(getServiceStateRoot(app, pluginId, "plugin"), "plugin-resources.json");
}

function readPluginResourceOwnership(app: App, pluginId: string): PluginResourceOwnership {
  try {
    return JSON.parse(fs.readFileSync(getPluginResourceOwnershipPath(app, pluginId), "utf8")) as PluginResourceOwnership;
  } catch {
    return {};
  }
}

function findPluginOwner(app: App, webappId: string) {
  for (const service of getAllServices()) {
    if (service.kind !== "plugin") {
      continue;
    }
    const ownership = readPluginResourceOwnership(app, service.id);
    if (ownership.webapps?.[webappId]) {
      return service;
    }
  }
  return null;
}

function createMetadata(
  sourceKind: WebappSourceKind,
  installPath: string,
  options: {
    sourceLabel?: string;
    sourceOwnerId?: string;
    removable: boolean;
  }
) {
  return {
    sourceKind,
    installPath,
    removable: options.removable,
    ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    ...(options.sourceOwnerId ? { sourceOwnerId: options.sourceOwnerId } : {})
  };
}

export function resolveWebappManagementMetadata(app: App, item: Pick<WebappEntry, "id">) {
  const installPath = path.join(getDesktopWebappsDataRoot(app), normalizeWebId(item.id));
  const pluginOwner = findPluginOwner(app, item.id);
  if (pluginOwner) {
    return createMetadata("plugin", installPath, {
      sourceLabel: pluginOwner.name || pluginOwner.id,
      sourceOwnerId: pluginOwner.id,
      removable: false
    });
  }

  const marketRecord = readInstalledRecords(app).find((record) =>
    record.id === item.id && record.type === "website-app"
  );
  if (marketRecord) {
    return createMetadata("market", installPath, {
      sourceLabel: marketRecord.source === "cloud" ? "Market" : "Local import",
      removable: true
    });
  }

  return createMetadata("local", installPath, {
    sourceLabel: "Local",
    removable: true
  });
}

export function withWebappManagementMetadata(app: App, item: WebappEntry): WebappEntry {
  return {
    ...item,
    ...resolveWebappManagementMetadata(app, item)
  };
}
