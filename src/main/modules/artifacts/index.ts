export { registerArtifactActionIpc, artifactRelativePath } from "./actions";
import type { App, BrowserWindow, IpcMain } from "electron";
import type { RealtimeBroker } from "../agent-platform";
import { ArtifactStore, getArtifactDatabasePath } from "./store";

export function createArtifactRuntime(options: {
  app: App;
  platform: NodeJS.Platform;
  broker: Pick<RealtimeBroker, "subscribePush">;
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  getMainWindow(): BrowserWindow | null;
  onError(error: unknown): void;
}) {
  // Resolve/create storage only after a push or a trusted list request, preserving first-install detection.
  const store = new ArtifactStore(() => getArtifactDatabasePath(options.app, options.platform));
  let notification: ReturnType<typeof setTimeout> | null = null;
  function recordChange(write: () => boolean) {
    try {
      if (!write() || notification) return;
      notification = setTimeout(() => {
        notification = null;
        const window = options.getMainWindow();
        if (window && !window.isDestroyed()) window.webContents.send("artifacts.changed");
      }, 50);
      notification.unref?.();
    } catch (error) { options.onError(error); }
  }
  const unsubscribe = options.broker.subscribePush({
    types: ["artifact.published", "resource.pushed"], kind: "internal", consumerId: "desktop-artifact-index",
    onPush(frame) { recordChange(() => store.ingest(frame)); },
  });
  options.ipcMain.handle("artifacts.list", (event, input) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) throw new Error("Artifact index access denied");
    return store.list(input);
  });
  return {
    recordPublished(event: Record<string, unknown>) {
      recordChange(() => store.ingestPublished(event));
    },
    dispose() {
      unsubscribe();
      if (notification) clearTimeout(notification);
      notification = null;
      options.ipcMain.removeHandler("artifacts.list");
    },
  };
}
