import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";
import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTabRegistration,
  EmbeddedCdpSiteSurfaceKind,
  EmbeddedCdpSurfaceKind
} from "../shared/embedded-cdp";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../shared/browser-surfaces";

export type BrowserSurface = {
  id: string;
  label: string;
  url: string;
  active: boolean;
  copilotAgentKey?: string;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  surfaceRoute?: string;
  embedPath?: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  open: boolean;
  tabs: BrowserSurfaceTab[];
  activeTabId: string | null;
};

export type BrowserSurfaceTab = EmbeddedCdpSurfaceTabRegistration;

type WebContentsAccess = {
  getAllWebContents(): WebContents[];
  fromId(id: number): WebContents | undefined;
};

export type BrowserSurfaceRegistryOptions = {
  webContents: WebContentsAccess;
  listWebEntries(): {
    items: Array<{
      id: string;
      entryKey: string;
      kind: EmbeddedCdpSiteSurfaceKind;
      label: string;
      url: string;
      copilotAgentKey?: string;
    }>;
  };
  getCurrentPageSnapshot(): DesktopPageContextSnapshot | null;
};

type RegisteredSurface = EmbeddedCdpSurfaceRegistration & {
  ownerWebContentsId: number;
};

export function normalizeSurfaceMatchText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
}

