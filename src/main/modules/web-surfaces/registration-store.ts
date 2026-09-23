import { EmbeddedCdpSurfaceRegistration, EmbeddedCdpSurfaceRegistrationResult, EmbeddedCdpSurfaceRemoval, EmbeddedCdpSurfaceTabRegistration } from "../../../shared/embedded-cdp";
import { LEGACY_FIXED_SURFACE_ID_ALIASES, createLegacySurfaceIdAliases, resolveFixedSurfaceRole, resolveLegacyFixedSurfaceId } from "../../../shared/surface-identity";
import { selectSurvivingTabId } from "../../../shared/web-tab-lifecycle";
import { reportDeprecatedCompatibilityUse } from "../../support/logging/deprecated-compatibility";
import { createGuestResolution } from "./guest-resolution";
import { createRegistrationDiagnostics, sanitizeSurfaceDiagnosticId } from "./registration-diagnostics";
import { activeRegistrationTab, createRegistrationPolicy, describeMainChatRoute, mainChatSurfaceRegistrationTransitionAllowed, preserveInactiveMainChatIdentity, registeredSurfaceIdentitiesConflict } from "./registration-policy";
import type { BrowserSurfaceLifecycleEvent, BrowserSurfaceRegistryOptions, RegisteredSurface, ResolvedSurface, WorkPanelDialogReservation } from "./registry-contracts";

