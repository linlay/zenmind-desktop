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

export function createBrowserSurfaceRegistry_emitLifecycle_1(context: CreateBrowserSurfaceRegistryContext, type: BrowserSurfaceLifecycleEvent["type"], surface: RegisteredSurface): void {
    const event: BrowserSurfaceLifecycleEvent = {
        type,
        surface: {
            registrationId: surface.registrationId,
            surfaceId: surface.surfaceId,
            surfaceRole: surface.surfaceRole,
            surfaceIdentityKey: surface.surfaceIdentityKey?.trim() || "",
            active: surface.active,
            ownerChatId: surface.ownerChatId?.trim() || "",
            ownerWebContentsId: surface.ownerWebContentsId,
            guestWebContentsIds: surface.tabs.map((tab) => tab.webContentsId),
        },
    };
    for (const listener of context.lifecycleListeners) {
        try {
            listener(event);
        }
        catch {
            // Lifecycle observers must not affect surface registration.
        }
    }
}

export function createBrowserSurfaceRegistry_subscribeLifecycle_2(context: CreateBrowserSurfaceRegistryContext, listener: (event: BrowserSurfaceLifecycleEvent) => void): () => boolean {
    context.lifecycleListeners.add(listener);
    return () => context.lifecycleListeners.delete(listener);
}

export function createBrowserSurfaceRegistry_reportRegistrationDiagnostic_3(context: CreateBrowserSurfaceRegistryContext, diagnostic: SurfaceRegistrationDiagnostic): void {
    try {
        context.options.reportRegistrationDiagnostic?.(diagnostic);
    }
    catch {
        // Diagnostics must never affect surface authorization or registration.
    }
}

export function createBrowserSurfaceRegistry_summarizeRegisteredSurface_4(context: CreateBrowserSurfaceRegistryContext, surface: RegisteredSurface): { registrationId: string; surfaceId: string; surfaceRole: string; ownerWebContentsId: number | null; guestWebContentsIds: number[]; } {
    return {
        registrationId: sanitizeSurfaceDiagnosticId(surface.registrationId),
        surfaceId: sanitizeSurfaceDiagnosticId(surface.surfaceId),
        surfaceRole: sanitizeSurfaceDiagnosticEnum(surface.surfaceRole),
        ownerWebContentsId: Number.isSafeInteger(surface.ownerWebContentsId)
            ? surface.ownerWebContentsId
            : null,
        guestWebContentsIds: diagnosticGuestWebContentsIds(surface),
    };
}

export function createBrowserSurfaceRegistry_createRegistrationDiagnostic_5(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">): SurfaceRegistrationDiagnostic {
    const candidate = input as unknown as Record<string, unknown> | null;
    return {
        event: "surface-registration-rejected",
        reason,
        registrationId: sanitizeSurfaceDiagnosticId(candidate?.registrationId),
        surfaceId: sanitizeSurfaceDiagnosticId(candidate?.surfaceId),
        surfaceKind: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceKind),
        surfaceRole: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceRole),
        surfaceLevel: sanitizeSurfaceDiagnosticEnum(candidate?.surfaceLevel),
        ownerWebContentsId: Number.isSafeInteger(ownerWebContentsId) && ownerWebContentsId > 0
            ? ownerWebContentsId
            : null,
        guestWebContentsIds: diagnosticGuestWebContentsIds(input),
        parentSurfaceId: sanitizeSurfaceDiagnosticId(candidate?.parentSurfaceId),
        presentationScope: sanitizeSurfaceDiagnosticEnum(candidate?.presentationScope),
        hasOwnerChatId: typeof candidate?.ownerChatId === "string" && Boolean(candidate.ownerChatId.trim()),
        ...details,
        occurrenceCount: 1,
    };
}

