import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";
import type {
  EmbeddedCdpSurfaceRegistration,
  EmbeddedCdpSurfaceRegistrationResult,
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
import {
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource
} from "../shared/canonical-chat-sync";
import { readAgentWebclientAgentRouteKey } from "../shared/agent-webclient-routes";
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
  presentationScope?: "main-workspace" | "workpanel";
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
  reportRegistrationDiagnostic?: (diagnostic: SurfaceRegistrationDiagnostic) => void;
  registrationDiagnosticDedupWindowMs?: number;
};

export type SurfaceRegistrationRejectionReason =
  | "invalid_registration"
  | "owner_webcontents_conflict"
  | "surface_identity_conflict"
  | "main_chat_owner_transition_rejected"
  | "parent_surface_conflict"
  | "guest_webcontents_claimed";

export type SurfaceRegistrationInvalidCheck =
  | "invalid_input"
  | "invalid_registration_id"
  | "invalid_surface_id"
  | "invalid_surface_identity"
  | "invalid_surface_kind"
  | "missing_owner_chat"
  | "invalid_surface_type"
  | "invalid_optional_fields"
  | "invalid_presentation_scope"
  | "role_policy_mismatch"
  | "entry_not_found"
  | "entry_kind_mismatch"
  | "entry_route_mismatch"
  | "service_identity_mismatch"
  | "agent_webclient_service_mismatch"
  | "fixed_surface_id_mismatch"
  | "missing_parent_surface"
  | "invalid_parent_surface"
  | "parent_cycle"
  | "unexpected_parent_surface"
  | "invalid_label"
  | "invalid_url_field"
  | "invalid_active_flag"
  | "invalid_tabs"
  | "invalid_tab"
  | "duplicate_tab"
  | "invalid_active_tab"
  | "invalid_owner_webcontents_id";

export type SurfaceRegistrationDiagnostic = {
  event: "surface-registration-rejected" | "surface-registration-rejection-summary";
  reason: SurfaceRegistrationRejectionReason;
  registrationId: string;
  surfaceId: string;
  surfaceKind: string;
  surfaceRole: string;
  surfaceLevel: string;
  ownerWebContentsId: number | null;
  guestWebContentsIds: number[];
  parentSurfaceId: string;
  presentationScope: string;
  hasOwnerChatId: boolean;
  invalidCheck?: SurfaceRegistrationInvalidCheck;
  existing?: {
    registrationId: string;
    surfaceId: string;
    surfaceRole: string;
    ownerWebContentsId: number | null;
    guestWebContentsIds: number[];
  };
  conflict?: {
    guestWebContentsId?: number;
    claimedSurfaceId?: string;
    claimedRegistrationId?: string;
    claimedOwnerWebContentsId?: number | null;
    surfaceRoleMatches?: boolean;
    surfaceIdentityKeyMatches?: boolean;
    parentOwnerMatches?: boolean;
    parentChatOwnerMatches?: boolean;
    pageRouteKind?: string;
    guestRouteKind?: string;
    existingHasOwnerChatId?: boolean;
    nextHasOwnerChatId?: boolean;
  };
  occurrenceCount: number;
  resolution?: "registered" | "replaced" | "retry_window_expired";
};

type RegisteredSurface = EmbeddedCdpSurfaceRegistration & {
  ownerWebContentsId: number;
};

type SurfaceRegistrationValidation =
  | { ok: true }
  | { ok: false; check: SurfaceRegistrationInvalidCheck };

type PendingSurfaceRegistrationDiagnostic = {
  diagnostic: SurfaceRegistrationDiagnostic;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token)/iu;

function sanitizeSurfaceDiagnosticId(value: unknown) {
  if (typeof value !== "string") return "(missing)";
  const normalized = value.trim();
  if (!normalized) return "(missing)";
  if (
    normalized.length > 192 ||
    !SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN.test(normalized) ||
    SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN.test(normalized)
  ) {
    return `(redacted:${normalized.length})`;
  }
  return normalized;
}

function sanitizeSurfaceDiagnosticEnum(value: unknown) {
  if (typeof value !== "string") return "(missing)";
  const normalized = value.trim();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(normalized) &&
    !SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN.test(normalized)
    ? normalized
    : "(invalid)";
}

