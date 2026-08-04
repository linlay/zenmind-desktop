import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRemoval
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
      browserSurfaces.unregisterSurfacesForOwner(sender.id);
    });
  }

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
    "embeddedCdp.unregisterSurface",
    (event, input: EmbeddedCdpSurfaceRemoval) => ({
      ok: browserSurfaces.unregisterSurface(input, event.sender.id)
    })
  );
}
