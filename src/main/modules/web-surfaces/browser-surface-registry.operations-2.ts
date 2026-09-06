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

export function createBrowserSurfaceRegistry_validateSurfaceRegistration_1(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation {
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
    if (!input || typeof input !== "object")
        return { ok: false, check: "invalid_input" };
    if (typeof input.registrationId !== "string" || !input.registrationId.trim()) {
        return { ok: false, check: "invalid_registration_id" };
    }
    if (typeof input.surfaceId !== "string" || !input.surfaceId.trim()) {
        return { ok: false, check: "invalid_surface_id" };
    }
    if (typeof input.surfaceRole !== "string" ||
        typeof input.surfaceLevel !== "string" ||
        typeof input.interaction !== "string")
        return { ok: false, check: "invalid_surface_identity" };
    if (!validKinds.includes(input.surfaceKind))
        return { ok: false, check: "invalid_surface_kind" };
    if (input.surfaceKind === "chat-work-panel" && !input.ownerChatId?.trim()) {
        return { ok: false, check: "missing_owner_chat" };
    }
    if (input.surfaceType !== undefined && !validSurfaceTypes.has(input.surfaceType)) {
        return { ok: false, check: "invalid_surface_type" };
    }
    if ((input.serviceId !== undefined && typeof input.serviceId !== "string") ||
        (input.pageRoute !== undefined && typeof input.pageRoute !== "string") ||
        (input.pageRouteIdentity !== undefined && typeof input.pageRouteIdentity !== "string") ||
        (input.ownerChatId !== undefined && typeof input.ownerChatId !== "string"))
        return { ok: false, check: "invalid_optional_fields" };
    if (input.presentationScope !== undefined &&
        input.presentationScope !== "main-workspace" &&
        !(input.presentationScope === "workpanel" && input.surfaceKind === "webapp" && Boolean(input.ownerChatId?.trim())))
        return { ok: false, check: "invalid_presentation_scope" };
    const identityValidation = context.validateRegistrationIdentity(input);
    if (!identityValidation.ok)
        return identityValidation;
    if (typeof input.label !== "string")
        return { ok: false, check: "invalid_label" };
    if (typeof input.url !== "string")
        return { ok: false, check: "invalid_url_field" };
    if (typeof input.active !== "boolean")
        return { ok: false, check: "invalid_active_flag" };
    if (!Array.isArray(input.tabs))
        return { ok: false, check: "invalid_tabs" };
    const tabIds = new Set<string>();
    const webContentsIds = new Set<number>();
    for (const tab of input.tabs) {
        if (!context.isValidSurfaceTab(tab))
            return { ok: false, check: "invalid_tab" };
        const tabId = tab.tabId.trim();
        if (tabIds.has(tabId) || webContentsIds.has(tab.webContentsId)) {
            return { ok: false, check: "duplicate_tab" };
        }
        tabIds.add(tabId);
        webContentsIds.add(tab.webContentsId);
    }
    if (input.activeTabId !== null &&
        (typeof input.activeTabId !== "string" || !tabIds.has(input.activeTabId.trim())))
        return { ok: false, check: "invalid_active_tab" };
    return { ok: true };
}

export function createBrowserSurfaceRegistry_registerSurfaceResult_2(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number): EmbeddedCdpSurfaceRegistrationResult {
    const validation = context.validateSurfaceRegistration(input);
    if (!validation.ok) {
        const rawSurfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
        const conflictingSurface = rawSurfaceId ? context.registeredSurfaces.get(rawSurfaceId) : undefined;
        if (conflictingSurface && registeredSurfaceIdentitiesConflict(conflictingSurface, input)) {
            return context.rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
                existing: context.summarizeRegisteredSurface(conflictingSurface),
                conflict: {
                    surfaceRoleMatches: conflictingSurface.surfaceRole === input.surfaceRole,
                    surfaceIdentityKeyMatches: (conflictingSurface.surfaceIdentityKey?.trim() || "") ===
                        (input.surfaceIdentityKey?.trim() || ""),
                },
            });
        }
        return context.rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
            invalidCheck: validation.check,
        });
    }
    if (!Number.isSafeInteger(ownerWebContentsId) || ownerWebContentsId <= 0) {
        return context.rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
            invalidCheck: "invalid_owner_webcontents_id",
        });
    }
    const canonicalSurfaceId = input.surfaceId.trim();
    const existingSurface = context.registeredSurfaces.get(canonicalSurfaceId);
    if (existingSurface && existingSurface.ownerWebContentsId !== ownerWebContentsId) {
        return context.rejectSurfaceRegistration(input, ownerWebContentsId, "owner_webcontents_conflict", {
            existing: context.summarizeRegisteredSurface(existingSurface),
        });
    }
    if (existingSurface && registeredSurfaceIdentitiesConflict(existingSurface, input)) {
        return context.rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
            existing: context.summarizeRegisteredSurface(existingSurface),
            conflict: {
                surfaceRoleMatches: existingSurface.surfaceRole === input.surfaceRole,
                surfaceIdentityKeyMatches: (existingSurface.surfaceIdentityKey?.trim() || "") ===
                    (input.surfaceIdentityKey?.trim() || ""),
            },
        });
    }
    const registrationInput = preserveInactiveMainChatIdentity(existingSurface, input);
    if (!mainChatSurfaceRegistrationTransitionAllowed(existingSurface, registrationInput)) {
        const activeTab = activeRegistrationTab(registrationInput);
        return context.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "main_chat_owner_transition_rejected", {
            ...(existingSurface ? { existing: context.summarizeRegisteredSurface(existingSurface) } : {}),
            conflict: {
                existingHasOwnerChatId: Boolean(existingSurface?.ownerChatId?.trim()),
                nextHasOwnerChatId: Boolean(registrationInput.ownerChatId?.trim()),
                pageRouteKind: describeMainChatRoute(registrationInput.pageRouteIdentity),
                guestRouteKind: describeMainChatRoute(activeTab?.currentUrl),
            },
        });
    }
    const parentSurface = registrationInput.parentSurfaceId
        ? context.registeredSurfaces.get(registrationInput.parentSurfaceId)
        : undefined;
    if (parentSurface && (parentSurface.ownerWebContentsId !== ownerWebContentsId ||
        Boolean(parentSurface.ownerChatId &&
            registrationInput.ownerChatId &&
            parentSurface.ownerChatId !== registrationInput.ownerChatId))) {
        return context.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "parent_surface_conflict", {
            existing: context.summarizeRegisteredSurface(parentSurface),
            conflict: {
                parentOwnerMatches: parentSurface.ownerWebContentsId === ownerWebContentsId,
                parentChatOwnerMatches: !(parentSurface.ownerChatId &&
                    registrationInput.ownerChatId &&
                    parentSurface.ownerChatId !== registrationInput.ownerChatId),
            },
        });
    }
    for (const tab of registrationInput.tabs) {
        const claimed = context.registeredGuestTargets.get(tab.webContentsId);
        if (claimed && claimed.surfaceId !== registrationInput.surfaceId) {
            const claimedSurface = context.registeredSurfaces.get(claimed.surfaceId);
            return context.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "guest_webcontents_claimed", {
                ...(claimedSurface ? { existing: context.summarizeRegisteredSurface(claimedSurface) } : {}),
                conflict: {
                    guestWebContentsId: tab.webContentsId,
                    claimedSurfaceId: sanitizeSurfaceDiagnosticId(claimed.surfaceId),
                    claimedRegistrationId: sanitizeSurfaceDiagnosticId(claimed.registrationId),
                    claimedOwnerWebContentsId: Number.isSafeInteger(claimed.ownerWebContentsId)
                        ? claimed.ownerWebContentsId
                        : null,
                },
            });
        }
    }
    const registered: RegisteredSurface = {
        ...registrationInput,
        registrationId: registrationInput.registrationId.trim(),
        surfaceId: registrationInput.surfaceId.trim(),
        label: registrationInput.label.trim(),
        url: registrationInput.url.trim(),
        tabs: registrationInput.tabs.map((tab) => ({
            ...tab,
            tabId: tab.tabId.trim(),
            currentUrl: tab.currentUrl.trim(),
            title: tab.title.trim(),
            ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl.trim() } : {})
        })),
        activeTabId: registrationInput.activeTabId?.trim() || null,
        ...(registrationInput.serviceId ? { serviceId: registrationInput.serviceId.trim() } : {}),
        ...(registrationInput.pageRoute ? { pageRoute: registrationInput.pageRoute.trim() } : {}),
        ...(registrationInput.pageRouteIdentity
            ? { pageRouteIdentity: registrationInput.pageRouteIdentity.trim() }
            : {}),
        ...(registrationInput.ownerChatId
            ? { ownerChatId: registrationInput.ownerChatId.trim() }
            : {}),
        ownerWebContentsId
    };
    context.registeredSurfaces.set(canonicalSurfaceId, registered);
    context.addDerivedAliases(registered);
    context.indexRegisteredSurface(registered);
    context.emitLifecycle("registered", registered);
    context.settleRegistrationDiagnostics(registrationInput);
    return { ok: true } satisfies EmbeddedCdpSurfaceRegistrationResult;
}

