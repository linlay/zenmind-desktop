import type {
  EmbeddedCdpSiteSurfaceRegistration,
  EmbeddedCdpSiteSurfaceRemoval
} from "../../shared/embedded-cdp";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";

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
      browserSurfaces.unregisterSiteSurfacesForOwner(sender.id);
    });
  }

  ipcMain.handle(
    "embeddedCdp.registerSiteSurface",
    (event, input: EmbeddedCdpSiteSurfaceRegistration) => {
      ensureOwnerCleanup(event.sender);
      return {
        ok: browserSurfaces.registerSiteSurface(input, event.sender.id)
      };
    }
  );

  ipcMain.handle(
    "embeddedCdp.unregisterSiteSurface",
    (event, input: EmbeddedCdpSiteSurfaceRemoval) => ({
      ok: browserSurfaces.unregisterSiteSurface(input, event.sender.id)
    })
  );
}
