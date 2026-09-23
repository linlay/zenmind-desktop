import { EmbeddedCdpSurfaceKind, EmbeddedCdpSurfaceRegistration } from "../../../shared/embedded-cdp";
import { type SurfaceIdentity, type SurfaceRole } from "../../../shared/surface-identity";
import type { BrowserSurfaceRegistryOptions, PendingGuestTargetWaiter, RegisteredSurface, RegisteredWebviewSurfaceTarget, ResolvedSurface } from "./registry-contracts";

export function guestTargetMatches(
  predicate: PendingGuestTargetWaiter["predicate"],
  target: RegisteredWebviewSurfaceTarget,
) {
  try {
    return predicate(target);
  } catch {
    return false;
  }
}

interface GuestResolutionDependencies {
  readonly resolveRegisteredSurface: (surfaceId: string) => ResolvedSurface | null;
}

/** Owns the derived guest index and bounded waiters; resolves trust against the registration store. */
export function createGuestResolution(options: Pick<BrowserSurfaceRegistryOptions, "webContents">, dependencies: GuestResolutionDependencies) {
  const registeredGuestTargets = new Map<number, RegisteredWebviewSurfaceTarget>();
  const pendingGuestTargetWaiters = new Map<number, Set<PendingGuestTargetWaiter>>();

  function settleGuestTargetWaiters(webContentsId: number, target: RegisteredWebviewSurfaceTarget | null): void {
    const waiters = pendingGuestTargetWaiters.get(webContentsId);
    if (!waiters)
      return;
    for (const waiter of [...waiters]) {
      if (target === null ||
        (waiter.registrationId && waiter.registrationId !== target.registrationId) ||
        guestTargetMatches(waiter.predicate, target)) {
        waiter.complete(target && waiter.registrationId && waiter.registrationId !== target.registrationId
          ? null
          : target);
      }
    }
  }

  function removeGuestTargetsForSurface(surfaceId: string, settleWaiters = true): void {
    for (const [webContentsId, target] of registeredGuestTargets) {
      if (target.surfaceId === surfaceId) {
        registeredGuestTargets.delete(webContentsId);
        if (settleWaiters)
          settleGuestTargetWaiters(webContentsId, null);
      }
    }
  }

  function indexRegisteredSurface(surface: RegisteredSurface): void {
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
        surfaceType: surface.surfaceType ?? surface.surfaceKind,
        ...(surface.surfaceIdentityKey
          ? { surfaceIdentityKey: surface.surfaceIdentityKey.trim() }
          : {}),
        ...(surface.serviceId ? { serviceId: surface.serviceId } : {}),
        ...(surface.pageRoute ? { pageRoute: surface.pageRoute } : {}),
        ...(surface.pageRouteIdentity ? { pageRouteIdentity: surface.pageRouteIdentity } : {}),
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ...(surface.presentationScope ? { presentationScope: surface.presentationScope } : {}),
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

  function findRegisteredSurfaceWebContents(surfaceId: string, tabId?: string): Electron.WebContents | null {
    const resolved = dependencies.resolveRegisteredSurface(surfaceId);
    if (!resolved) {
      return null;
    }
    const tab = tabId
      ? resolved.tabs.find((candidate) => candidate.tabId === tabId)
      : resolved.activeTab;
    return tab ? options.webContents.fromId(tab.webContentsId) ?? null : null;
  }

  function findWebContentsById(webContentsId: number): Electron.WebContents | null {
    const contents = options.webContents.fromId(webContentsId);
    return contents && !contents.isDestroyed() && contents.getType() === "webview" ? contents : null;
  }

  function resolveWebviewSurfaceTarget(webContentsId: number): { ownerChatId?: string; pageRouteIdentity?: string; pageRoute?: string; currentUrl: string; label: string; registrationId: string; surfaceId: string; surfaceKind: EmbeddedCdpSurfaceKind; surfaceType: NonNullable<EmbeddedCdpSurfaceRegistration["surfaceType"]>; surfaceIdentityKey?: string; serviceId?: string; tabId: string; webContentsId: number; ownerWebContentsId: number; active: boolean; presentationScope?: "main-workspace" | "workpanel"; surfaceRole: SurfaceRole; surfaceLevel: SurfaceIdentity["surfaceLevel"]; parentSurfaceId?: string; interaction: SurfaceIdentity["interaction"]; } | null {
    const indexed = registeredGuestTargets.get(webContentsId);
    if (!indexed) {
      return null;
    }
    const resolved = dependencies.resolveRegisteredSurface(indexed.surfaceId);
    const tab = resolved?.tabs.find((candidate) => candidate.webContentsId === webContentsId);
    if (!resolved ||
      !tab ||
      resolved.registered.registrationId !== indexed.registrationId ||
      resolved.registered.ownerWebContentsId !== indexed.ownerWebContentsId) {
      registeredGuestTargets.delete(webContentsId);
      return null;
    }
    const next = {
      ...indexed,
      currentUrl: tab.currentUrl,
      label: resolved.registered.label,
      ...(resolved.registered.pageRoute ? { pageRoute: resolved.registered.pageRoute } : {}),
      ...(resolved.registered.pageRouteIdentity
        ? { pageRouteIdentity: resolved.registered.pageRouteIdentity }
        : {}),
      ...(resolved.registered.ownerChatId ? { ownerChatId: resolved.registered.ownerChatId } : {})
    };
    registeredGuestTargets.set(webContentsId, next);
    return next;
  }

  function waitForWebviewSurfaceTarget(webContentsId: number, timeoutMs: number, signal?: AbortSignal): Promise<RegisteredWebviewSurfaceTarget | null> {
    return waitForWebviewSurfaceTargetMatching(webContentsId, () => true, timeoutMs, signal);
  }

  function waitForWebviewSurfaceTargetMatching(webContentsId: number, predicate: (target: RegisteredWebviewSurfaceTarget) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<RegisteredWebviewSurfaceTarget | null> {
    if (signal?.aborted ||
      typeof predicate !== "function" ||
      !Number.isSafeInteger(webContentsId) ||
      webContentsId <= 0) {
      return Promise.resolve(null);
    }
    const immediate = resolveWebviewSurfaceTarget(webContentsId);
    if (immediate && guestTargetMatches(predicate, immediate)) {
      return Promise.resolve(immediate);
    }
    const guest = options.webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") {
      return Promise.resolve(null);
    }
    const owner = guest.hostWebContents;
    if (owner?.isDestroyed())
      return Promise.resolve(null);
    const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let waiter: PendingGuestTargetWaiter;
      const complete = (target: RegisteredWebviewSurfaceTarget | null) => {
        if (settled)
          return;
        settled = true;
        if (timeout)
          clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        guest.removeListener("destroyed", handleAbort);
        owner?.removeListener("destroyed", handleAbort);
        const waiters = pendingGuestTargetWaiters.get(webContentsId);
        waiters?.delete(waiter);
        if (waiters?.size === 0)
          pendingGuestTargetWaiters.delete(webContentsId);
        resolve(target);
      };
      const handleAbort = () => complete(null);
      waiter = {
        registrationId: immediate?.registrationId ?? null,
        predicate,
        complete,
      };
      const waiters = pendingGuestTargetWaiters.get(webContentsId) ?? new Set();
      waiters.add(waiter);
      pendingGuestTargetWaiters.set(webContentsId, waiters);
      signal?.addEventListener("abort", handleAbort, { once: true });
      guest.once("destroyed", handleAbort);
      owner?.once("destroyed", handleAbort);
      timeout = setTimeout(() => complete(null), normalizedTimeoutMs);
      if (signal?.aborted || guest.isDestroyed() || owner?.isDestroyed())
        complete(null);
    });
  }

  function findWebContentsForSurfaceUrl(surfaceUrl: string): Electron.WebContents | null {
    let target: URL | null = null;
    try {
      target = new URL(surfaceUrl);
    }
    catch {
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
        return (current.href === target.href ||
          current.hostname === target.hostname ||
          current.href.startsWith(target.href));
      }
      catch {
        return false;
      }
    }) ?? null;
  }

  function findGuestClaim(webContentsId: number) { return registeredGuestTargets.get(webContentsId); }

  return { removeGuestTargetsForSurface, indexRegisteredSurface, findRegisteredSurfaceWebContents, findWebContentsById, resolveWebviewSurfaceTarget, waitForWebviewSurfaceTarget, waitForWebviewSurfaceTargetMatching, findWebContentsForSurfaceUrl, findGuestClaim };
}
