import fs from "node:fs";
import type { App } from "electron";
import type { WebappDeleteResult, WebappEntry, WebappResult, WebappUpdateInput } from "../../../shared/contracts";
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
import { readWebappPublishState, unpublishWebapp } from "./publisher";
import { webappWindowManager } from "./window-manager";

function findWebapp(items: WebappEntry[], id: string) {
  const normalizedId = id.trim();
  return items.find((item) => item.id === normalizedId) ?? null;
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
  const releaseDisposal = webappWindowManager.beginDisposal(target.id);
  try {
    if (readWebappPublishState(app, target.id)?.active === true) {
      const unpublished = await unpublishWebapp(app, target.id);
      if (!unpublished.ok) {
        return {
          ok: false,
          message: `Stop Tunnel publishing before removing ${target.label}: ${unpublished.message}`
        };
      }
    }
    const stopped = await webappRuntime.stop(app, target.id, stopMessage);
    if (!stopped.ok) {
      return {
        ok: false,
        message: `Unable to remove ${target.label}: ${stopped.message}`
      };
    }
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