export function createBrowserSurfaceRegistry_flushRegistrationDiagnostic_6(context: CreateBrowserSurfaceRegistryContext, key: string, resolution: NonNullable<SurfaceRegistrationDiagnostic["resolution"]>): void {
    const pending = context.pendingRegistrationDiagnostics.get(key);
    if (!pending)
        return;
    context.pendingRegistrationDiagnostics.delete(key);
    if (pending.timer)
        clearTimeout(pending.timer);
    if (pending.count <= 1)
        return;
    context.reportRegistrationDiagnostic({
        ...pending.diagnostic,
        event: "surface-registration-rejection-summary",
        occurrenceCount: pending.count,
        resolution,
    });
}

export function createBrowserSurfaceRegistry_scheduleRegistrationDiagnosticFlush_7(context: CreateBrowserSurfaceRegistryContext, key: string): void {
    const pending = context.pendingRegistrationDiagnostics.get(key);
    if (!pending)
        return;
    if (pending.timer)
        clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
        context.flushRegistrationDiagnostic(key, "retry_window_expired");
    }, context.registrationDiagnosticDedupWindowMs);
    pending.timer.unref?.();
}

export function createBrowserSurfaceRegistry_rejectSurfaceRegistration_8(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">): EmbeddedCdpSurfaceRegistrationResult {
    const diagnostic = context.createRegistrationDiagnostic(input, ownerWebContentsId, reason, details);
    const key = `${diagnostic.registrationId}\u0000${reason}`;
    const pending = context.pendingRegistrationDiagnostics.get(key);
    if (pending) {
        pending.count += 1;
        pending.diagnostic = diagnostic;
        context.scheduleRegistrationDiagnosticFlush(key);
        return {
            ok: false,
            reason: reason === "invalid_registration"
                ? "invalid_registration"
                : reason === "main_chat_owner_transition_rejected"
                    ? "route_not_aligned"
                    : "ownership_conflict",
        };
    }
    context.pendingRegistrationDiagnostics.set(key, { diagnostic, count: 1, timer: null });
    context.reportRegistrationDiagnostic(diagnostic);
    context.scheduleRegistrationDiagnosticFlush(key);
    return {
        ok: false,
        reason: reason === "invalid_registration"
            ? "invalid_registration"
            : reason === "main_chat_owner_transition_rejected"
                ? "route_not_aligned"
                : "ownership_conflict",
    };
}

export function createBrowserSurfaceRegistry_settleRegistrationDiagnostics_9(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration): void {
    const registrationId = sanitizeSurfaceDiagnosticId(input.registrationId);
    const surfaceId = sanitizeSurfaceDiagnosticId(input.surfaceId);
    for (const [key, pending] of context.pendingRegistrationDiagnostics) {
        if (pending.diagnostic.registrationId === registrationId) {
            context.flushRegistrationDiagnostic(key, "registered");
        }
        else if (pending.diagnostic.surfaceId === surfaceId) {
            context.flushRegistrationDiagnostic(key, "replaced");
        }
    }
}

export function createBrowserSurfaceRegistry_resolveCanonicalSurfaceId_10(context: CreateBrowserSurfaceRegistryContext, surfaceId: string): string {
    const normalized = surfaceId.trim();
    const canonical = context.surfaceAliases.get(normalized) ?? resolveLegacyFixedSurfaceId(normalized);
    if (canonical !== normalized) {
        reportDeprecatedCompatibilityUse("surface.legacy-alias", {
            category: LEGACY_FIXED_SURFACE_ID_ALIASES[normalized] ? "fixed" : "derived",
            canonicalRole: context.registeredSurfaces.get(canonical)?.surfaceRole ??
                resolveFixedSurfaceRole(canonical) ??
                "unknown"
        });
    }
    return canonical;
}

export function createBrowserSurfaceRegistry_removeAliasesForSurface_11(context: CreateBrowserSurfaceRegistryContext, surfaceId: string): void {
    for (const [alias, canonical] of context.surfaceAliases) {
        if (canonical === surfaceId && LEGACY_FIXED_SURFACE_ID_ALIASES[alias] !== canonical) {
            context.surfaceAliases.delete(alias);
        }
    }
}

