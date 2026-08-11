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
import { selectSurvivingTabId } from "../shared/web-tab-lifecycle";

export type BrowserSurface = {
  id: string;
  targetGeneration?: string;
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
  ownerChatId?: string;
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

export type RegisteredWebviewSurfaceTarget = {
  registrationId: string;
  surfaceId: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  surfaceType: NonNullable<EmbeddedCdpSurfaceRegistration["surfaceType"]>;
  serviceId?: string;
  pageRoute?: string;
  tabId: string;
  webContentsId: number;
  ownerWebContentsId: number;
  currentUrl: string;
  label: string;
  ownerChatId?: string;
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
  const registeredGuestTargets = new Map<number, RegisteredWebviewSurfaceTarget>();

  function fallbackSurfaceType(surfaceKind: EmbeddedCdpSurfaceKind) {
    return surfaceKind;
  }

  function removeGuestTargetsForSurface(surfaceId: string) {
    for (const [webContentsId, target] of registeredGuestTargets) {
      if (target.surfaceId === surfaceId) {
        registeredGuestTargets.delete(webContentsId);
      }
    }
  }

  function indexRegisteredSurface(surface: RegisteredSurface) {
    removeGuestTargetsForSurface(surface.surfaceId);
    for (const tab of surface.tabs) {
      registeredGuestTargets.set(tab.webContentsId, {
        registrationId: surface.registrationId,
        surfaceId: surface.surfaceId,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType ?? fallbackSurfaceType(surface.surfaceKind),
        ...(surface.serviceId ? { serviceId: surface.serviceId } : {}),
        ...(surface.pageRoute ? { pageRoute: surface.pageRoute } : {}),
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        tabId: tab.tabId,
        webContentsId: tab.webContentsId,
        ownerWebContentsId: surface.ownerWebContentsId,
        currentUrl: tab.currentUrl,
        label: surface.label
      });
    }
  }

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
    const validKinds: EmbeddedCdpSurfaceKind[] = ["website", "webapp", "browser", "service", "chat-work-panel"];
    const validSurfaceTypes = new Set([
      "agent-chat",
      "agent-copilot",
      "agent-management",
      "project",
      "browser",
      "website",
      "webapp",
      "chat-work-panel",
      "help",
      "service"
    ]);
    const tabIds = new Set<string>();
    const webContentsIds = new Set<number>();
    return Boolean(
      input &&
      typeof input.registrationId === "string" &&
      input.registrationId.trim() &&
      typeof input.surfaceId === "string" &&
      input.surfaceId.trim() &&
      validKinds.includes(input.surfaceKind) &&
      (input.surfaceKind !== "chat-work-panel" || Boolean(input.ownerChatId?.trim())) &&
      (input.surfaceType === undefined || validSurfaceTypes.has(input.surfaceType)) &&
      (input.serviceId === undefined || typeof input.serviceId === "string") &&
      (input.pageRoute === undefined || typeof input.pageRoute === "string") &&
      (input.ownerChatId === undefined || typeof input.ownerChatId === "string") &&
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
    if (
      !isValidSurfaceRegistration(input) ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId <= 0
    ) {
      return false;
    }
    const existingSurface = registeredSurfaces.get(input.surfaceId);
    if (existingSurface && existingSurface.ownerWebContentsId !== ownerWebContentsId) {
      return false;
    }
    for (const tab of input.tabs) {
      const claimed = registeredGuestTargets.get(tab.webContentsId);
      if (claimed && claimed.surfaceId !== input.surfaceId) {
        return false;
      }
    }
    const registered: RegisteredSurface = {
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
      ...(input.serviceId ? { serviceId: input.serviceId.trim() } : {}),
      ...(input.pageRoute ? { pageRoute: input.pageRoute.trim() } : {}),
      ...(input.ownerChatId ? { ownerChatId: input.ownerChatId.trim() } : {}),
      ownerWebContentsId
    };
    registeredSurfaces.set(input.surfaceId, registered);
    indexRegisteredSurface(registered);
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
    removeGuestTargetsForSurface(surfaceId);
    return true;
  }

  function unregisterSurfacesForOwner(ownerWebContentsId: number) {
    for (const [surfaceId, surface] of registeredSurfaces) {
      if (surface.ownerWebContentsId === ownerWebContentsId) {
        registeredSurfaces.delete(surfaceId);
        removeGuestTargetsForSurface(surfaceId);
      }
    }
  }

  function resolveRegisteredSurface(surfaceId: string) {
    const registered = registeredSurfaces.get(surfaceId);
    if (!registered) {
      return null;
    }
    const previousTabs = registered.tabs;
    const tabs = previousTabs.filter((tab) => {
      const contents = options.webContents.fromId(tab.webContentsId);
      return Boolean(contents && !contents.isDestroyed() && contents.getType() === "webview");
    });
    if (tabs.length === 0) {
      registeredSurfaces.delete(surfaceId);
      removeGuestTargetsForSurface(surfaceId);
      return null;
    }
    if (tabs.length !== previousTabs.length) {
      registered.tabs = tabs;
      indexRegisteredSurface(registered);
    }
    if (!registered.activeTabId || !tabs.some((tab) => tab.tabId === registered.activeTabId)) {
      registered.activeTabId = selectSurvivingTabId(
        previousTabs.map((tab) => tab.tabId),
        tabs.map((tab) => tab.tabId),
        registered.activeTabId
      );
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

  function resolveWebviewSurfaceTarget(webContentsId: number) {
    const indexed = registeredGuestTargets.get(webContentsId);
    if (!indexed) {
      return null;
    }
    const resolved = resolveRegisteredSurface(indexed.surfaceId);
    const tab = resolved?.tabs.find((candidate) => candidate.webContentsId === webContentsId);
    if (
      !resolved ||
      !tab ||
      resolved.registered.registrationId !== indexed.registrationId ||
      resolved.registered.ownerWebContentsId !== indexed.ownerWebContentsId
    ) {
      registeredGuestTargets.delete(webContentsId);
      return null;
    }
    const next = {
      ...indexed,
      currentUrl: tab.currentUrl,
      label: resolved.registered.label,
      ...(resolved.registered.pageRoute ? { pageRoute: resolved.registered.pageRoute } : {}),
      ...(resolved.registered.ownerChatId ? { ownerChatId: resolved.registered.ownerChatId } : {})
    };
    registeredGuestTargets.set(webContentsId, next);
    return next;
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
          ...(resolved?.registered.registrationId
            ? { targetGeneration: resolved.registered.registrationId }
            : {}),
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

  function listChatWorkPanelSurfaces(): BrowserSurface[] {
    const surfaces: BrowserSurface[] = [];
    for (const [surfaceId, candidate] of registeredSurfaces) {
      if (candidate.surfaceKind !== "chat-work-panel") {
        continue;
      }
      const resolved = resolveRegisteredSurface(surfaceId);
      if (!resolved) {
        continue;
      }
      const activeTab = resolved.activeTab;
      surfaces.push({
        id: surfaceId,
        targetGeneration: resolved.registered.registrationId,
        label: resolved.registered.label,
        url: resolved.registered.url,
        active: false,
        currentUrl: activeTab?.currentUrl,
        title: activeTab?.title,
        webContentsId: activeTab?.webContentsId,
        surfaceKind: "chat-work-panel",
        open: true,
        tabs: resolved.tabs,
        activeTabId: resolved.registered.activeTabId,
        ownerChatId: resolved.registered.ownerChatId
      });
    }
    return surfaces;
  }

  function getRegisteredSurfaceSnapshot(
    surfaceId: string,
    registrationId: string,
    ownerWebContentsId: number
  ) {
    const resolved = resolveRegisteredSurface(surfaceId);
    if (
      !resolved ||
      resolved.registered.registrationId !== registrationId ||
      resolved.registered.ownerWebContentsId !== ownerWebContentsId
    ) {
      return null;
    }
    return {
      registered: resolved.registered,
      tabs: resolved.tabs
    };
  }

  return {
    currentPageSnapshotMatchesSurface,
    findWebContentsById,
    findWebContentsForSurfaceUrl,
    findRegisteredSurfaceWebContents,
    builtinBrowserSurface,
    listBrowserSurfaces,
    listChatWorkPanelSurfaces,
    getRegisteredSurfaceSnapshot,
    registerSurface,
    resolveWebviewSurfaceTarget,
    unregisterSurface,
    unregisterSurfacesForOwner,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
