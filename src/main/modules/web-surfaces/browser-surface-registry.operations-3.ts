import type { WebContents } from "electron";

import type { DesktopPageContextSnapshot } from "../../../shared/contracts";

import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRegistrationResult,
  EmbeddedCdpSurfaceRemoval,
  EmbeddedCdpSurfaceTabRegistration,
  EmbeddedCdpSiteSurfaceKind,
  EmbeddedCdpSurfaceKind
} from "../../../shared/embedded-cdp";

import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../../shared/browser-surfaces";

import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource
} from "../../../shared/canonical-chat-sync";

import { readAgentWebclientAgentRouteKey } from "../../../shared/agent-webclient-routes";

import { selectSurvivingTabId } from "../../../shared/web-tab-lifecycle";

import {
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  LEGACY_FIXED_SURFACE_ID_ALIASES,
  MAIN_CHAT_SURFACE_ID,
  createLegacySurfaceIdAliases,
  createWebEntrySurfaceIdentity,
  resolveFixedSurfaceRole,
  resolveLegacyFixedSurfaceId,
  surfaceIdentityMatchesPolicy,
  type SurfaceIdentity,
  type SurfaceRole
} from "../../../shared/surface-identity";

import { reportDeprecatedCompatibilityUse } from "../../support/logging/deprecated-compatibility";

import type { CreateBrowserSurfaceRegistryContext } from "./browser-surface-registry.shared";

import { BrowserSurface, BrowserSurfaceDiagnosticSnapshot, BrowserSurfaceLifecycleEvent, BrowserSurfaceRegistryOptions, BrowserSurfaceTab, BrowserWebContentsDiagnosticSnapshot, PendingGuestTargetWaiter, PendingSurfaceRegistrationDiagnostic, RegisteredSurface, RegisteredWebviewSurfaceTarget, SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN, SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN, SurfaceRegistrationDiagnostic, SurfaceRegistrationInvalidCheck, SurfaceRegistrationRejectionReason, SurfaceRegistrationValidation, WebContentsAccess, activeRegistrationTab, describeMainChatRoute, diagnosticGuestWebContentsIds, guestTargetMatches, isMainChatSurfaceRegistration, mainChatSurfaceRegistrationTransitionAllowed, normalizeSurfaceMatchText, preserveInactiveMainChatIdentity, registeredSurfaceIdentitiesConflict, sameNewChatSource, sanitizeSurfaceDiagnosticEnum, sanitizeSurfaceDiagnosticId, webEntryMatchesSurfaceTarget } from "./browser-surface-registry.shared";

export function createBrowserSurfaceRegistry_waitForWebviewSurfaceTargetMatching_1(context: CreateBrowserSurfaceRegistryContext, webContentsId: number, predicate: (target: RegisteredWebviewSurfaceTarget) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<RegisteredWebviewSurfaceTarget | null> {
    if (signal?.aborted ||
        typeof predicate !== "function" ||
        !Number.isSafeInteger(webContentsId) ||
        webContentsId <= 0) {
        return Promise.resolve(null);
    }
    const immediate = context.resolveWebviewSurfaceTarget(webContentsId);
    if (immediate && guestTargetMatches(predicate, immediate)) {
        return Promise.resolve(immediate);
    }
    const guest = context.options.webContents.fromId(webContentsId);
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
            const waiters = context.pendingGuestTargetWaiters.get(webContentsId);
            waiters?.delete(waiter);
            if (waiters?.size === 0)
                context.pendingGuestTargetWaiters.delete(webContentsId);
            resolve(target);
        };
        const handleAbort = () => complete(null);
        waiter = {
            registrationId: immediate?.registrationId ?? null,
            predicate,
            complete,
        };
        const waiters = context.pendingGuestTargetWaiters.get(webContentsId) ?? new Set();
        waiters.add(waiter);
        context.pendingGuestTargetWaiters.set(webContentsId, waiters);
        signal?.addEventListener("abort", handleAbort, { once: true });
        guest.once("destroyed", handleAbort);
        owner?.once("destroyed", handleAbort);
        timeout = setTimeout(() => complete(null), normalizedTimeoutMs);
        if (signal?.aborted || guest.isDestroyed() || owner?.isDestroyed())
            complete(null);
    });
}

