import type { SurfaceRuntimeDownloadState } from "../../shared/surface-runtime-budget";

type SurfaceRuntimeDownloadListener = (state: SurfaceRuntimeDownloadState) => void;

const listeners = new Set<SurfaceRuntimeDownloadListener>();
let unsubscribeFromDesktop: (() => void) | null = null;

export function registerSurfaceRuntimeDownloadListener(
  listener: SurfaceRuntimeDownloadListener,
) {
  listeners.add(listener);
  if (!unsubscribeFromDesktop) {
    unsubscribeFromDesktop = window.electronAPI.onSurfaceRuntimeDownloadState((state) => {
      for (const currentListener of listeners) {
        currentListener(state);
      }
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeFromDesktop?.();
      unsubscribeFromDesktop = null;
    }
  };
}
