import { createContainerProjection, webEntryMatchesSurfaceTarget } from "./container-projection";
import { createRegistrationStore } from "./registration-store";
import type { BrowserSurfaceRegistryOptions } from "./registry-contracts";

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  const store = createRegistrationStore(options);
  const projection = createContainerProjection(options, { registeredSurfaces: store.registeredSurfaces, resolveRegisteredSurface: store.resolveRegisteredSurface, findWebContentsForSurfaceUrl: store.guest.findWebContentsForSurfaceUrl });
  return {
    currentPageSnapshotMatchesSurface: projection.currentPageSnapshotMatchesSurface,
    builtinBrowserSurface: projection.builtinBrowserSurface,
    listBrowserContainers: projection.listBrowserContainers,
    listWorkPanelContainers: projection.listWorkPanelContainers,
    listDiagnosticSurfaces: projection.listDiagnosticSurfaces,
    listRegisteredSurfaces: projection.listRegisteredSurfaces,
    listWebContentsDiagnostics: projection.listWebContentsDiagnostics,
    retainWorkPanelDialogSurface: store.retainWorkPanelDialogSurface,
    retainWorkPanelDialogSibling: store.retainWorkPanelDialogSibling,
    releaseWorkPanelDialogSurface: store.releaseWorkPanelDialogSurface,
    findWebContentsById: store.guest.findWebContentsById,
    findWebContentsForSurfaceUrl: store.guest.findWebContentsForSurfaceUrl,
    findRegisteredSurfaceWebContents: store.guest.findRegisteredSurfaceWebContents,
    getRegisteredSurfaceSnapshot: store.getRegisteredSurfaceSnapshot,
    registerSurface: store.registerSurface,
    registerSurfaceResult: store.registerSurfaceResult,
    resolveCanonicalSurfaceId: store.resolveCanonicalSurfaceId,
    resolveWebviewSurfaceTarget: store.guest.resolveWebviewSurfaceTarget,
    waitForWebviewSurfaceTarget: store.guest.waitForWebviewSurfaceTarget,
    waitForWebviewSurfaceTargetMatching: store.guest.waitForWebviewSurfaceTargetMatching,
    unregisterSurface: store.unregisterSurface,
    unregisterSurfacesForOwner: store.unregisterSurfacesForOwner,
    subscribeLifecycle: store.subscribeLifecycle,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
export * from "./browser-surface-registry.shared";
