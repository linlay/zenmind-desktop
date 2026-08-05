import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import type { App } from "electron";
import type { WebappDeleteResult, WebappEntry, WebappExportResult, WebappResult, WebappUpdateInput } from "../../../shared/contracts";
import { t } from "../../i18n/main-i18n";
import { removeInstalledRecord } from "../../marketplace/common";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappLogsRoot,
  getDesktopWebappStateRoot
} from "../../user-paths";
import { isRecord, readString } from "../common";
import { getWebappDir, readWebappItems, writeWebappPreferenceFields } from "./store";
import { webappRuntime } from "./runtime";
import { unpublishWebapp } from "./publisher";
import { webappWindowManager } from "./window-manager";

function findWebapp(items: WebappEntry[], id: string) {
  const normalizedId = id.trim();
  return items.find((item) => item.id === normalizedId) ?? null;
}

async function addWebappDirectoryToZip(
  zip: JSZip,
  rootPath: string,
  currentPath: string = rootPath
): Promise<void> {
  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(currentPath, entry.name);
    const archivePath = path.relative(rootPath, sourcePath).split(path.sep).join("/");
    const stat = await fs.promises.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`WebApp package contains a symbolic link: ${archivePath}`);
    }
    if (stat.isDirectory()) {
      if ((await fs.promises.readdir(sourcePath)).length === 0) {
        zip.folder(`${archivePath}/`);
      }
      await addWebappDirectoryToZip(zip, rootPath, sourcePath);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`WebApp package contains an unsupported file type: ${archivePath}`);
    }
    zip.file(archivePath, await fs.promises.readFile(sourcePath), {
      unixPermissions: stat.mode & 0o777
    });
  }
}

export async function exportWebappArchive(
  app: App,
  id: string,
  archivePath: string
): Promise<WebappExportResult> {
  const item = findWebapp(readWebappItems(app), id);
  if (!item) {
    return {
      ok: false,
      item: null,
      path: archivePath,
      message: t("webapp.notFound")
    };
  }

  const installPath = item.installPath || getWebappDir(app, item.id);
  try {
    const zip = new JSZip();
    await addWebappDirectoryToZip(zip, installPath);
    await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
    await pipeline(
      zip.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        platform: "UNIX",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      }),
      fs.createWriteStream(archivePath, { mode: 0o600 })
    );
    return {
      ok: true,
      item,
      path: archivePath,
      message: t("webapp.exported", { label: item.label })
    };
  } catch (error) {
    await fs.promises.rm(archivePath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      item,
      path: archivePath,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export type WebappDisposalTarget = {
  id: string;
  label: string;
  installPath?: string;
  removeMarketRecord?: boolean;
};

export async function disposeWebappInstallation(
  app: App,
  target: WebappDisposalTarget,
  stopMessage: string
) {
  const releaseDisposal = webappWindowManager.beginDisposal(target.id, { closeImmediately: false });
  try {
    const unpublished = await unpublishWebapp(app, target.id);
    if (!unpublished.ok) {
      return {
        ok: false,
        message: `Stop Tunnel publishing before removing ${target.label}: ${unpublished.message}`
      };
    }
    const stopped = await webappRuntime.stop(app, target.id, stopMessage);
    if (!stopped.ok) {
      return {
        ok: false,
        message: `Unable to remove ${target.label}: ${stopped.message}`
      };
    }
    webappWindowManager.closeForDisposal(target.id);
    fs.rmSync(target.installPath || getWebappDir(app, target.id), {
      recursive: true,
      force: true
    });
    fs.rmSync(getDesktopWebappDataRoot(app, target.id), { recursive: true, force: true });
    fs.rmSync(getDesktopWebappStateRoot(app, target.id), { recursive: true, force: true });
    fs.rmSync(getDesktopWebappLogsRoot(app, target.id), { recursive: true, force: true });
    if (target.removeMarketRecord) {
      removeInstalledRecord(app, target.id, "website-app");
    }
    webappRuntime.emitLifecycleChange("removed", target.id);
    return { ok: true, message: stopMessage };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    releaseDisposal();
  }
}

export function listWebappItems(app: App) {
  return {
    ok: true,
    items: readWebappItems(app),
    message: t("webapp.listRead")
  };
}

export function updateWebappItem(app: App, id: string, input: WebappUpdateInput): WebappResult {
  const items = readWebappItems(app);
  const target = findWebapp(items, id);
  if (!target) {
    return {
      ok: false,
      item: null,
      items,
      message: t("webapp.notFound")
    };
  }

  try {
    const rawInput = isRecord(input) ? input : {};
    const updated = writeWebappPreferenceFields(app, target.id, {
      ...(typeof input.label === "string" ? { label: input.label } : {}),
      ...(
        typeof input.copilotAgentKey === "string" || typeof rawInput.agentKey === "string"
          ? { copilotAgentKey: readString(input.copilotAgentKey) || readString(rawInput.agentKey) }
          : {}
      ),
      ...(input.openMode === "workspace" || input.openMode === "dialog"
        ? { openMode: input.openMode }
        : {})
    });
    const nextItems = readWebappItems(app);
    return {
      ok: true,
      item: updated,
      items: nextItems,
      message: t("webapp.updated", { label: updated.label })
    };
  } catch (error) {
    return {
      ok: false,
      item: target,
      items,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function removeWebappItem(app: App, id: string): Promise<WebappDeleteResult> {
  const items = readWebappItems(app);
  const target = findWebapp(items, id);
  if (!target) {
    return {
      ok: false,
      item: null,
      items,
      message: t("webapp.notFound")
    };
  }

  if (target.removable === false) {
    return {
      ok: false,
      item: target,
      items,
      message: t("webapp.managedNotRemovable", { label: target.label })
    };
  }

  const message = t("webapp.deleted", { label: target.label });
  const disposed = await disposeWebappInstallation(
    app,
    {
      id: target.id,
      label: target.label,
      installPath: target.installPath,
      removeMarketRecord: target.sourceKind === "market"
    },
    message
  );
  if (!disposed.ok) {
    return {
      ok: false,
      item: target,
      items,
      message: disposed.message
    };
  }
  return {
    ok: true,
    item: target,
    items: readWebappItems(app),
    message
  };
}
