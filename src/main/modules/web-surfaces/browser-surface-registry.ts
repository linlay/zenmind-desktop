import { createContainerProjection, webEntryMatchesSurfaceTarget } from "./container-projection";
import { createRegistrationStore } from "./registration-store";
import type { BrowserSurfaceRegistryOptions } from "./registry-contracts";

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  const store = createRegistrationStore(options);
  const projection = createContainerProjection(options, { registeredSurfaces: store.registeredSurfaces, resolveRegisteredSurface: store.resolveRegisteredSurface, findWebContentsForSurfaceUrl: store.guest.findWebContentsForSurfaceUrl });
  function isWorkPanelHtmlPreview(webContentsId: number, ownerChatId: string | undefined) {
    const contents = store.guest.findWebContentsById(webContentsId);
    return Boolean(contents && !contents.isDestroyed() && ownerChatId &&
      options.isWorkPanelHtmlPreviewGuest?.(contents, ownerChatId));
  }
  return {
    isWorkPanelHtmlPreview,
    websiteBridges: store.guest.websiteBridges,
    ensureWebsiteBridge: store.guest.ensureWebsiteBridge,
    observeWebGuests: store.guest.observeWebGuests,
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
