import { WebContents } from "electron";
import { BUILTIN_BROWSER_DEFAULT_URL, BUILTIN_BROWSER_ROUTE, BUILTIN_BROWSER_SURFACE_ID, BUILTIN_BROWSER_SURFACE_LABEL } from "../../../shared/browser-surfaces";
import { createWebEntrySurfaceIdentity } from "../../../shared/surface-identity";
import type { BrowserContainer, BrowserSurfaceDiagnosticSnapshot, BrowserSurfaceRegistryOptions, BrowserWebContentsDiagnosticSnapshot, RegisteredSurface, ResolvedSurface } from "./registry-contracts";

export function normalizeSurfaceMatchText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
}

export function webEntryMatchesSurfaceTarget(item: BrowserContainer, target: string) {
  const normalizedTarget = normalizeSurfaceMatchText(target);
  if (!normalizedTarget) {
    return false;
  }
  const candidates = [
    item.id,
    item.entryKey || "",
    item.label,
    item.url,
    (() => {
      try {
        return new URL(item.url).hostname;
      } catch {
        return "";
      }
    })()
  ].map(normalizeSurfaceMatchText);

  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.includes(normalizedTarget) ||
    normalizedTarget.includes(candidate)
  );
}

interface ContainerProjectionDependencies {
  readonly resolveRegisteredSurface: (surfaceId: string) => ResolvedSurface | null;
  readonly findWebContentsForSurfaceUrl: (surfaceUrl: string) => Electron.WebContents | null;
  readonly registeredSurfaces: ReadonlyMap<string, RegisteredSurface>;
}

