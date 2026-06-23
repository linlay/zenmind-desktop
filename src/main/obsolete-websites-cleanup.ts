import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDataRoot } from "./user-paths";

type CleanupTarget = {
  path: string;
  kind: "directory" | "file";
};

export type ObsoleteWebsitesCleanupResult = {
  removed: string[];
  failed: Array<{ path: string; message: string }>;
};

function obsoleteWebsiteTargets(dataRoot: string): CleanupTarget[] {
  return [
    { path: path.join(dataRoot, "data", "websites"), kind: "directory" },
    { path: path.join(dataRoot, "config", "websites"), kind: "directory" },
    { path: path.join(dataRoot, "state", "websites"), kind: "directory" },
    { path: path.join(dataRoot, "logs", "websites"), kind: "directory" },
    { path: path.join(dataRoot, "config", "desktop", "custom-sidebar-items.json"), kind: "file" },
    { path: path.join(dataRoot, "state", "webs", "migration.json"), kind: "file" }
  ];
}

export function cleanupObsoleteWebsitesLayout(app: App): ObsoleteWebsitesCleanupResult {
  const result: ObsoleteWebsitesCleanupResult = {
    removed: [],
    failed: []
  };

  for (const target of obsoleteWebsiteTargets(getDataRoot(app))) {
    if (!fs.existsSync(target.path)) {
      continue;
    }
    try {
      if (target.kind === "directory") {
        fs.rmSync(target.path, { recursive: true, force: true });
      } else {
        fs.rmSync(target.path, { force: true });
      }
      result.removed.push(target.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ path: target.path, message });
      console.warn(`[main] failed to remove obsolete websites path ${target.path}: ${message}`);
    }
  }

  return result;
}

export const __testInternals = {
  obsoleteWebsiteTargets
};