function diagnosticGuestWebContentsIds(input: unknown) {
  if (!input || typeof input !== "object") return [];
  const tabs = (input as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return [];
  return [...new Set(tabs.flatMap((tab) => {
    const value = tab && typeof tab === "object"
      ? (tab as { webContentsId?: unknown }).webContentsId
      : null;
    return Number.isSafeInteger(value) && Number(value) > 0 ? [Number(value)] : [];
  }))];
}

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
  pageRouteIdentity?: string;
  tabId: string;
  webContentsId: number;
  ownerWebContentsId: number;
  active: boolean;
  currentUrl: string;
  label: string;
  ownerChatId?: string;
  presentationScope?: "main-workspace" | "workpanel";
  surfaceRole: SurfaceRole;
  surfaceLevel: SurfaceIdentity["surfaceLevel"];
  parentSurfaceId?: string;
  interaction: SurfaceIdentity["interaction"];
};

type PendingGuestTargetWaiter = {
  registrationId: string | null;
  predicate(target: RegisteredWebviewSurfaceTarget): boolean;
  complete(target: RegisteredWebviewSurfaceTarget | null): void;
};

function guestTargetMatches(
  predicate: PendingGuestTargetWaiter["predicate"],
  target: RegisteredWebviewSurfaceTarget,
) {
  try {
    return predicate(target);
  } catch {
    return false;
  }
}

function sameNewChatSource(
  left: ReturnType<typeof readAgentWebclientNewChatSource>,
  right: ReturnType<typeof readAgentWebclientNewChatSource>,
) {
  return Boolean(
    left &&
    right &&
    left.agentKey === right.agentKey &&
    left.newChat === right.newChat
  );
}

function activeRegistrationTab(input: EmbeddedCdpSurfaceRegistration) {
  const activeTabId = input.activeTabId?.trim() || "";
  return activeTabId
    ? input.tabs.find((tab) => tab.tabId.trim() === activeTabId) ?? null
    : null;
}

function describeMainChatRoute(value: string | undefined) {
  if (readAgentWebclientNewChatSource(value ?? "")) return "new-chat";
  if (readAgentWebclientCanonicalChatSource(value ?? "")) return "canonical";
  if (readAgentWebclientAgentRouteKey(value ?? "")) return "agent-route";
  return "invalid";
}

function isMainChatSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration) {
  return input.surfaceId === MAIN_CHAT_SURFACE_ID &&
    input.surfaceRole === "main-chat" &&
    input.surfaceType === "agent-chat";
}

function preserveInactiveMainChatIdentity(
  existing: EmbeddedCdpSurfaceRegistration | undefined,
  input: EmbeddedCdpSurfaceRegistration,
) {
  if (!isMainChatSurfaceRegistration(input) || input.active || !existing) return input;
  const {
    ownerChatId: _ownerChatId,
    pageRoute: _pageRoute,
    pageRouteIdentity: _pageRouteIdentity,
    ...rest
  } = input;
  return {
    ...rest,
    ...(existing.pageRoute ? { pageRoute: existing.pageRoute } : {}),
    ...(existing.pageRouteIdentity
      ? { pageRouteIdentity: existing.pageRouteIdentity }
      : {}),
    ...(existing.ownerChatId ? { ownerChatId: existing.ownerChatId } : {}),
  };
}