/** Private container projection responsibility. */
export function createContainerProjection(options: Pick<BrowserSurfaceRegistryOptions, "webContents" | "listWebEntries" | "getCurrentPageSnapshot">, dependencies: ContainerProjectionDependencies) {

  function currentPageSnapshotMatchesSurface(surfaceId: string, contents?: WebContents | null): boolean {
    const currentPageSnapshot = options.getCurrentPageSnapshot();
    const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
    return currentPageSnapshot?.pageKind === "webview" && (currentPageSnapshot.surfaceId === surfaceId ||
      snapshotBrowserTarget?.surfaceId === surfaceId ||
      (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id));
  }

  function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserContainer {
    const resolved = dependencies.resolveRegisteredSurface(BUILTIN_BROWSER_SURFACE_ID);
    const activeTab = resolved?.activeTab ?? null;
    const activeContents = resolved?.contents ?? contents;
    return {
      id: BUILTIN_BROWSER_SURFACE_ID,
      surfaceId: BUILTIN_BROWSER_SURFACE_ID,
      ...(resolved?.registered.registrationId
        ? { targetGeneration: resolved.registered.registrationId }
        : {}),
      label: BUILTIN_BROWSER_SURFACE_LABEL,
      url,
      active: currentPageSnapshotMatchesSurface(BUILTIN_BROWSER_SURFACE_ID, activeContents),
      currentUrl: activeTab?.currentUrl || activeContents?.getURL(),
      title: activeTab?.title || activeContents?.getTitle(),
      webContentsId: activeTab?.webContentsId || activeContents?.id,
      surfaceRoute: BUILTIN_BROWSER_ROUTE,
      surfaceKind: "browser",
      surfaceRole: "browser",
      surfaceLevel: "root",
      interaction: "interactive",
      open: Boolean(resolved?.tabs.length || activeContents),
      tabs: resolved?.tabs ?? [],
      activeTabId: resolved?.registered.activeTabId ?? null
    };
  }

  function listBrowserContainers(): BrowserContainer[] {
    const builtinContents = dependencies.findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
      builtinBrowserSurface(builtinContents),
      ...options.listWebEntries().items.map((item) => {
        const identity = createWebEntrySurfaceIdentity(item.kind, item.entryKey);
        const resolved = dependencies.resolveRegisteredSurface(identity.surfaceId);
        const contents = resolved?.contents ?? null;
        const activeTab = resolved?.activeTab ?? null;
        return {
          ...identity,
          id: identity.surfaceId,
          entryKey: item.entryKey,
          ...(resolved?.registered.registrationId
            ? { targetGeneration: resolved.registered.registrationId }
            : {}),
          label: item.label,
          url: item.url,
          copilotAgentKey: item.copilotAgentKey,
          active: Boolean(resolved?.registered.active) &&
            currentPageSnapshotMatchesSurface(identity.surfaceId, contents),
          currentUrl: activeTab?.currentUrl || contents?.getURL(),
          title: activeTab?.title || contents?.getTitle(),
          webContentsId: activeTab?.webContentsId || contents?.id,
          surfaceRoute: `/webs/${item.entryKey}`,
          surfaceKind: item.kind,
          open: Boolean(resolved?.tabs.length),
          tabs: resolved?.tabs ?? [],
          activeTabId: resolved?.registered.activeTabId ?? null
        };
      })
    ];
  }

  function listWorkPanelContainers(): BrowserContainer[] {
    const surfaces: BrowserContainer[] = [];
    for (const [surfaceId, candidate] of dependencies.registeredSurfaces) {
      if (candidate.surfaceKind !== "chat-work-panel") {
        continue;
      }
      const resolved = dependencies.resolveRegisteredSurface(surfaceId);
      if (!resolved) {
        continue;
      }
      const activeTab = resolved.activeTab;
      surfaces.push({
        id: surfaceId,
        surfaceId,
        targetGeneration: resolved.registered.registrationId,
        label: resolved.registered.label,
        url: resolved.registered.url,
        active: false,
        currentUrl: activeTab?.currentUrl,
        title: activeTab?.title,
        webContentsId: activeTab?.webContentsId,
        surfaceKind: "chat-work-panel",
        surfaceRole: resolved.registered.surfaceRole,
        surfaceLevel: resolved.registered.surfaceLevel,
        ...(resolved.registered.parentSurfaceId ? { parentSurfaceId: resolved.registered.parentSurfaceId } : {}),
        interaction: resolved.registered.interaction,
        open: true,
        tabs: resolved.tabs,
        activeTabId: resolved.registered.activeTabId,
        ownerChatId: resolved.registered.ownerChatId
      });
    }
    return surfaces;
  }

  function listRegisteredSurfaces(): BrowserContainer[] {
    const surfaces: BrowserContainer[] = [];
    for (const surfaceId of [...dependencies.registeredSurfaces.keys()]) {
      const resolved = dependencies.resolveRegisteredSurface(surfaceId);
      if (!resolved)
        continue;
      const activeTab = resolved.activeTab;
      const registered = resolved.registered;
      const activeContents = activeTab
        ? options.webContents.fromId(activeTab.webContentsId)
        : null;
      surfaces.push({
        id: registered.surfaceId,
        surfaceId: registered.surfaceId,
        ...(registered.surfaceIdentityKey && (registered.surfaceRole === "website" || registered.surfaceRole === "webapp")
          ? { entryKey: registered.surfaceIdentityKey }
          : {}),
        ...(registered.serviceId ? { serviceId: registered.serviceId } : {}),
        targetGeneration: registered.registrationId,
        label: registered.label,
        url: registered.url,
        // Registry active is also used by Agent WebClient live-surface lifecycle.
        // Public CDP ownership is narrower: it must match the Desktop page snapshot
        // and child surfaces such as Copilot Dock never become the current page.
        active: registered.active &&
          registered.surfaceLevel !== "child" &&
          currentPageSnapshotMatchesSurface(registered.surfaceId, activeContents),
        currentUrl: activeTab?.currentUrl,
        title: activeTab?.title,
        webContentsId: activeTab?.webContentsId,
        surfaceRoute: registered.pageRoute,
        surfaceKind: registered.surfaceKind,
        surfaceRole: registered.surfaceRole,
        surfaceLevel: registered.surfaceLevel,
        ...(registered.parentSurfaceId ? { parentSurfaceId: registered.parentSurfaceId } : {}),
        ...(registered.ownerChatId ? { ownerChatId: registered.ownerChatId } : {}),
        interaction: registered.interaction,
        open: true,
        tabs: resolved.tabs,
        activeTabId: registered.activeTabId,
      });
    }
    return surfaces;
  }

  function listDiagnosticSurfaces(): BrowserSurfaceDiagnosticSnapshot[] {
    const surfaces: BrowserSurfaceDiagnosticSnapshot[] = [];
    for (const surfaceId of [...dependencies.registeredSurfaces.keys()]) {
      const resolved = dependencies.resolveRegisteredSurface(surfaceId);
      if (!resolved)
        continue;
      const registered = resolved.registered;
      surfaces.push({
        registrationId: registered.registrationId,
        surfaceId: registered.surfaceId,
        surfaceKind: registered.surfaceKind,
        surfaceType: registered.surfaceType ?? registered.surfaceKind,
        surfaceRole: registered.surfaceRole,
        surfaceLevel: registered.surfaceLevel,
        interaction: registered.interaction,
        ...(registered.parentSurfaceId ? { parentSurfaceId: registered.parentSurfaceId } : {}),
        ...(registered.ownerChatId ? { ownerChatId: registered.ownerChatId } : {}),
        ownerWebContentsId: registered.ownerWebContentsId,
        label: registered.label,
        url: registered.url,
        ...(registered.pageRoute ? { pageRoute: registered.pageRoute } : {}),
        active: registered.active,
        tabs: resolved.tabs,
        activeTabId: registered.activeTabId,
      });
    }
    return surfaces;
  }

  function listWebContentsDiagnostics(): BrowserWebContentsDiagnosticSnapshot[] {
    return options.webContents.getAllWebContents().flatMap((contents) => {
      try {
        if (contents.isDestroyed())
          return [];
        return [{
          webContentsId: contents.id,
          type: contents.getType(),
          osProcessId: contents.getOSProcessId(),
          url: contents.getURL(),
          title: contents.getTitle(),
          loading: contents.isLoading(),
          crashed: contents.isCrashed(),
          devToolsOpened: contents.isDevToolsOpened(),
          backgroundThrottling: contents.getBackgroundThrottling(),
        }];
      }
      catch {
        // A WebContents can disappear between enumeration and inspection.
        return [];
      }
    });
  }

  return { currentPageSnapshotMatchesSurface, builtinBrowserSurface, listBrowserContainers, listWorkPanelContainers, listRegisteredSurfaces, listDiagnosticSurfaces, listWebContentsDiagnostics };
}