export function createBrowserSurfaceRegistry_addDerivedAliases_12(context: CreateBrowserSurfaceRegistryContext, surface: RegisteredSurface): void {
    const identityKey = surface.surfaceIdentityKey?.trim() || "";
    for (const alias of createLegacySurfaceIdAliases(surface.surfaceRole, identityKey)) {
        if (!alias || alias === surface.surfaceId)
            continue;
        const current = context.surfaceAliases.get(alias);
        if (!current || current === surface.surfaceId)
            context.surfaceAliases.set(alias, surface.surfaceId);
    }
}

export function createBrowserSurfaceRegistry_fallbackSurfaceType_13(context: CreateBrowserSurfaceRegistryContext, surfaceKind: EmbeddedCdpSurfaceKind): EmbeddedCdpSurfaceKind {
    return surfaceKind;
}

export function createBrowserSurfaceRegistry_settleGuestTargetWaiters_14(context: CreateBrowserSurfaceRegistryContext, webContentsId: number, target: RegisteredWebviewSurfaceTarget | null): void {
    const waiters = context.pendingGuestTargetWaiters.get(webContentsId);
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

export function createBrowserSurfaceRegistry_removeGuestTargetsForSurface_15(context: CreateBrowserSurfaceRegistryContext, surfaceId: string, settleWaiters?: boolean): void {
    for (const [webContentsId, target] of context.registeredGuestTargets) {
        if (target.surfaceId === surfaceId) {
            context.registeredGuestTargets.delete(webContentsId);
            if (settleWaiters)
                context.settleGuestTargetWaiters(webContentsId, null);
        }
    }
}

export function createBrowserSurfaceRegistry_indexRegisteredSurface_16(context: CreateBrowserSurfaceRegistryContext, surface: RegisteredSurface): void {
    const previousWebContentsIds = new Set<number>();
    for (const [webContentsId, target] of context.registeredGuestTargets) {
        if (target.surfaceId === surface.surfaceId) {
            previousWebContentsIds.add(webContentsId);
            context.registeredGuestTargets.delete(webContentsId);
        }
    }
    const nextWebContentsIds = new Set<number>();
    for (const tab of surface.tabs) {
        const target: RegisteredWebviewSurfaceTarget = {
            registrationId: surface.registrationId,
            surfaceId: surface.surfaceId,
            surfaceKind: surface.surfaceKind,
            surfaceType: surface.surfaceType ?? context.fallbackSurfaceType(surface.surfaceKind),
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
        context.registeredGuestTargets.set(tab.webContentsId, target);
        context.settleGuestTargetWaiters(tab.webContentsId, target);
    }
    for (const webContentsId of previousWebContentsIds) {
        if (!nextWebContentsIds.has(webContentsId)) {
            context.settleGuestTargetWaiters(webContentsId, null);
        }
    }
}

export function createBrowserSurfaceRegistry_expectedRolesForRegistration_17(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration): ("main-chat" | "kanban-chat" | "browser" | "website" | "webapp" | "copilot-dock" | "overview" | "debug" | "btw" | "source" | "project" | "file-diff" | "artifact" | "reference" | "file" | "planning" | "agent" | "copilot" | "skill" | "workpanel-web" | "service" | "help" | "plugin-settings")[] {
    if (input.surfaceKind === "website")
        return ["website"];
    if (input.surfaceKind === "webapp")
        return ["webapp"];
    if (input.surfaceKind === "browser")
        return ["browser"];
    if (input.surfaceKind === "chat-work-panel")
        return ["workpanel-web"];
    if (input.surfaceType === "help")
        return ["help"];
    if (input.surfaceType === "agent-overview")
        return ["overview"];
    if (input.surfaceType === "agent-debug")
        return ["debug"];
    if (input.surfaceType === "agent-btw")
        return ["btw"];
    if (input.surfaceType === "agent-project" || input.surfaceType === "project")
        return ["project"];
    if (input.surfaceType === "agent-chat")
        return ["main-chat", "kanban-chat"];
    if (input.surfaceType === "agent-copilot")
        return ["copilot-dock", "copilot"];
    if (input.surfaceType === "agent-management") {
        return ["service", "source", "file-diff", "artifact", "reference", "file", "planning", "agent", "skill"];
    }
    return ["service", "plugin-settings"];
}

export function createBrowserSurfaceRegistry_validateRegistrationIdentity_18(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation {
    const identityKey = input.surfaceIdentityKey?.trim() || "";
    if (!surfaceIdentityMatchesPolicy(input, identityKey)) {
        return { ok: false, check: "role_policy_mismatch" };
    }
    if (!context.expectedRolesForRegistration(input).includes(input.surfaceRole)) {
        return { ok: false, check: "role_policy_mismatch" };
    }
    if (input.surfaceRole === "website" || input.surfaceRole === "webapp") {
        const entry = context.options.listWebEntries().items.find((item) => item.entryKey === identityKey);
        if (!entry)
            return { ok: false, check: "entry_not_found" };
        if (entry.kind !== input.surfaceRole)
            return { ok: false, check: "entry_kind_mismatch" };
        if (input.pageRoute !== `/webs/${identityKey}`) {
            return { ok: false, check: "entry_route_mismatch" };
        }
    }
    if ((input.surfaceRole === "service" || input.surfaceRole === "plugin-settings") &&
        input.serviceId?.trim() !== identityKey)
        return { ok: false, check: "service_identity_mismatch" };
    if (["main-chat", "kanban-chat", "copilot-dock", "overview", "debug", "btw", "source", "project", "file-diff", "artifact", "reference", "file", "planning", "agent", "copilot", "skill"].includes(input.surfaceRole) &&
        input.serviceId?.trim() !== "agent-webclient")
        return { ok: false, check: "agent_webclient_service_mismatch" };
    if ((input.surfaceRole === "main-chat" && input.surfaceId !== MAIN_CHAT_SURFACE_ID) ||
        (input.surfaceRole === "kanban-chat" && input.surfaceId !== KANBAN_CHAT_SURFACE_ID) ||
        (input.surfaceRole === "copilot-dock" && input.surfaceId !== COPILOT_DOCK_SURFACE_ID))
        return { ok: false, check: "fixed_surface_id_mismatch" };
    if (input.surfaceRole === "copilot-dock" &&
        input.surfaceIdentityKey?.trim() === "desktop-route:/kanban")
        return { ok: false, check: "forbidden_route" };
    if (input.surfaceLevel === "child") {
        if (!input.parentSurfaceId && input.surfaceRole !== "project" && input.surfaceRole !== "copilot-dock") {
            return { ok: false, check: "missing_parent_surface" };
        }
        if (input.parentSurfaceId) {
            const canonicalParentSurfaceId = context.resolveCanonicalSurfaceId(input.parentSurfaceId);
            if (canonicalParentSurfaceId !== input.parentSurfaceId ||
                canonicalParentSurfaceId === input.surfaceId ||
                !context.resolveRegisteredSurface(canonicalParentSurfaceId))
                return { ok: false, check: "invalid_parent_surface" };
            const visited = new Set([input.surfaceId]);
            let cursor = context.registeredSurfaces.get(canonicalParentSurfaceId);
            while (cursor) {
                if (visited.has(cursor.surfaceId))
                    return { ok: false, check: "parent_cycle" };
                visited.add(cursor.surfaceId);
                cursor = cursor.parentSurfaceId ? context.registeredSurfaces.get(cursor.parentSurfaceId) : undefined;
            }
        }
    }
    else if (input.parentSurfaceId) {
        return { ok: false, check: "unexpected_parent_surface" };
    }
    return { ok: true };
}

export function createBrowserSurfaceRegistry_isValidSurfaceTab_19(context: CreateBrowserSurfaceRegistryContext, input: EmbeddedCdpSurfaceTabRegistration): boolean {
    return Boolean(input &&
        typeof input.tabId === "string" &&
        input.tabId.trim() &&
        typeof input.currentUrl === "string" &&
        typeof input.title === "string" &&
        Number.isSafeInteger(input.webContentsId) &&
        input.webContentsId > 0 &&
        typeof input.canGoBack === "boolean" &&
        typeof input.canGoForward === "boolean" &&
        typeof input.isLoading === "boolean");
}
