import type { IpcRenderer, IpcRendererEvent } from "electron";
import type { NavigateListener } from "../shared/contracts";

/** Subscribe during preload so cold-start navigation survives React mounting. */
export function createMainNavigationSubscription(ipc: Pick<IpcRenderer, "on">) {
  const listeners = new Set<NavigateListener>();
  let pendingPath: string | undefined;
  ipc.on("app.navigate", (_event: IpcRendererEvent, targetPath: unknown) => {
    if (typeof targetPath !== "string") return;
    if (listeners.size === 0) {
      // Only the latest explicit Main navigation remains relevant at startup.
      pendingPath = targetPath;
      return;
    }
    for (const listener of listeners) listener(targetPath);
  });

  return (listener: NavigateListener) => {
    listeners.add(listener);
    if (pendingPath !== undefined) {
      const targetPath = pendingPath;
      pendingPath = undefined;
      listener(targetPath);
    }
    return () => { listeners.delete(listener); };
  };
}
