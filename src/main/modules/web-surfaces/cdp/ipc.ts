import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRegistrationResult,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTargetStateRequest
} from "../../../../shared/embedded-cdp";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import { createEmbeddedCdpTargetId } from "./gateway";
import { session as electronSession } from "electron";
import { MAIN_CHAT_SURFACE_ID } from "../../../../shared/surface-identity";

type EmbeddedCdpIpcMain = {
  handle(channel: string, listener: (event: any, input: any) => unknown): void;
};

export function registerEmbeddedCdpIpcHandlers(
  ipcMain: EmbeddedCdpIpcMain,
  browserSurfaces: BrowserSurfaceRegistry,
  options: { isMainWindow(senderWebContentsId: number): boolean }
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
    (event, input: EmbeddedCdpSurfaceRegistration): EmbeddedCdpSurfaceRegistrationResult => {
      const isMainChat = input?.surfaceRole === "main-chat" ||
        (typeof input?.surfaceId === "string" && input.surfaceId.trim() === MAIN_CHAT_SURFACE_ID);
      // An auxiliary renderer must never claim Main Chat while the main guest
      // is remounting, even when the Registry temporarily has no owner.
      if (isMainChat && !options.isMainWindow(event.sender.id)) {
        return { ok: false, reason: "ownership_conflict" };
      }
      ensureOwnerCleanup(event.sender);
      return browserSurfaces.registerSurfaceResult(input, event.sender.id);
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
      const canonicalSurfaceId = snapshot.registered.surfaceId;
      return {
        ok: true,
        surfaceId: canonicalSurfaceId,
        activeTabId: snapshot.registered.activeTabId,
        targets: snapshot.tabs.map((tab) => ({
          tabId: tab.tabId,
          targetId: createEmbeddedCdpTargetId({
            surfaceId: canonicalSurfaceId,
            id: canonicalSurfaceId,
            targetGeneration: registrationId,
            label: snapshot.registered.label,
            url: snapshot.registered.url,
            surfaceKind: snapshot.registered.surfaceKind,
            surfaceRole: snapshot.registered.surfaceRole,
            surfaceLevel: snapshot.registered.surfaceLevel,
            ...(snapshot.registered.parentSurfaceId
              ? { parentSurfaceId: snapshot.registered.parentSurfaceId }
              : {}),
            interaction: snapshot.registered.interaction,
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
