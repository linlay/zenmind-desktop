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

export type WebContentsAccess = {
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
  | "forbidden_route"
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

export type RegisteredSurface = EmbeddedCdpSurfaceRegistration & {
  ownerWebContentsId: number;
};

export type BrowserSurfaceLifecycleEvent = {
  type: "registered" | "unregistered";
  surface: {
    registrationId: string;
    surfaceId: string;
    surfaceRole: SurfaceRole;
    surfaceIdentityKey: string;
    active: boolean;
    ownerChatId: string;
    ownerWebContentsId: number;
    guestWebContentsIds: number[];
  };
};

export type BrowserSurfaceDiagnosticSnapshot = {
  registrationId: string;
  surfaceId: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  surfaceType: NonNullable<EmbeddedCdpSurfaceRegistration["surfaceType"]>;
  surfaceRole: SurfaceRole;
  surfaceLevel: SurfaceIdentity["surfaceLevel"];
  interaction: SurfaceIdentity["interaction"];
  parentSurfaceId?: string;
  ownerChatId?: string;
  ownerWebContentsId: number;
  label: string;
  url: string;
  pageRoute?: string;
  active: boolean;
  tabs: BrowserSurfaceTab[];
  activeTabId: string | null;
};

export type BrowserWebContentsDiagnosticSnapshot = {
  webContentsId: number;
  type: ReturnType<WebContents["getType"]>;
  osProcessId: number;
  url: string;
  title: string;
  loading: boolean;
  crashed: boolean;
  devToolsOpened: boolean;
  backgroundThrottling: boolean;
};

export type SurfaceRegistrationValidation =
  | { ok: true }
  | { ok: false; check: SurfaceRegistrationInvalidCheck };

export type PendingSurfaceRegistrationDiagnostic = {
  diagnostic: SurfaceRegistrationDiagnostic;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export const SURFACE_REGISTRATION_DIAGNOSTIC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export const SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token)/iu;

export function sanitizeSurfaceDiagnosticId(value: unknown) {
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

export function sanitizeSurfaceDiagnosticEnum(value: unknown) {
  if (typeof value !== "string") return "(missing)";
  const normalized = value.trim();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(normalized) &&
    !SURFACE_REGISTRATION_DIAGNOSTIC_SECRET_PATTERN.test(normalized)
    ? normalized
    : "(invalid)";
}

export function diagnosticGuestWebContentsIds(input: unknown) {
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
  surfaceIdentityKey?: string;
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

export type PendingGuestTargetWaiter = {
  registrationId: string | null;
  predicate(target: RegisteredWebviewSurfaceTarget): boolean;
  complete(target: RegisteredWebviewSurfaceTarget | null): void;
};

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

export function sameNewChatSource(
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

export function activeRegistrationTab(input: EmbeddedCdpSurfaceRegistration) {
  const activeTabId = input.activeTabId?.trim() || "";
  return activeTabId
    ? input.tabs.find((tab) => tab.tabId.trim() === activeTabId) ?? null
    : null;
}

export function describeMainChatRoute(value: string | undefined) {
  if (readAgentWebclientNewChatSource(value ?? "")) return "new-chat";
  if (readAgentWebclientCanonicalChatSource(value ?? "")) return "canonical";
  if (readAgentWebclientAgentRouteKey(value ?? "")) return "agent-route";
  return "invalid";
}

export function isMainChatSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration) {
  return input.surfaceId === MAIN_CHAT_SURFACE_ID &&
    input.surfaceRole === "main-chat" &&
    input.surfaceType === "agent-chat";
}

export function preserveInactiveMainChatIdentity(
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

export function mainChatSurfaceRegistrationTransitionAllowed(
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

export interface CreateBrowserSurfaceRegistryContext {
  options: BrowserSurfaceRegistryOptions;
  registeredSurfaces: Map<string, RegisteredSurface>;
  registeredGuestTargets: Map<number, RegisteredWebviewSurfaceTarget>;
  pendingGuestTargetWaiters: Map<number, Set<PendingGuestTargetWaiter>>;
  surfaceAliases: Map<string, string>;
  pendingRegistrationDiagnostics: Map<string, PendingSurfaceRegistrationDiagnostic>;
  lifecycleListeners: Set<(event: BrowserSurfaceLifecycleEvent) => void>;
  registrationDiagnosticDedupWindowMs: number;
  emitLifecycle: (type: BrowserSurfaceLifecycleEvent["type"], surface: RegisteredSurface) => void;
  subscribeLifecycle: (listener: (event: BrowserSurfaceLifecycleEvent) => void) => () => boolean;
  reportRegistrationDiagnostic: (diagnostic: SurfaceRegistrationDiagnostic) => void;
  summarizeRegisteredSurface: (surface: RegisteredSurface) => { registrationId: string; surfaceId: string; surfaceRole: string; ownerWebContentsId: number | null; guestWebContentsIds: number[]; };
  createRegistrationDiagnostic: (input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">) => SurfaceRegistrationDiagnostic;
  flushRegistrationDiagnostic: (key: string, resolution: NonNullable<SurfaceRegistrationDiagnostic["resolution"]>) => void;
  scheduleRegistrationDiagnosticFlush: (key: string) => void;
  rejectSurfaceRegistration: (input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number, reason: SurfaceRegistrationRejectionReason, details?: Pick<SurfaceRegistrationDiagnostic, "invalidCheck" | "existing" | "conflict">) => EmbeddedCdpSurfaceRegistrationResult;
  settleRegistrationDiagnostics: (input: EmbeddedCdpSurfaceRegistration) => void;
  resolveCanonicalSurfaceId: (surfaceId: string) => string;
  removeAliasesForSurface: (surfaceId: string) => void;
  addDerivedAliases: (surface: RegisteredSurface) => void;
  fallbackSurfaceType: (surfaceKind: EmbeddedCdpSurfaceKind) => EmbeddedCdpSurfaceKind;
  settleGuestTargetWaiters: (webContentsId: number, target: RegisteredWebviewSurfaceTarget | null) => void;
  removeGuestTargetsForSurface: (surfaceId: string, settleWaiters?: boolean) => void;
  indexRegisteredSurface: (surface: RegisteredSurface) => void;
  expectedRolesForRegistration: (input: EmbeddedCdpSurfaceRegistration) => SurfaceRole[];
  validateRegistrationIdentity: (input: EmbeddedCdpSurfaceRegistration) => SurfaceRegistrationValidation;
  isValidSurfaceTab: (input: EmbeddedCdpSurfaceTabRegistration) => boolean;
  validateSurfaceRegistration: (input: EmbeddedCdpSurfaceRegistration) => SurfaceRegistrationValidation;
  registerSurfaceResult: (input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number) => EmbeddedCdpSurfaceRegistrationResult;
  registerSurface: (input: EmbeddedCdpSurfaceRegistration, ownerWebContentsId: number) => boolean;
  unregisterSurface: (input: EmbeddedCdpSurfaceRemoval, ownerWebContentsId: number) => boolean;
  unregisterSurfacesForOwner: (ownerWebContentsId: number) => void;
  resolveRegisteredSurface: (surfaceId: string) => { registered: RegisteredSurface; tabs: EmbeddedCdpSurfaceTabRegistration[]; activeTab: EmbeddedCdpSurfaceTabRegistration | null; contents: Electron.WebContents | null; } | null;
  removeChildSurfaces: (parentSurfaceId: string) => void;
  findRegisteredSurfaceWebContents: (surfaceId: string, tabId?: string) => Electron.WebContents | null;
  findWebContentsById: (webContentsId: number) => Electron.WebContents | null;
  resolveWebviewSurfaceTarget: (webContentsId: number) => { ownerChatId?: string; pageRouteIdentity?: string; pageRoute?: string; currentUrl: string; label: string; registrationId: string; surfaceId: string; surfaceKind: EmbeddedCdpSurfaceKind; surfaceType: NonNullable<EmbeddedCdpSurfaceRegistration["surfaceType"]>; surfaceIdentityKey?: string; serviceId?: string; tabId: string; webContentsId: number; ownerWebContentsId: number; active: boolean; presentationScope?: "main-workspace" | "workpanel"; surfaceRole: SurfaceRole; surfaceLevel: SurfaceIdentity["surfaceLevel"]; parentSurfaceId?: string; interaction: SurfaceIdentity["interaction"]; } | null;
  waitForWebviewSurfaceTarget: (webContentsId: number, timeoutMs: number, signal?: AbortSignal) => Promise<RegisteredWebviewSurfaceTarget | null>;
  waitForWebviewSurfaceTargetMatching: (webContentsId: number, predicate: (target: RegisteredWebviewSurfaceTarget) => boolean, timeoutMs: number, signal?: AbortSignal) => Promise<RegisteredWebviewSurfaceTarget | null>;
  currentPageSnapshotMatchesSurface: (surfaceId: string, contents?: WebContents | null) => boolean;
  findWebContentsForSurfaceUrl: (surfaceUrl: string) => Electron.WebContents | null;
  builtinBrowserSurface: (contents: WebContents | null, url?: string) => BrowserSurface;
  listBrowserSurfaces: () => BrowserSurface[];
  listChatWorkPanelSurfaces: () => BrowserSurface[];
  listRegisteredSurfaces: () => BrowserSurface[];
  listDiagnosticSurfaces: () => BrowserSurfaceDiagnosticSnapshot[];
  listWebContentsDiagnostics: () => BrowserWebContentsDiagnosticSnapshot[];
  getRegisteredSurfaceSnapshot: (surfaceId: string, registrationId: string, ownerWebContentsId: number) => { registered: RegisteredSurface; tabs: EmbeddedCdpSurfaceTabRegistration[]; } | null;
}