export function createBrowserSurfaceRegistry_currentPageSnapshotMatchesSurface_2(context: CreateBrowserSurfaceRegistryContext, surfaceId: string, contents?: WebContents | null): boolean {
    const currentPageSnapshot = context.options.getCurrentPageSnapshot();
    const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
    return currentPageSnapshot?.pageKind === "webview" && (currentPageSnapshot.surfaceId === surfaceId ||
        snapshotBrowserTarget?.surfaceId === surfaceId ||
        (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id));
}

export function createBrowserSurfaceRegistry_findWebContentsForSurfaceUrl_3(context: CreateBrowserSurfaceRegistryContext, surfaceUrl: string): Electron.WebContents | null {
    let target: URL | null = null;
    try {
        target = new URL(surfaceUrl);
    }
    catch {
        return null;
    }
    return context.options.webContents.getAllWebContents().find((contents) => {
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

export function createBrowserSurfaceRegistry_builtinBrowserSurface_4(context: CreateBrowserSurfaceRegistryContext, contents: WebContents | null, url: string): BrowserSurface {
    const resolved = context.resolveRegisteredSurface(BUILTIN_BROWSER_SURFACE_ID);
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
        active: context.currentPageSnapshotMatchesSurface(BUILTIN_BROWSER_SURFACE_ID, activeContents),
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

export function createBrowserSurfaceRegistry_listBrowserSurfaces_5(context: CreateBrowserSurfaceRegistryContext): BrowserSurface[] {
    const builtinContents = context.findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
        context.builtinBrowserSurface(builtinContents),
        ...context.options.listWebEntries().items.map((item) => {
            const identity = createWebEntrySurfaceIdentity(item.kind, item.entryKey);
            const resolved = context.resolveRegisteredSurface(identity.surfaceId);
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
                    context.currentPageSnapshotMatchesSurface(identity.surfaceId, contents),
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

export function createBrowserSurfaceRegistry_listChatWorkPanelSurfaces_6(context: CreateBrowserSurfaceRegistryContext): BrowserSurface[] {
    const surfaces: BrowserSurface[] = [];
    for (const [surfaceId, candidate] of context.registeredSurfaces) {
        if (candidate.surfaceKind !== "chat-work-panel") {
            continue;
        }
        const resolved = context.resolveRegisteredSurface(surfaceId);
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

export function createBrowserSurfaceRegistry_listRegisteredSurfaces_7(context: CreateBrowserSurfaceRegistryContext): BrowserSurface[] {
    const surfaces: BrowserSurface[] = [];
    for (const surfaceId of [...context.registeredSurfaces.keys()]) {
        const resolved = context.resolveRegisteredSurface(surfaceId);
        if (!resolved)
            continue;
        const activeTab = resolved.activeTab;
        const registered = resolved.registered;
        const activeContents = activeTab
            ? context.options.webContents.fromId(activeTab.webContentsId)
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
                context.currentPageSnapshotMatchesSurface(registered.surfaceId, activeContents),
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

export function createBrowserSurfaceRegistry_listDiagnosticSurfaces_8(context: CreateBrowserSurfaceRegistryContext): BrowserSurfaceDiagnosticSnapshot[] {
    const surfaces: BrowserSurfaceDiagnosticSnapshot[] = [];
    for (const surfaceId of [...context.registeredSurfaces.keys()]) {
        const resolved = context.resolveRegisteredSurface(surfaceId);
        if (!resolved)
            continue;
        const registered = resolved.registered;
        surfaces.push({
            registrationId: registered.registrationId,
            surfaceId: registered.surfaceId,
            surfaceKind: registered.surfaceKind,
            surfaceType: registered.surfaceType ?? context.fallbackSurfaceType(registered.surfaceKind),
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

export function createBrowserSurfaceRegistry_listWebContentsDiagnostics_9(context: CreateBrowserSurfaceRegistryContext): BrowserWebContentsDiagnosticSnapshot[] {
    return context.options.webContents.getAllWebContents().flatMap((contents) => {
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

export function createBrowserSurfaceRegistry_getRegisteredSurfaceSnapshot_10(context: CreateBrowserSurfaceRegistryContext, surfaceId: string, registrationId: string, ownerWebContentsId: number): { registered: RegisteredSurface; tabs: EmbeddedCdpSurfaceTabRegistration[]; } | null {
    const resolved = context.resolveRegisteredSurface(surfaceId);
    if (!resolved ||
        resolved.registered.registrationId !== registrationId ||
        resolved.registered.ownerWebContentsId !== ownerWebContentsId) {
        return null;
    }
    return {
        registered: resolved.registered,
        tabs: resolved.tabs
    };
}
