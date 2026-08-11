import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTargetStateRequest
} from "../../shared/embedded-cdp";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import { createEmbeddedCdpTargetId } from "../embedded-cdp-gateway";
import { session as electronSession } from "electron";

type EmbeddedCdpIpcMain = {
  handle(channel: string, listener: (event: any, input: any) => unknown): void;
};

export function registerEmbeddedCdpIpcHandlers(
  ipcMain: EmbeddedCdpIpcMain,
  browserSurfaces: BrowserSurfaceRegistry
) {
  const ownersWithCleanup = new Set<number>();

  function ensureOwnerCleanup(sender: {
    id: number;
    once?: (eventName: string, listener: () => void) => unknown;
  }) {
    if (ownersWithCleanup.has(sender.id)) {
      return;
    }
    ownersWithCleanup.add(sender.id);
    sender.once?.("destroyed", () => {
      ownersWithCleanup.delete(sender.id);
      browserSurfaces.unregisterSurfacesForOwner(sender.id);
    });
  }

  ipcMain.handle(
    "chatWorkPanel.clearSession",
    async (_event, input: { partition?: unknown }) => {
      const partition = typeof input?.partition === "string" ? input.partition.trim() : "";
      if (!/^chat-work-panel-[a-z0-9-]+$/iu.test(partition) || partition.startsWith("persist:")) {
        return { ok: false };
      }
      const targetSession = electronSession.fromPartition(partition);
      await Promise.all([
        targetSession.clearStorageData(),
        targetSession.clearCache(),
        targetSession.clearAuthCache()
      ]);
      return { ok: true };
    }
  );

  ipcMain.handle(
    "embeddedCdp.registerSurface",
    (event, input: EmbeddedCdpSurfaceRegistration) => {
      ensureOwnerCleanup(event.sender);
      return {
        ok: browserSurfaces.registerSurface(input, event.sender.id)
      };
    }
  );

  ipcMain.handle(
    "embeddedCdp.getSurfaceTargetState",
    (event, input: EmbeddedCdpSurfaceTargetStateRequest) => {
      const surfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
      const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
      const snapshot = browserSurfaces.getRegisteredSurfaceSnapshot(surfaceId, registrationId, event.sender.id);
      if (!snapshot) {
        return { ok: false };
      }
      return {
        ok: true,
        surfaceId,
        activeTabId: snapshot.registered.activeTabId,
        targets: snapshot.tabs.map((tab) => ({
          tabId: tab.tabId,
          targetId: createEmbeddedCdpTargetId({
            id: surfaceId,
            targetGeneration: registrationId,
            label: snapshot.registered.label,
            url: snapshot.registered.url,
            surfaceKind: snapshot.registered.surfaceKind,
            open: true
          }, tab),
          currentUrl: tab.currentUrl,
          title: tab.title,
          isLoading: tab.isLoading
        }))
      };
    }
  );

  ipcMain.handle(
    "embeddedCdp.unregisterSurface",
    (event, input: EmbeddedCdpSurfaceRemoval) => ({
      ok: browserSurfaces.unregisterSurface(input, event.sender.id)
    })
  );
}
