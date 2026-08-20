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
import {
  COPILOT_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  LEGACY_FIXED_SURFACE_ID_ALIASES,
  MAIN_CHAT_SURFACE_ID,
  createLegacySurfaceIdAliases,
  createWebEntrySurfaceIdentity,
  resolveLegacyFixedSurfaceId,
  surfaceIdentityMatchesPolicy,
  type SurfaceIdentity,
  type SurfaceRole
} from "../shared/surface-identity";

export type BrowserSurface = SurfaceIdentity & {
  id: string;
  entryKey?: string;
  serviceId?: string;
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

export function registeredSurfaceIdentitiesConflict(
  existing: Pick<EmbeddedCdpSurfaceRegistration, "surfaceId" | "surfaceRole" | "surfaceIdentityKey">,
  candidate: Pick<EmbeddedCdpSurfaceRegistration, "surfaceId" | "surfaceRole" | "surfaceIdentityKey">,
) {
  return existing.surfaceId.trim() === candidate.surfaceId.trim() && (
    existing.surfaceRole !== candidate.surfaceRole ||
    (existing.surfaceIdentityKey?.trim() || "") !== (candidate.surfaceIdentityKey?.trim() || "")
  );
}

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
  active: boolean;
  currentUrl: string;
  label: string;
  ownerChatId?: string;
  surfaceRole: SurfaceRole;
  surfaceLevel: SurfaceIdentity["surfaceLevel"];
  parentSurfaceId?: string;
  interaction: SurfaceIdentity["interaction"];
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

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  const registeredSurfaces = new Map<string, RegisteredSurface>();
  const registeredGuestTargets = new Map<number, RegisteredWebviewSurfaceTarget>();
  const pendingGuestTargetWaiters = new Map<
    number,
    Set<(target: RegisteredWebviewSurfaceTarget | null) => void>
  >();
  const surfaceAliases = new Map<string, string>(Object.entries(LEGACY_FIXED_SURFACE_ID_ALIASES));
  const reportedLegacyAliases = new Set<string>();

  function resolveCanonicalSurfaceId(surfaceId: string) {
    const normalized = surfaceId.trim();
    const canonical = surfaceAliases.get(normalized) ?? resolveLegacyFixedSurfaceId(normalized);
    if (canonical !== normalized && !reportedLegacyAliases.has(normalized)) {
      reportedLegacyAliases.add(normalized);
      console.warn("[surface-identity] deprecated alias accepted; use canonical surfaceId", canonical);
    }
    return canonical;
  }

  function removeAliasesForSurface(surfaceId: string) {
    for (const [alias, canonical] of surfaceAliases) {
      if (canonical === surfaceId && LEGACY_FIXED_SURFACE_ID_ALIASES[alias] !== canonical) {
        surfaceAliases.delete(alias);
      }
    }
  }

  function addDerivedAliases(surface: RegisteredSurface) {
    const identityKey = surface.surfaceIdentityKey?.trim() || "";
    for (const alias of createLegacySurfaceIdAliases(surface.surfaceRole, identityKey)) {
      if (!alias || alias === surface.surfaceId) continue;
      const current = surfaceAliases.get(alias);
      if (!current || current === surface.surfaceId) surfaceAliases.set(alias, surface.surfaceId);
    }
  }

  function fallbackSurfaceType(surfaceKind: EmbeddedCdpSurfaceKind) {
    return surfaceKind;
  }

  function settleGuestTargetWaiters(
    webContentsId: number,
    target: RegisteredWebviewSurfaceTarget | null,
  ) {
    const waiters = pendingGuestTargetWaiters.get(webContentsId);
    if (!waiters) return;
    pendingGuestTargetWaiters.delete(webContentsId);
    for (const waiter of [...waiters]) waiter(target);
  }

  function removeGuestTargetsForSurface(surfaceId: string, settleWaiters = true) {
    for (const [webContentsId, target] of registeredGuestTargets) {
      if (target.surfaceId === surfaceId) {
        registeredGuestTargets.delete(webContentsId);
        if (settleWaiters) settleGuestTargetWaiters(webContentsId, null);
      }
    }
  }

  function indexRegisteredSurface(surface: RegisteredSurface) {
    const previousWebContentsIds = new Set<number>();
    for (const [webContentsId, target] of registeredGuestTargets) {
      if (target.surfaceId === surface.surfaceId) {
        previousWebContentsIds.add(webContentsId);
        registeredGuestTargets.delete(webContentsId);
      }
    }
    const nextWebContentsIds = new Set<number>();
    for (const tab of surface.tabs) {
      const target: RegisteredWebviewSurfaceTarget = {
        registrationId: surface.registrationId,
        surfaceId: surface.surfaceId,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType ?? fallbackSurfaceType(surface.surfaceKind),
        ...(surface.serviceId ? { serviceId: surface.serviceId } : {}),
        ...(surface.pageRoute ? { pageRoute: surface.pageRoute } : {}),
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        tabId: tab.tabId,
        webContentsId: tab.webContentsId,
        ownerWebContentsId: surface.ownerWebContentsId,
        active: surface.active && surface.activeTabId === tab.tabId,
        currentUrl: tab.currentUrl,
        label: surface.label
      };
      nextWebContentsIds.add(tab.webContentsId);
      registeredGuestTargets.set(tab.webContentsId, target);
      settleGuestTargetWaiters(tab.webContentsId, target);
    }
    for (const webContentsId of previousWebContentsIds) {
      if (!nextWebContentsIds.has(webContentsId)) {
        settleGuestTargetWaiters(webContentsId, null);
      }
    }
  }

  function expectedRolesForRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRole[] {
    if (input.surfaceKind === "website") return ["website"];
    if (input.surfaceKind === "webapp") return ["webapp"];
    if (input.surfaceKind === "browser") return ["browser"];
    if (input.surfaceKind === "chat-work-panel") return ["workpanel-web"];
    if (input.surfaceType === "help") return ["help"];
    if (input.surfaceType === "agent-overview") return ["overview"];
    if (input.surfaceType === "agent-debug") return ["debug"];
    if (input.surfaceType === "agent-btw") return ["btw"];
    if (input.surfaceType === "agent-project" || input.surfaceType === "project") return ["project"];
    if (input.surfaceType === "agent-chat") return ["main-chat", "kanban-chat"];
    if (input.surfaceType === "agent-copilot") return ["copilot-chat", "copilot-dock", "copilot"];
    if (input.surfaceType === "agent-management") {
      return ["service", "source", "file-diff", "artifact", "reference", "file", "planning", "skill", "agent"];
    }
    return ["service", "plugin-settings"];
  }

  function identityMatchesRegistration(input: EmbeddedCdpSurfaceRegistration) {
    const identityKey = input.surfaceIdentityKey?.trim() || "";
    if (!surfaceIdentityMatchesPolicy(input, identityKey)) return false;
    if (!expectedRolesForRegistration(input).includes(input.surfaceRole)) return false;
    if (input.surfaceRole === "website" || input.surfaceRole === "webapp") {
      const entry = options.listWebEntries().items.find((item) => item.entryKey === identityKey);
      if (!entry || entry.kind !== input.surfaceRole || input.pageRoute !== `/webs/${identityKey}`) return false;
    }
    if (
      (input.surfaceRole === "service" || input.surfaceRole === "plugin-settings") &&
      input.serviceId?.trim() !== identityKey
    ) return false;
    if (
      ["main-chat", "copilot-chat", "kanban-chat", "copilot-dock", "overview", "debug", "btw", "source", "project", "file-diff", "artifact", "reference", "file", "planning", "skill", "agent", "copilot"].includes(input.surfaceRole) &&
      input.serviceId?.trim() !== "agent-webclient"
    ) return false;
    if (input.surfaceRole === "main-chat" && input.surfaceId !== MAIN_CHAT_SURFACE_ID) return false;
    if (input.surfaceRole === "copilot-chat" && input.surfaceId !== COPILOT_CHAT_SURFACE_ID) return false;
    if (input.surfaceRole === "kanban-chat" && input.surfaceId !== KANBAN_CHAT_SURFACE_ID) return false;
    if (input.surfaceRole === "copilot-dock" && input.surfaceId !== COPILOT_DOCK_SURFACE_ID) return false;
    if (input.surfaceKind === "chat-work-panel" && !input.ownerChatId?.trim()) return false;
    if (input.surfaceLevel === "child") {
      if (!input.parentSurfaceId && input.surfaceRole !== "project" && input.surfaceRole !== "copilot-dock") return false;
      if (input.parentSurfaceId) {
        const canonicalParentSurfaceId = resolveCanonicalSurfaceId(input.parentSurfaceId);
        if (
          canonicalParentSurfaceId !== input.parentSurfaceId ||
          canonicalParentSurfaceId === input.surfaceId ||
          !resolveRegisteredSurface(canonicalParentSurfaceId)
        ) return false;
        const visited = new Set([input.surfaceId]);
        let cursor = registeredSurfaces.get(canonicalParentSurfaceId);
        while (cursor) {
          if (visited.has(cursor.surfaceId)) return false;
          visited.add(cursor.surfaceId);
          cursor = cursor.parentSurfaceId ? registeredSurfaces.get(cursor.parentSurfaceId) : undefined;
        }
      }
    } else if (input.parentSurfaceId) {
      return false;
    }
    return true;
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
    const validKinds: EmbeddedCdpSurfaceKind[] = ["website", "webapp", "browser", "service", "chat-work-panel"];
    const validSurfaceTypes = new Set([
      "agent-chat",
      "agent-copilot",
      "agent-overview",
      "agent-debug",
      "agent-btw",
      "agent-project",
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
      typeof input.surfaceRole === "string" &&
      typeof input.surfaceLevel === "string" &&
      typeof input.interaction === "string" &&
      validKinds.includes(input.surfaceKind) &&
      (input.surfaceKind !== "chat-work-panel" || Boolean(input.ownerChatId?.trim())) &&
      (input.surfaceType === undefined || validSurfaceTypes.has(input.surfaceType)) &&
      (input.serviceId === undefined || typeof input.serviceId === "string") &&
      (input.pageRoute === undefined || typeof input.pageRoute === "string") &&
      (input.ownerChatId === undefined || typeof input.ownerChatId === "string") &&
      identityMatchesRegistration(input) &&
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
    const canonicalSurfaceId = input.surfaceId.trim();
    const existingSurface = registeredSurfaces.get(canonicalSurfaceId);
    if (existingSurface && existingSurface.ownerWebContentsId !== ownerWebContentsId) {
      return false;
    }
    if (existingSurface && registeredSurfaceIdentitiesConflict(existingSurface, input)) {
      return false;
    }
    const parentSurface = input.parentSurfaceId
      ? registeredSurfaces.get(input.parentSurfaceId)
      : undefined;
    if (
      parentSurface && (
        parentSurface.ownerWebContentsId !== ownerWebContentsId ||
        Boolean(parentSurface.ownerChatId && input.ownerChatId && parentSurface.ownerChatId !== input.ownerChatId)
      )
    ) return false;
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
    registeredSurfaces.set(canonicalSurfaceId, registered);
    addDerivedAliases(registered);
    indexRegisteredSurface(registered);
    return true;
  }

  function unregisterSurface(input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number) {
    const surfaceId = typeof input?.surfaceId === "string" ? resolveCanonicalSurfaceId(input.surfaceId) : "";
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
    removeAliasesForSurface(surfaceId);
    removeGuestTargetsForSurface(surfaceId);
    removeChildSurfaces(surfaceId);
    return true;
  }

  function unregisterSurfacesForOwner(ownerWebContentsId: number) {
    for (const [surfaceId, surface] of registeredSurfaces) {
      if (surface.ownerWebContentsId === ownerWebContentsId) {
        registeredSurfaces.delete(surfaceId);
        removeAliasesForSurface(surfaceId);
        removeGuestTargetsForSurface(surfaceId);
        removeChildSurfaces(surfaceId);
      }
    }
  }

  function resolveRegisteredSurface(surfaceId: string) {
    const canonicalSurfaceId = resolveCanonicalSurfaceId(surfaceId);
    const registered = registeredSurfaces.get(canonicalSurfaceId);
    if (!registered) {
      return null;
    }
    const previousTabs = registered.tabs;
    const tabs = previousTabs.filter((tab) => {
      const contents = options.webContents.fromId(tab.webContentsId);
      return Boolean(contents && !contents.isDestroyed() && contents.getType() === "webview");
    });
    if (tabs.length === 0) {
      registeredSurfaces.delete(canonicalSurfaceId);
      removeAliasesForSurface(canonicalSurfaceId);
      removeGuestTargetsForSurface(canonicalSurfaceId);
      removeChildSurfaces(canonicalSurfaceId);
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

  function removeChildSurfaces(parentSurfaceId: string) {
    const children = [...registeredSurfaces.values()]
      .filter((surface) => surface.parentSurfaceId === parentSurfaceId)
      .map((surface) => surface.surfaceId);
    for (const childId of children) {
      registeredSurfaces.delete(childId);
      removeAliasesForSurface(childId);
      removeGuestTargetsForSurface(childId);
      removeChildSurfaces(childId);
    }
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

  function waitForWebviewSurfaceTarget(
    webContentsId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RegisteredWebviewSurfaceTarget | null> {
    const immediate = resolveWebviewSurfaceTarget(webContentsId);
    if (immediate) return Promise.resolve(immediate);
    if (
      signal?.aborted ||
      !Number.isSafeInteger(webContentsId) ||
      webContentsId <= 0
    ) {
      return Promise.resolve(null);
    }
    const guest = options.webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") {
      return Promise.resolve(null);
    }
    const owner = guest.hostWebContents;
    if (owner?.isDestroyed()) return Promise.resolve(null);
    const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const complete = (target: RegisteredWebviewSurfaceTarget | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        guest.removeListener("destroyed", handleAbort);
        owner?.removeListener("destroyed", handleAbort);
        const waiters = pendingGuestTargetWaiters.get(webContentsId);
        waiters?.delete(complete);
        if (waiters?.size === 0) pendingGuestTargetWaiters.delete(webContentsId);
        resolve(target);
      };
      const handleAbort = () => complete(null);
      const waiters = pendingGuestTargetWaiters.get(webContentsId) ?? new Set();
      waiters.add(complete);
      pendingGuestTargetWaiters.set(webContentsId, waiters);
      signal?.addEventListener("abort", handleAbort, { once: true });
      guest.once("destroyed", handleAbort);
      owner?.once("destroyed", handleAbort);
      timeout = setTimeout(() => complete(null), normalizedTimeoutMs);
      if (signal?.aborted || guest.isDestroyed() || owner?.isDestroyed()) complete(null);
    });
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

  function listBrowserSurfaces(): BrowserSurface[] {
    const builtinContents = findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
      builtinBrowserSurface(builtinContents),
      ...options.listWebEntries().items.map((item) => {
        const identity = createWebEntrySurfaceIdentity(item.kind, item.entryKey);
        const resolved = resolveRegisteredSurface(identity.surfaceId);
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

  function listRegisteredSurfaces(): BrowserSurface[] {
    const surfaces: BrowserSurface[] = [];
    for (const surfaceId of [...registeredSurfaces.keys()]) {
      const resolved = resolveRegisteredSurface(surfaceId);
      if (!resolved) continue;
      const activeTab = resolved.activeTab;
      const registered = resolved.registered;
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
        active: registered.active,
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
    listRegisteredSurfaces,
    getRegisteredSurfaceSnapshot,
    registerSurface,
    resolveCanonicalSurfaceId,
    resolveWebviewSurfaceTarget,
    waitForWebviewSurfaceTarget,
    unregisterSurface,
    unregisterSurfacesForOwner,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