export function createBrowserSurfaceRegistry_registerSurface_3(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number): boolean {
    return context.registerSurfaceResult(input, ownerWebContentsId).ok;
}

export function createBrowserSurfaceRegistry_unregisterSurface_4(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number): boolean {
    const surfaceId = typeof input?.surfaceId === "string" ? context.resolveCanonicalSurfaceId(input.surfaceId) : "";
    const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
    const current = context.registeredSurfaces.get(surfaceId);
    if (!current ||
        current.registrationId !== registrationId ||
        current.ownerWebContentsId !== ownerWebContentsId) {
        return false;
    }
    context.registeredSurfaces.delete(surfaceId);
    context.emitLifecycle("unregistered", current);
    context.removeAliasesForSurface(surfaceId);
    context.removeGuestTargetsForSurface(surfaceId);
    context.removeChildSurfaces(surfaceId);
    return true;
}

export function createBrowserSurfaceRegistry_unregisterSurfacesForOwner_5(context: CreateBrowserSurfaceRegistryContext, ownerWebContentsId: number): void {
    for (const [surfaceId, surface] of context.registeredSurfaces) {
        if (surface.ownerWebContentsId === ownerWebContentsId) {
            context.registeredSurfaces.delete(surfaceId);
            context.emitLifecycle("unregistered", surface);
            context.removeAliasesForSurface(surfaceId);
            context.removeGuestTargetsForSurface(surfaceId);
            context.removeChildSurfaces(surfaceId);
        }
    }
}

