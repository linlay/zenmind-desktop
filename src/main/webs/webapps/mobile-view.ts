import type { App } from "electron";
import type {
  DesktopMobileWebappAvailability,
  DesktopMobileWebappItem,
  WebappEntry,
  WebappPublishState,
  WebappPublishStatus,
  WebappRuntimeState,
  WebappRuntimeStatus
} from "../../../shared/contracts";
import { applyWebOrder } from "../order-store";
import { readWebItems } from "../store";

export function readOrderedWebappItems(app: App) {
  return applyWebOrder(app, readWebItems(app)).filter((item): item is WebappEntry => item.kind === "webapp");
}

function resolvePublishStatus(state: WebappPublishState | null): WebappPublishStatus {
  return state?.status ?? "not-configured";
}

function resolveAvailability(input: {
  runtimeStatus: WebappRuntimeStatus;
  publishStatus: WebappPublishStatus;
  published: boolean;
  tunnelConnected: boolean;
}): DesktopMobileWebappAvailability {
  if (input.publishStatus === "publishing") {
    return "publishing";
  }
  if (input.publishStatus === "error") {
    return "publish-error";
  }
  if (!input.published) {
    return "not-published";
  }
  if (input.runtimeStatus !== "running") {
    return "webapp-stopped";
  }
  if (!input.tunnelConnected) {
    return "desktop-offline";
  }
  return "available";
}

export function createDesktopMobileWebappItem(input: {
  entry: WebappEntry;
  order: number;
  runtime: WebappRuntimeState | null;
  publishState: WebappPublishState | null;
  tunnelConnected: boolean;
}): DesktopMobileWebappItem {
  const runtimeStatus = input.runtime?.status ?? "stopped";
  const publishStatus = resolvePublishStatus(input.publishState);
  const publicUrl = input.publishState?.active === true && /^https:\/\//iu.test(input.publishState.url)
    ? input.publishState.url
    : "";
  const availability = resolveAvailability({
    runtimeStatus,
    publishStatus,
    published: Boolean(publicUrl),
    tunnelConnected: input.tunnelConnected
  });
  return {
    id: input.entry.id,
    label: input.entry.label,
    order: input.order,
    createdAt: input.entry.createdAt,
    updatedAt: input.entry.updatedAt,
    runtimeStatus,
    publishStatus,
    available: availability === "available",
    publicUrl,
    availability
  };
}

export function findOrderedWebapp(app: App, id: string) {
  const items = readOrderedWebappItems(app);
  const order = items.findIndex((item) => item.id === id.trim());
  return order < 0 ? null : { entry: items[order], order };
}