export function webEntryMatchesSurfaceTarget(item: BrowserSurface, target: string) {
  const normalizedTarget = normalizeSurfaceMatchText(target);
  if (!normalizedTarget) {
    return false;
  }
  const candidates = [
    item.id,
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

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  const registeredSurfaces = new Map<string, RegisteredSurface>();

  function expectedSiteSurfaceIdPrefix(surfaceKind: EmbeddedCdpSiteSurfaceKind) {
    return `${surfaceKind}:`;
  }

  function isValidSurfaceTab(input: EmbeddedCdpSurfaceTabRegistration) {
    return Boolean(
      input &&
      typeof input.tabId === "string" &&
      input.tabId.trim() &&
      typeof input.currentUrl === "string" &&
      typeof input.title === "string" &&
      Number.isSafeInteger(input.webContentsId) &&
      input.webContentsId > 0 &&
      typeof input.canGoBack === "boolean" &&
      typeof input.canGoForward === "boolean" &&
      typeof input.isLoading === "boolean"
    );
  }

  function isValidSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration) {
    const sitePrefixValid = input?.surfaceKind !== "website" && input?.surfaceKind !== "webapp"
      ? true
      : input.surfaceId.startsWith(expectedSiteSurfaceIdPrefix(input.surfaceKind));
    const validKinds: EmbeddedCdpSurfaceKind[] = ["website", "webapp", "browser", "service"];
    const tabIds = new Set<string>();
    const webContentsIds = new Set<number>();
    return Boolean(
      input &&
      typeof input.registrationId === "string" &&
      input.registrationId.trim() &&
      typeof input.surfaceId === "string" &&
      input.surfaceId.trim() &&
      validKinds.includes(input.surfaceKind) &&
      sitePrefixValid &&
      typeof input.label === "string" &&
      typeof input.url === "string" &&
      typeof input.active === "boolean" &&
      Array.isArray(input.tabs) &&
      input.tabs.every((tab) => {
        if (!isValidSurfaceTab(tab)) {
          return false;
        }
        const tabId = tab.tabId.trim();
        if (tabIds.has(tabId) || webContentsIds.has(tab.webContentsId)) {
          return false;
        }
        tabIds.add(tabId);
        webContentsIds.add(tab.webContentsId);
        return true;
      }) &&
      (input.activeTabId === null || (
        typeof input.activeTabId === "string" &&
        tabIds.has(input.activeTabId.trim())
      ))
    );
  }

  function registerSurface(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number) {
    if (!isValidSurfaceRegistration(input) || !Number.isSafeInteger(ownerWebContentsId)) {
      return false;
    }
    registeredSurfaces.set(input.surfaceId, {
      ...input,
      registrationId: input.registrationId.trim(),
      surfaceId: input.surfaceId.trim(),
      label: input.label.trim(),
      url: input.url.trim(),
      tabs: input.tabs.map((tab) => ({
        ...tab,
        tabId: tab.tabId.trim(),
        currentUrl: tab.currentUrl.trim(),
        title: tab.title.trim(),
        ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl.trim() } : {})
      })),
      activeTabId: input.activeTabId?.trim() || null,
      ownerWebContentsId
    });
    return true;
  }

  function unregisterSurface(input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number) {
    const surfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
    const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
    const current = registeredSurfaces.get(surfaceId);
    if (
      !current ||
      current.registrationId !== registrationId ||
      current.ownerWebContentsId !== ownerWebContentsId
    ) {
      return false;
    }
    registeredSurfaces.delete(surfaceId);
    return true;
  }

  function unregisterSurfacesForOwner(ownerWebContentsId: number) {
    for (const [surfaceId, surface] of registeredSurfaces) {
      if (surface.ownerWebContentsId === ownerWebContentsId) {
        registeredSurfaces.delete(surfaceId);
      }
    }
  }

  function resolveRegisteredSurface(surfaceId: string) {
    const registered = registeredSurfaces.get(surfaceId);
    if (!registered) {
      return null;
    }
    const tabs = registered.tabs.filter((tab) => {
      const contents = options.webContents.fromId(tab.webContentsId);
      return Boolean(contents && !contents.isDestroyed() && contents.getType() === "webview");
    });
    if (tabs.length === 0) {
      registeredSurfaces.delete(surfaceId);
      return null;
    }
    if (tabs.length !== registered.tabs.length) {
      registered.tabs = tabs;
    }
    if (registered.activeTabId && !tabs.some((tab) => tab.tabId === registered.activeTabId)) {
      registered.activeTabId = null;
    }
    const activeTab = tabs.find((tab) => tab.tabId === registered.activeTabId) ?? null;
    const contents = activeTab ? options.webContents.fromId(activeTab.webContentsId) ?? null : null;
    return { registered, tabs, activeTab, contents };
  }

  function findRegisteredSurfaceWebContents(surfaceId: string, tabId?: string) {
    const resolved = resolveRegisteredSurface(surfaceId);
    if (!resolved) {
      return null;
    }
    const tab = tabId
      ? resolved.tabs.find((candidate) => candidate.tabId === tabId)
      : resolved.activeTab;
    return tab ? options.webContents.fromId(tab.webContentsId) ?? null : null;
  }

  function findWebContentsById(webContentsId: number) {
    const contents = options.webContents.fromId(webContentsId);
    return contents && !contents.isDestroyed() && contents.getType() === "webview" ? contents : null;
  }

  function currentPageSnapshotMatchesSurface(surfaceId: string, contents?: WebContents | null) {
    const currentPageSnapshot = options.getCurrentPageSnapshot();
    const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
    return currentPageSnapshot?.pageKind === "webview" && (
      currentPageSnapshot.surfaceId === surfaceId ||
      snapshotBrowserTarget?.surfaceId === surfaceId ||
      (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id)
    );
  }

  function findWebContentsForSurfaceUrl(surfaceUrl: string) {
    let target: URL | null = null;
    try {
      target = new URL(surfaceUrl);
    } catch {
      return null;
    }

    return options.webContents.getAllWebContents().find((contents) => {
      if (contents.isDestroyed()) {
        return false;
      }
      if (contents.getType() !== "webview") {
        return false;
      }
      try {
        const current = new URL(contents.getURL());
        return (
          current.href === target.href ||
          current.hostname === target.hostname ||
          current.href.startsWith(target.href)
        );
      } catch {
        return false;
      }
    }) ?? null;
  }

  function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserSurface {
    const resolved = resolveRegisteredSurface(BUILTIN_BROWSER_SURFACE_ID);
    const activeTab = resolved?.activeTab ?? null;
    const activeContents = resolved?.contents ?? contents;
    return {
      id: BUILTIN_BROWSER_SURFACE_ID,
      label: BUILTIN_BROWSER_SURFACE_LABEL,
      url,
      active: currentPageSnapshotMatchesSurface(BUILTIN_BROWSER_SURFACE_ID, activeContents),
      currentUrl: activeTab?.currentUrl || activeContents?.getURL(),
      title: activeTab?.title || activeContents?.getTitle(),
      webContentsId: activeTab?.webContentsId || activeContents?.id,
      surfaceRoute: BUILTIN_BROWSER_ROUTE,
      surfaceKind: "browser",
      open: Boolean(resolved?.tabs.length || activeContents),
      tabs: resolved?.tabs ?? [],
      activeTabId: resolved?.registered.activeTabId ?? null
    };
  }

  function listBrowserSurfaces(): BrowserSurface[] {
    const builtinContents = findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
      builtinBrowserSurface(builtinContents),
      ...options.listWebEntries().items.map((item) => {
        const resolved = resolveRegisteredSurface(item.entryKey);
        const contents = resolved?.contents ?? null;
        const activeTab = resolved?.activeTab ?? null;
        return {
          id: item.entryKey,
          label: item.label,
          url: item.url,
          copilotAgentKey: item.copilotAgentKey,
          active: Boolean(resolved?.registered.active) &&
            currentPageSnapshotMatchesSurface(item.entryKey, contents),
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

  return {
    currentPageSnapshotMatchesSurface,
    findWebContentsById,
    findWebContentsForSurfaceUrl,
    findRegisteredSurfaceWebContents,
    builtinBrowserSurface,
    listBrowserSurfaces,
    registerSurface,
    unregisterSurface,
    unregisterSurfacesForOwner,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