export function createBrowserSurfaceRegistry_resolveRegisteredSurface_6(context: CreateBrowserSurfaceRegistryContext, surfaceId: string): { registered: RegisteredSurface; tabs: EmbeddedCdpSurfaceTabRegistration[]; activeTab: EmbeddedCdpSurfaceTabRegistration | null; contents: Electron.WebContents | null; } | null {
    const canonicalSurfaceId = context.resolveCanonicalSurfaceId(surfaceId);
    const registered = context.registeredSurfaces.get(canonicalSurfaceId);
    if (!registered) {
        return null;
    }
    const previousTabs = registered.tabs;
    const tabs = previousTabs.filter((tab) => {
        const contents = context.options.webContents.fromId(tab.webContentsId);
        return Boolean(contents && !contents.isDestroyed() && contents.getType() === "webview");
    });
    if (tabs.length === 0) {
        context.registeredSurfaces.delete(canonicalSurfaceId);
        context.emitLifecycle("unregistered", registered);
        context.removeAliasesForSurface(canonicalSurfaceId);
        context.removeGuestTargetsForSurface(canonicalSurfaceId);
        context.removeChildSurfaces(canonicalSurfaceId);
        return null;
    }
    if (tabs.length !== previousTabs.length) {
        registered.tabs = tabs;
        context.indexRegisteredSurface(registered);
    }
    if (!registered.activeTabId || !tabs.some((tab) => tab.tabId === registered.activeTabId)) {
        registered.activeTabId = selectSurvivingTabId(previousTabs.map((tab) => tab.tabId), tabs.map((tab) => tab.tabId), registered.activeTabId);
    }
    const activeTab = tabs.find((tab) => tab.tabId === registered.activeTabId) ?? null;
    const contents = activeTab ? context.options.webContents.fromId(activeTab.webContentsId) ?? null : null;
    return { registered, tabs, activeTab, contents };
}

