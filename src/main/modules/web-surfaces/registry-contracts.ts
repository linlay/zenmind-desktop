import { WebContents } from "electron";
import { DesktopPageContextSnapshot } from "../../../shared/contracts";
import { EmbeddedCdpSiteSurfaceKind, EmbeddedCdpSurfaceKind, EmbeddedCdpSurfaceRegistration, EmbeddedCdpSurfaceTabRegistration } from "../../../shared/embedded-cdp";
import { type SurfaceIdentity, type SurfaceRole } from "../../../shared/surface-identity";

export type BrowserContainer = SurfaceIdentity & {
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
    pageRouteIdentity: string;
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

export type WorkPanelDialogReservation = { registrationId: string; ownerChatId: string; ownerWebContentsId: number; parentSurfaceId?: string };
export type ResolvedSurface = {
  registered: RegisteredSurface;
  tabs: EmbeddedCdpSurfaceTabRegistration[];
  activeTab: EmbeddedCdpSurfaceTabRegistration | null;
  contents: WebContents | null;
};