/** Owns the authoritative registrations, aliases, reservations and lifecycle order. */
export function createRegistrationStore(options: BrowserSurfaceRegistryOptions) {
  const registeredSurfaces = new Map<string, RegisteredSurface>();
  const workPanelDialogRegistrations = new Map<string, WorkPanelDialogReservation>();
  const surfaceAliases = new Map<string, string>(Object.entries(LEGACY_FIXED_SURFACE_ID_ALIASES));
  const lifecycleListeners = new Set<(event: BrowserSurfaceLifecycleEvent) => void>();
  const diagnostics = createRegistrationDiagnostics(options);
  const guest = createGuestResolution(options, { resolveRegisteredSurface });
  const policy = createRegistrationPolicy(options, { registeredSurfaces, workPanelDialogRegistrations, resolveCanonicalSurfaceId, resolveRegisteredSurface });

  function emitLifecycle(type: BrowserSurfaceLifecycleEvent["type"], surface: RegisteredSurface): void {
    const event: BrowserSurfaceLifecycleEvent = {
      type,
      surface: {
        registrationId: surface.registrationId,
        surfaceId: surface.surfaceId,
        surfaceRole: surface.surfaceRole,
        surfaceIdentityKey: surface.surfaceIdentityKey?.trim() || "",
        active: surface.active,
        ownerChatId: surface.ownerChatId?.trim() || "",
        pageRouteIdentity: surface.pageRouteIdentity?.trim() || "",
        ownerWebContentsId: surface.ownerWebContentsId,
        guestWebContentsIds: surface.tabs.map((tab) => tab.webContentsId),
      },
    };
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      }
      catch {
        // Lifecycle observers must not affect surface registration.
      }
    }
  }

  function subscribeLifecycle(listener: (event: BrowserSurfaceLifecycleEvent) => void): () => boolean {
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  }

  function resolveCanonicalSurfaceId(surfaceId: string): string {
    const normalized = surfaceId.trim();
    const canonical = surfaceAliases.get(normalized) ?? resolveLegacyFixedSurfaceId(normalized);
    if (canonical !== normalized) {
      reportDeprecatedCompatibilityUse("surface.legacy-alias", {
        category: LEGACY_FIXED_SURFACE_ID_ALIASES[normalized] ? "fixed" : "derived",
        canonicalRole: registeredSurfaces.get(canonical)?.surfaceRole ??
          resolveFixedSurfaceRole(canonical) ??
          "unknown"
      });
    }
    return canonical;
  }

  function removeAliasesForSurface(surfaceId: string): void {
    for (const [alias, canonical] of surfaceAliases) {
      if (canonical === surfaceId && LEGACY_FIXED_SURFACE_ID_ALIASES[alias] !== canonical) {
        surfaceAliases.delete(alias);
      }
    }
  }

  function addDerivedAliases(surface: RegisteredSurface): void {
    const identityKey = surface.surfaceIdentityKey?.trim() || "";
    for (const alias of createLegacySurfaceIdAliases(surface.surfaceRole, identityKey)) {
      if (!alias || alias === surface.surfaceId)
        continue;
      const current = surfaceAliases.get(alias);
      if (!current || current === surface.surfaceId)
        surfaceAliases.set(alias, surface.surfaceId);
    }
  }

  function registerSurfaceResult(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number): EmbeddedCdpSurfaceRegistrationResult {
    const validation = policy.validateSurfaceRegistration(input);
    if (!validation.ok) {
      const rawSurfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
      const conflictingSurface = rawSurfaceId ? registeredSurfaces.get(rawSurfaceId) : undefined;
      if (conflictingSurface && registeredSurfaceIdentitiesConflict(conflictingSurface, input)) {
        return diagnostics.rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
          existing: diagnostics.summarizeRegisteredSurface(conflictingSurface),
          conflict: {
            surfaceRoleMatches: conflictingSurface.surfaceRole === input.surfaceRole,
            surfaceIdentityKeyMatches: (conflictingSurface.surfaceIdentityKey?.trim() || "") ===
              (input.surfaceIdentityKey?.trim() || ""),
          },
        });
      }
      return diagnostics.rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
        invalidCheck: validation.check,
      });
    }
    if (!Number.isSafeInteger(ownerWebContentsId) || ownerWebContentsId <= 0) {
      return diagnostics.rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
        invalidCheck: "invalid_owner_webcontents_id",
      });
    }
    const canonicalSurfaceId = input.surfaceId.trim();
    const dialogReservation = workPanelDialogRegistrations.get(canonicalSurfaceId);
    if (dialogReservation && (dialogReservation.registrationId !== input.registrationId ||
      dialogReservation.ownerChatId !== input.ownerChatId || dialogReservation.ownerWebContentsId !== ownerWebContentsId ||
      dialogReservation.parentSurfaceId !== input.parentSurfaceId || input.surfaceRole !== "workpanel-web" || input.surfaceKind !== "chat-work-panel")) {
      // A late publication by the old embedded renderer cannot reclaim the
      // surface while Main owns its dialog presentation.
      return { ok: false, reason: "ownership_conflict" };
    }
    const existingSurface = registeredSurfaces.get(canonicalSurfaceId);
    if (existingSurface && existingSurface.ownerWebContentsId !== ownerWebContentsId) {
      return diagnostics.rejectSurfaceRegistration(input, ownerWebContentsId, "owner_webcontents_conflict", {
        existing: diagnostics.summarizeRegisteredSurface(existingSurface),
      });
    }
    if (existingSurface && registeredSurfaceIdentitiesConflict(existingSurface, input)) {
      return diagnostics.rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
        existing: diagnostics.summarizeRegisteredSurface(existingSurface),
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
      return diagnostics.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "main_chat_owner_transition_rejected", {
        ...(existingSurface ? { existing: diagnostics.summarizeRegisteredSurface(existingSurface) } : {}),
        conflict: {
          existingHasOwnerChatId: Boolean(existingSurface?.ownerChatId?.trim()),
          nextHasOwnerChatId: Boolean(registrationInput.ownerChatId?.trim()),
          pageRouteKind: describeMainChatRoute(registrationInput.pageRouteIdentity),
          guestRouteKind: describeMainChatRoute(activeTab?.currentUrl),
        },
      });
    }
    const parentSurface = registrationInput.parentSurfaceId
      ? registeredSurfaces.get(registrationInput.parentSurfaceId)
      : undefined;
    if (parentSurface && (parentSurface.ownerWebContentsId !== ownerWebContentsId ||
      Boolean(parentSurface.ownerChatId &&
        registrationInput.ownerChatId &&
        parentSurface.ownerChatId !== registrationInput.ownerChatId &&
        workPanelDialogRegistrations.get(registrationInput.surfaceId)?.registrationId !== registrationInput.registrationId))) {
      return diagnostics.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "parent_surface_conflict", {
        existing: diagnostics.summarizeRegisteredSurface(parentSurface),
        conflict: {
          parentOwnerMatches: parentSurface.ownerWebContentsId === ownerWebContentsId,
          parentChatOwnerMatches: !(parentSurface.ownerChatId &&
            registrationInput.ownerChatId &&
            parentSurface.ownerChatId !== registrationInput.ownerChatId),
        },
      });
    }
    for (const tab of registrationInput.tabs) {
      const claimed = guest.findGuestClaim(tab.webContentsId);
      if (claimed && claimed.surfaceId !== registrationInput.surfaceId) {
        const claimedSurface = registeredSurfaces.get(claimed.surfaceId);
        return diagnostics.rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "guest_webcontents_claimed", {
          ...(claimedSurface ? { existing: diagnostics.summarizeRegisteredSurface(claimedSurface) } : {}),
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
    registeredSurfaces.set(canonicalSurfaceId, registered);
    addDerivedAliases(registered);
    guest.indexRegisteredSurface(registered);
    emitLifecycle("registered", registered);
    diagnostics.settleRegistrationDiagnostics(registrationInput);
    return { ok: true } satisfies EmbeddedCdpSurfaceRegistrationResult;
  }

  function registerSurface(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number): boolean {
    return registerSurfaceResult(input, ownerWebContentsId).ok;
  }

  function unregisterSurface(input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number): boolean {
    const surfaceId = typeof input?.surfaceId === "string" ? resolveCanonicalSurfaceId(input.surfaceId) : "";
    const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
    const current = registeredSurfaces.get(surfaceId);
    if (!current ||
      current.registrationId !== registrationId ||
      current.ownerWebContentsId !== ownerWebContentsId) {
      return false;
    }
    registeredSurfaces.delete(surfaceId);
    emitLifecycle("unregistered", current);
    removeAliasesForSurface(surfaceId);
    guest.removeGuestTargetsForSurface(surfaceId);
    removeChildSurfaces(surfaceId);
    return true;
  }

  function unregisterSurfacesForOwner(ownerWebContentsId: number): void {
    for (const [surfaceId, surface] of registeredSurfaces) {
      if (surface.ownerWebContentsId === ownerWebContentsId) {
        registeredSurfaces.delete(surfaceId);
        emitLifecycle("unregistered", surface);
        removeAliasesForSurface(surfaceId);
        guest.removeGuestTargetsForSurface(surfaceId);
        removeChildSurfaces(surfaceId);
      }
    }
  }

  function resolveRegisteredSurface(surfaceId: string): ResolvedSurface | null {
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
      emitLifecycle("unregistered", registered);
      removeAliasesForSurface(canonicalSurfaceId);
      guest.removeGuestTargetsForSurface(canonicalSurfaceId);
      removeChildSurfaces(canonicalSurfaceId);
      return null;
    }
    if (tabs.length !== previousTabs.length) {
      registered.tabs = tabs;
      guest.indexRegisteredSurface(registered);
    }
    if (!registered.activeTabId || !tabs.some((tab) => tab.tabId === registered.activeTabId)) {
      registered.activeTabId = selectSurvivingTabId(previousTabs.map((tab) => tab.tabId), tabs.map((tab) => tab.tabId), registered.activeTabId);
    }
    const activeTab = tabs.find((tab) => tab.tabId === registered.activeTabId) ?? null;
    const contents = activeTab ? options.webContents.fromId(activeTab.webContentsId) ?? null : null;
    return { registered, tabs, activeTab, contents };
  }

  function removeChildSurfaces(parentSurfaceId: string): void {
    const children = [...registeredSurfaces.values()]
      .filter((surface) => surface.parentSurfaceId === parentSurfaceId &&
        workPanelDialogRegistrations.get(surface.surfaceId)?.registrationId !== surface.registrationId)
      .map((surface) => surface.surfaceId);
    for (const childId of children) {
      const child = registeredSurfaces.get(childId);
      registeredSurfaces.delete(childId);
      if (child)
        emitLifecycle("unregistered", child);
      removeAliasesForSurface(childId);
      guest.removeGuestTargetsForSurface(childId);
      removeChildSurfaces(childId);
    }
  }

  function getRegisteredSurfaceSnapshot(surfaceId: string, registrationId: string, ownerWebContentsId: number): { registered: RegisteredSurface; tabs: EmbeddedCdpSurfaceTabRegistration[]; } | null {
    const resolved = resolveRegisteredSurface(surfaceId);
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
  // Main-only reservation captured from an already-authorized live WorkPanel
  // surface. It survives Main Chat remounts without granting a different Chat.
  function retainWorkPanelDialogSurface(surfaceId: string, registrationId: string, ownerWebContentsId: number, nextRegistrationId: string) {
    const snapshot = getRegisteredSurfaceSnapshot(surfaceId, registrationId, ownerWebContentsId);
    if (!snapshot || snapshot.registered.surfaceKind !== "chat-work-panel" || snapshot.registered.surfaceRole !== "workpanel-web" ||
      !snapshot.registered.ownerChatId || workPanelDialogRegistrations.has(surfaceId)) return false;
    workPanelDialogRegistrations.set(surfaceId, { registrationId: nextRegistrationId, ownerChatId: snapshot.registered.ownerChatId, ownerWebContentsId, parentSurfaceId: snapshot.registered.parentSurfaceId });
    return true;
  }
  // Only Main can extend an existing dialog reservation. The caller derives
  // the sibling identity from the original Chat and the reducer's stable key.
  function retainWorkPanelDialogSibling(sourceId: string, sourceRegistrationId: string, surfaceId: string, registrationId: string) {
    const source = workPanelDialogRegistrations.get(sourceId);
    if (!source || source.registrationId !== sourceRegistrationId ||
      registeredSurfaces.has(surfaceId) || workPanelDialogRegistrations.has(surfaceId)) return false;
    workPanelDialogRegistrations.set(surfaceId, { ...source, registrationId });
    return true;
  }
  function releaseWorkPanelDialogSurface(surfaceId: string, registrationId: string) {
    if (workPanelDialogRegistrations.get(surfaceId)?.registrationId === registrationId) workPanelDialogRegistrations.delete(surfaceId);
  }

  const registrations: ReadonlyMap<string, RegisteredSurface> = registeredSurfaces;
  return { subscribeLifecycle, resolveCanonicalSurfaceId, registerSurfaceResult, registerSurface, unregisterSurface, unregisterSurfacesForOwner, resolveRegisteredSurface, getRegisteredSurfaceSnapshot, retainWorkPanelDialogSurface, retainWorkPanelDialogSibling, releaseWorkPanelDialogSurface, guest, registeredSurfaces: registrations };
}