function mainChatSurfaceRegistrationTransitionAllowed(
  existing: Pick<EmbeddedCdpSurfaceRegistration, "ownerChatId"> | undefined,
  input: EmbeddedCdpSurfaceRegistration,
) {
  if (!isMainChatSurfaceRegistration(input) || !input.active) return true;
  const activeTab = activeRegistrationTab(input);
  const pageRouteIdentity = input.pageRouteIdentity?.trim() || "";
  const pageAgentKey = readAgentWebclientAgentRouteKey(pageRouteIdentity);
  const publicPageAgentKey = readAgentWebclientAgentRouteKey(input.pageRoute ?? "");
  const guestAgentKey = readAgentWebclientAgentRouteKey(activeTab?.currentUrl ?? "");
  if (
    !activeTab ||
    !pageRouteIdentity ||
    !pageAgentKey ||
    pageAgentKey !== publicPageAgentKey ||
    pageAgentKey !== guestAgentKey
  ) {
    return false;
  }

  const nextOwnerChatId = input.ownerChatId?.trim() || "";
  if (nextOwnerChatId) {
    const pageCanonical = readAgentWebclientCanonicalChatSource(pageRouteIdentity);
    return Boolean(
      pageCanonical &&
      pageCanonical.agentKey === pageAgentKey &&
      pageCanonical.chatId === nextOwnerChatId
    );
  }

  const pageNewChat = readAgentWebclientNewChatSource(pageRouteIdentity);
  if (!pageNewChat) return false;
  const existingOwnerChatId = existing?.ownerChatId?.trim() || "";
  if (!existingOwnerChatId) {
    // During canonical promotion the guest may already expose chatId while
    // the Desktop route still owns the one-shot newChat source.
    return true;
  }
  return sameNewChatSource(
    pageNewChat,
    readAgentWebclientNewChatSource(activeTab.currentUrl),
  );
}

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
    Set<PendingGuestTargetWaiter>
  >();
  const surfaceAliases = new Map<string, string>(Object.entries(LEGACY_FIXED_SURFACE_ID_ALIASES));
  const reportedLegacyAliases = new Set<string>();
  const pendingRegistrationDiagnostics = new Map<string, PendingSurfaceRegistrationDiagnostic>();
  const registrationDiagnosticDedupWindowMs = Math.max(
    10,
    Math.min(options.registrationDiagnosticDedupWindowMs ?? 1_000, 10_000),
  );

  function reportRegistrationDiagnostic(diagnostic: SurfaceRegistrationDiagnostic) {
    try {
      options.reportRegistrationDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never affect surface authorization or registration.
    }
  }

  function summarizeRegisteredSurface(surface: RegisteredSurface) {
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

  function createRegistrationDiagnostic(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
    reason: SurfaceRegistrationRejectionReason,
    details: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict"> = {},
  ): SurfaceRegistrationDiagnostic {
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

  function flushRegistrationDiagnostic(
    key: string,
    resolution: NonNullable<SurfaceRegistrationDiagnostic["resolution"]>,
  ) {
    const pending = pendingRegistrationDiagnostics.get(key);
    if (!pending) return;
    pendingRegistrationDiagnostics.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.count <= 1) return;
    reportRegistrationDiagnostic({
      ...pending.diagnostic,
      event: "surface-registration-rejection-summary",
      occurrenceCount: pending.count,
      resolution,
    });
  }

  function scheduleRegistrationDiagnosticFlush(key: string) {
    const pending = pendingRegistrationDiagnostics.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      flushRegistrationDiagnostic(key, "retry_window_expired");
    }, registrationDiagnosticDedupWindowMs);
    pending.timer.unref?.();
  }

  function rejectSurfaceRegistration(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
    reason: SurfaceRegistrationRejectionReason,
    details: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict"> = {},
  ): EmbeddedCdpSurfaceRegistrationResult {
    const diagnostic = createRegistrationDiagnostic(input, ownerWebContentsId, reason, details);
    const key = `${diagnostic.registrationId}\u0000${reason}`;
    const pending = pendingRegistrationDiagnostics.get(key);
    if (pending) {
      pending.count += 1;
      pending.diagnostic = diagnostic;
      scheduleRegistrationDiagnosticFlush(key);
      return {
        ok: false,
        reason: reason === "invalid_registration"
          ? "invalid_registration"
          : reason === "main_chat_owner_transition_rejected"
            ? "route_not_aligned"
            : "ownership_conflict",
      };
    }
    pendingRegistrationDiagnostics.set(key, { diagnostic, count: 1, timer: null });
    reportRegistrationDiagnostic(diagnostic);
    scheduleRegistrationDiagnosticFlush(key);
    return {
      ok: false,
      reason: reason === "invalid_registration"
        ? "invalid_registration"
        : reason === "main_chat_owner_transition_rejected"
          ? "route_not_aligned"
          : "ownership_conflict",
    };
  }

  function settleRegistrationDiagnostics(input: EmbeddedCdpSurfaceRegistration) {
    const registrationId = sanitizeSurfaceDiagnosticId(input.registrationId);
    const surfaceId = sanitizeSurfaceDiagnosticId(input.surfaceId);
    for (const [key, pending] of pendingRegistrationDiagnostics) {
      if (pending.diagnostic.registrationId === registrationId) {
        flushRegistrationDiagnostic(key, "registered");
      } else if (pending.diagnostic.surfaceId === surfaceId) {
        flushRegistrationDiagnostic(key, "replaced");
      }
    }
  }

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
    for (const waiter of [...waiters]) {
      if (
        target === null ||
        (waiter.registrationId && waiter.registrationId !== target.registrationId) ||
        guestTargetMatches(waiter.predicate, target)
      ) {
        waiter.complete(
          target && waiter.registrationId && waiter.registrationId !== target.registrationId
            ? null
            : target,
        );
      }
    }
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
      return ["service", "source", "file-diff", "artifact", "reference", "file", "planning", "agent", "skill"];
    }
    return ["service", "plugin-settings"];
  }

  function validateRegistrationIdentity(input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation {
    const identityKey = input.surfaceIdentityKey?.trim() || "";
    if (!surfaceIdentityMatchesPolicy(input, identityKey)) {
      return { ok: false, check: "role_policy_mismatch" };
    }
    if (!expectedRolesForRegistration(input).includes(input.surfaceRole)) {
      return { ok: false, check: "role_policy_mismatch" };
    }
    if (input.surfaceRole === "website" || input.surfaceRole === "webapp") {
      const entry = options.listWebEntries().items.find((item) => item.entryKey === identityKey);
      if (!entry) return { ok: false, check: "entry_not_found" };
      if (entry.kind !== input.surfaceRole) return { ok: false, check: "entry_kind_mismatch" };
      if (input.pageRoute !== `/webs/${identityKey}`) {
        return { ok: false, check: "entry_route_mismatch" };
      }
    }
    if (
      (input.surfaceRole === "service" || input.surfaceRole === "plugin-settings") &&
      input.serviceId?.trim() !== identityKey
    ) return { ok: false, check: "service_identity_mismatch" };
    if (
      ["main-chat", "copilot-chat", "kanban-chat", "copilot-dock", "overview", "debug", "btw", "source", "project", "file-diff", "artifact", "reference", "file", "planning", "agent", "copilot", "skill"].includes(input.surfaceRole) &&
      input.serviceId?.trim() !== "agent-webclient"
    ) return { ok: false, check: "agent_webclient_service_mismatch" };
    if (
      (input.surfaceRole === "main-chat" && input.surfaceId !== MAIN_CHAT_SURFACE_ID) ||
      (input.surfaceRole === "copilot-chat" && input.surfaceId !== COPILOT_CHAT_SURFACE_ID) ||
      (input.surfaceRole === "kanban-chat" && input.surfaceId !== KANBAN_CHAT_SURFACE_ID) ||
      (input.surfaceRole === "copilot-dock" && input.surfaceId !== COPILOT_DOCK_SURFACE_ID)
    ) return { ok: false, check: "fixed_surface_id_mismatch" };
    if (input.surfaceLevel === "child") {
      if (!input.parentSurfaceId && input.surfaceRole !== "project" && input.surfaceRole !== "copilot-dock") {
        return { ok: false, check: "missing_parent_surface" };
      }
      if (input.parentSurfaceId) {
        const canonicalParentSurfaceId = resolveCanonicalSurfaceId(input.parentSurfaceId);
        if (
          canonicalParentSurfaceId !== input.parentSurfaceId ||
          canonicalParentSurfaceId === input.surfaceId ||
          !resolveRegisteredSurface(canonicalParentSurfaceId)
        ) return { ok: false, check: "invalid_parent_surface" };
        const visited = new Set([input.surfaceId]);
        let cursor = registeredSurfaces.get(canonicalParentSurfaceId);
        while (cursor) {
          if (visited.has(cursor.surfaceId)) return { ok: false, check: "parent_cycle" };
          visited.add(cursor.surfaceId);
          cursor = cursor.parentSurfaceId ? registeredSurfaces.get(cursor.parentSurfaceId) : undefined;
        }
      }
    } else if (input.parentSurfaceId) {
      return { ok: false, check: "unexpected_parent_surface" };
    }
    return { ok: true };
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

  function validateSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation {
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
    if (!input || typeof input !== "object") return { ok: false, check: "invalid_input" };
    if (typeof input.registrationId !== "string" || !input.registrationId.trim()) {
      return { ok: false, check: "invalid_registration_id" };
    }
    if (typeof input.surfaceId !== "string" || !input.surfaceId.trim()) {
      return { ok: false, check: "invalid_surface_id" };
    }
    if (
      typeof input.surfaceRole !== "string" ||
      typeof input.surfaceLevel !== "string" ||
      typeof input.interaction !== "string"
    ) return { ok: false, check: "invalid_surface_identity" };
    if (!validKinds.includes(input.surfaceKind)) return { ok: false, check: "invalid_surface_kind" };
    if (input.surfaceKind === "chat-work-panel" && !input.ownerChatId?.trim()) {
      return { ok: false, check: "missing_owner_chat" };
    }
    if (input.surfaceType !== undefined && !validSurfaceTypes.has(input.surfaceType)) {
      return { ok: false, check: "invalid_surface_type" };
    }
    if (
      (input.serviceId !== undefined && typeof input.serviceId !== "string") ||
      (input.pageRoute !== undefined && typeof input.pageRoute !== "string") ||
      (input.pageRouteIdentity !== undefined && typeof input.pageRouteIdentity !== "string") ||
      (input.ownerChatId !== undefined && typeof input.ownerChatId !== "string")
    ) return { ok: false, check: "invalid_optional_fields" };
    if (
      input.presentationScope !== undefined &&
      input.presentationScope !== "main-workspace" &&
      !(input.presentationScope === "workpanel" && input.surfaceKind === "webapp" && Boolean(input.ownerChatId?.trim()))
    ) return { ok: false, check: "invalid_presentation_scope" };
    const identityValidation = validateRegistrationIdentity(input);
    if (!identityValidation.ok) return identityValidation;
    if (typeof input.label !== "string") return { ok: false, check: "invalid_label" };
    if (typeof input.url !== "string") return { ok: false, check: "invalid_url_field" };
    if (typeof input.active !== "boolean") return { ok: false, check: "invalid_active_flag" };
    if (!Array.isArray(input.tabs)) return { ok: false, check: "invalid_tabs" };
    const tabIds = new Set<string>();
    const webContentsIds = new Set<number>();
    for (const tab of input.tabs) {
      if (!isValidSurfaceTab(tab)) return { ok: false, check: "invalid_tab" };
      const tabId = tab.tabId.trim();
      if (tabIds.has(tabId) || webContentsIds.has(tab.webContentsId)) {
        return { ok: false, check: "duplicate_tab" };
      }
      tabIds.add(tabId);
      webContentsIds.add(tab.webContentsId);
    }
    if (
      input.activeTabId !== null &&
      (typeof input.activeTabId !== "string" || !tabIds.has(input.activeTabId.trim()))
    ) return { ok: false, check: "invalid_active_tab" };
    return { ok: true };
  }

  function registerSurfaceResult(
    input: EmbeddedCdpSurfaceRegistration,
    ownerWebContentsId: number,
  ): EmbeddedCdpSurfaceRegistrationResult {
    const validation = validateSurfaceRegistration(input);
    if (!validation.ok) {
      const rawSurfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
      const conflictingSurface = rawSurfaceId ? registeredSurfaces.get(rawSurfaceId) : undefined;
      if (conflictingSurface && registeredSurfaceIdentitiesConflict(conflictingSurface, input)) {
        return rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
          existing: summarizeRegisteredSurface(conflictingSurface),
          conflict: {
            surfaceRoleMatches: conflictingSurface.surfaceRole === input.surfaceRole,
            surfaceIdentityKeyMatches:
              (conflictingSurface.surfaceIdentityKey?.trim() || "") ===
              (input.surfaceIdentityKey?.trim() || ""),
          },
        });
      }
      return rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
        invalidCheck: validation.check,
      });
    }
    if (!Number.isSafeInteger(ownerWebContentsId) || ownerWebContentsId <= 0) {
      return rejectSurfaceRegistration(input, ownerWebContentsId, "invalid_registration", {
        invalidCheck: "invalid_owner_webcontents_id",
      });
    }
    const canonicalSurfaceId = input.surfaceId.trim();
    const existingSurface = registeredSurfaces.get(canonicalSurfaceId);
    if (existingSurface && existingSurface.ownerWebContentsId !== ownerWebContentsId) {
      return rejectSurfaceRegistration(input, ownerWebContentsId, "owner_webcontents_conflict", {
        existing: summarizeRegisteredSurface(existingSurface),
      });
    }
    if (existingSurface && registeredSurfaceIdentitiesConflict(existingSurface, input)) {
      return rejectSurfaceRegistration(input, ownerWebContentsId, "surface_identity_conflict", {
        existing: summarizeRegisteredSurface(existingSurface),
        conflict: {
          surfaceRoleMatches: existingSurface.surfaceRole === input.surfaceRole,
          surfaceIdentityKeyMatches:
            (existingSurface.surfaceIdentityKey?.trim() || "") ===
            (input.surfaceIdentityKey?.trim() || ""),
        },
      });
    }
    const registrationInput = preserveInactiveMainChatIdentity(existingSurface, input);
    if (!mainChatSurfaceRegistrationTransitionAllowed(existingSurface, registrationInput)) {
      const activeTab = activeRegistrationTab(registrationInput);
      return rejectSurfaceRegistration(
        registrationInput,
        ownerWebContentsId,
        "main_chat_owner_transition_rejected",
        {
          ...(existingSurface ? { existing: summarizeRegisteredSurface(existingSurface) } : {}),
          conflict: {
            existingHasOwnerChatId: Boolean(existingSurface?.ownerChatId?.trim()),
            nextHasOwnerChatId: Boolean(registrationInput.ownerChatId?.trim()),
            pageRouteKind: describeMainChatRoute(registrationInput.pageRouteIdentity),
            guestRouteKind: describeMainChatRoute(activeTab?.currentUrl),
          },
        },
      );
    }
    const parentSurface = registrationInput.parentSurfaceId
      ? registeredSurfaces.get(registrationInput.parentSurfaceId)
      : undefined;
    if (
      parentSurface && (
        parentSurface.ownerWebContentsId !== ownerWebContentsId ||
        Boolean(
          parentSurface.ownerChatId &&
          registrationInput.ownerChatId &&
          parentSurface.ownerChatId !== registrationInput.ownerChatId
        )
      )
    ) {
      return rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "parent_surface_conflict", {
        existing: summarizeRegisteredSurface(parentSurface),
        conflict: {
          parentOwnerMatches: parentSurface.ownerWebContentsId === ownerWebContentsId,
          parentChatOwnerMatches: !(
            parentSurface.ownerChatId &&
            registrationInput.ownerChatId &&
            parentSurface.ownerChatId !== registrationInput.ownerChatId
          ),
        },
      });
    }
    for (const tab of registrationInput.tabs) {
      const claimed = registeredGuestTargets.get(tab.webContentsId);
      if (claimed && claimed.surfaceId !== registrationInput.surfaceId) {
        const claimedSurface = registeredSurfaces.get(claimed.surfaceId);
        return rejectSurfaceRegistration(registrationInput, ownerWebContentsId, "guest_webcontents_claimed", {
          ...(claimedSurface ? { existing: summarizeRegisteredSurface(claimedSurface) } : {}),
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
    indexRegisteredSurface(registered);
    settleRegistrationDiagnostics(registrationInput);
    return { ok: true } satisfies EmbeddedCdpSurfaceRegistrationResult;
  }

  function registerSurface(input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number) {
    return registerSurfaceResult(input, ownerWebContentsId).ok;
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
      ...(resolved.registered.pageRouteIdentity
        ? { pageRouteIdentity: resolved.registered.pageRouteIdentity }
        : {}),
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
    return waitForWebviewSurfaceTargetMatching(
      webContentsId,
      () => true,
      timeoutMs,
      signal,
    );
  }

  function waitForWebviewSurfaceTargetMatching(
    webContentsId: number,
    predicate: (target: RegisteredWebviewSurfaceTarget) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RegisteredWebviewSurfaceTarget | null> {
    if (
      signal?.aborted ||
      typeof predicate !== "function" ||
      !Number.isSafeInteger(webContentsId) ||
      webContentsId <= 0
    ) {
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
    if (owner?.isDestroyed()) return Promise.resolve(null);
    const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let waiter: PendingGuestTargetWaiter;
      const complete = (target: RegisteredWebviewSurfaceTarget | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
        guest.removeListener("destroyed", handleAbort);
        owner?.removeListener("destroyed", handleAbort);
        const waiters = pendingGuestTargetWaiters.get(webContentsId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) pendingGuestTargetWaiters.delete(webContentsId);
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
    registerSurfaceResult,
    resolveCanonicalSurfaceId,
    resolveWebviewSurfaceTarget,
    waitForWebviewSurfaceTarget,
    waitForWebviewSurfaceTargetMatching,
    unregisterSurface,
    unregisterSurfacesForOwner,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