export function createBrowserSurfaceRegistry_removeChildSurfaces_7(context: CreateBrowserSurfaceRegistryContext, parentSurfaceId: string): void {
    const children = [...context.registeredSurfaces.values()]
        .filter((surface) => surface.parentSurfaceId === parentSurfaceId)
        .map((surface) => surface.surfaceId);
    for (const childId of children) {
        const child = context.registeredSurfaces.get(childId);
        context.registeredSurfaces.delete(childId);
        if (child)
            context.emitLifecycle("unregistered", child);
        context.removeAliasesForSurface(childId);
        context.removeGuestTargetsForSurface(childId);
        context.removeChildSurfaces(childId);
    }
}

export function createBrowserSurfaceRegistry_findRegisteredSurfaceWebContents_8(context: CreateBrowserSurfaceRegistryContext, surfaceId: string, tabId?: string): Electron.WebContents | null {
    const resolved = context.resolveRegisteredSurface(surfaceId);
    if (!resolved) {
        return null;
    }
    const tab = tabId
        ? resolved.tabs.find((candidate) => candidate.tabId === tabId)
        : resolved.activeTab;
    return tab ? context.options.webContents.fromId(tab.webContentsId) ?? null : null;
}

export function createBrowserSurfaceRegistry_findWebContentsById_9(context: CreateBrowserSurfaceRegistryContext, webContentsId: number): Electron.WebContents | null {
    const contents = context.options.webContents.fromId(webContentsId);
    return contents && !contents.isDestroyed() && contents.getType() === "webview" ? contents : null;
}

export function createBrowserSurfaceRegistry_resolveWebviewSurfaceTarget_10(context: CreateBrowserSurfaceRegistryContext, webContentsId: number): { ownerChatId?: string; pageRouteIdentity?: string; pageRoute?: string; currentUrl: string; label: string; registrationId: string; surfaceId: string; surfaceKind: EmbeddedCdpSurfaceKind; surfaceType: NonNullable<EmbeddedCdpSurfaceRegistration["surfaceType"]>; surfaceIdentityKey?: string; serviceId?: string; tabId: string; webContentsId: number; ownerWebContentsId: number; active: boolean; presentationScope?: "main-workspace" | "workpanel"; surfaceRole: SurfaceRole; surfaceLevel: SurfaceIdentity["surfaceLevel"]; parentSurfaceId?: string; interaction: SurfaceIdentity["interaction"]; } | null {
    const indexed = context.registeredGuestTargets.get(webContentsId);
    if (!indexed) {
        return null;
    }
    const resolved = context.resolveRegisteredSurface(indexed.surfaceId);
    const tab = resolved?.tabs.find((candidate) => candidate.webContentsId === webContentsId);
    if (!resolved ||
        !tab ||
        resolved.registered.registrationId !== indexed.registrationId ||
        resolved.registered.ownerWebContentsId !== indexed.ownerWebContentsId) {
        context.registeredGuestTargets.delete(webContentsId);
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
    context.registeredGuestTargets.set(webContentsId, next);
    return next;
}

export function createBrowserSurfaceRegistry_waitForWebviewSurfaceTarget_11(context: CreateBrowserSurfaceRegistryContext, webContentsId: number, timeoutMs: number, signal?: AbortSignal): Promise<RegisteredWebviewSurfaceTarget | null> {
    return context.waitForWebviewSurfaceTargetMatching(webContentsId, () => true, timeoutMs, signal);
}
