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

function findWebapp(items: WebappEntry[], id: string) {
  const normalizedId = id.trim();
  return items.find((item) => item.id === normalizedId) ?? null;
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
      )
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

  try {
    if (readWebappPublishState(app, target.id)?.active === true) {
      const unpublished = await unpublishWebapp(app, target.id);
      if (!unpublished.ok) {
        return {
          ok: false,
          item: target,
          items,
          message: `Stop Tunnel publishing before removing this WebApp: ${unpublished.message}`
        };
      }
    }
    await webappRuntime.stop(app, target.id, t("webapp.deleted", { label: target.label })).catch(() => undefined);
    fs.rmSync(target.installPath || getWebappDir(app, target.id), { recursive: true, force: true });
    fs.rmSync(getDesktopWebappDataRoot(app, target.id), { recursive: true, force: true });
    fs.rmSync(getDesktopWebappStateRoot(app, target.id), { recursive: true, force: true });
    fs.rmSync(getDesktopWebappLogsRoot(app, target.id), { recursive: true, force: true });
    if (target.sourceKind === "market") {
      removeInstalledRecord(app, target.id, "website-app");
    }
    return {
      ok: true,
      item: target,
      items: readWebappItems(app),
      message: t("webapp.deleted", { label: target.label })
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
