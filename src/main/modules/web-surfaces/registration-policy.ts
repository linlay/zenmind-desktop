import type { SurfaceRole } from "../../../shared/surface-identity";
import { readAgentWebclientAgentRouteKey } from "../../../shared/agent-webclient-routes";
import { readAgentWebclientCanonicalChatSource, readAgentWebclientNewChatSource } from "../../../shared/canonical-chat-sync";
import { EmbeddedCdpSurfaceKind, EmbeddedCdpSurfaceRegistration, EmbeddedCdpSurfaceTabRegistration } from "../../../shared/embedded-cdp";
import { COPILOT_DOCK_SURFACE_ID, KANBAN_CHAT_SURFACE_ID, MAIN_CHAT_SURFACE_ID, SELECTION_EXPLAIN_SURFACE_ID, surfaceIdentityMatchesPolicy } from "../../../shared/surface-identity";
import type { BrowserSurfaceRegistryOptions, RegisteredSurface, ResolvedSurface, SurfaceRegistrationValidation } from "./registry-contracts";

export function registeredSurfaceIdentitiesConflict(
  existing: Pick<EmbeddedCdpSurfaceRegistration, "surfaceId" | "surfaceRole" | "surfaceIdentityKey">,
  candidate: Pick<EmbeddedCdpSurfaceRegistration, "surfaceId" | "surfaceRole" | "surfaceIdentityKey">,
) {
  if (existing.surfaceId.trim() !== candidate.surfaceId.trim()) return false;
  if (existing.surfaceRole !== candidate.surfaceRole) return true;
  // The singleton Dock's key is its current page context, not its guest identity.
  // Context/parent changes keep the Dock mounted; owner and parent authorization
  // remain enforced by registerSurfaceResult and query-time SiteControlScope.
  if (existing.surfaceId.trim() === COPILOT_DOCK_SURFACE_ID && existing.surfaceRole === "copilot-dock") {
    return false;
  }
  return (existing.surfaceIdentityKey?.trim() || "") !== (candidate.surfaceIdentityKey?.trim() || "");
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

interface RegistrationPolicyDependencies {
  readonly resolveCanonicalSurfaceId: (surfaceId: string) => string;
  readonly resolveRegisteredSurface: (surfaceId: string) => ResolvedSurface | null;
  readonly workPanelDialogRegistrations: ReadonlyMap<string, { registrationId: string; ownerChatId: string; ownerWebContentsId: number; parentSurfaceId?: string }>;
  readonly registeredSurfaces: ReadonlyMap<string, RegisteredSurface>;
}

/** Private registration policy responsibility. */
export function createRegistrationPolicy(options: Pick<BrowserSurfaceRegistryOptions, "listWebEntries">, dependencies: RegistrationPolicyDependencies) {

  function expectedRolesForRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRole[] {
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
    if (input.surfaceType === "agent-selection-explain")
      return ["selection-explain"];
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
    if (["main-chat", "kanban-chat", "copilot-dock", "overview", "debug", "btw", "selection-explain", "source", "project", "file-diff", "artifact", "reference", "file", "planning", "agent", "copilot", "skill"].includes(input.surfaceRole) &&
      input.serviceId?.trim() !== "agent-webclient")
      return { ok: false, check: "agent_webclient_service_mismatch" };
    if ((input.surfaceRole === "main-chat" && input.surfaceId !== MAIN_CHAT_SURFACE_ID) ||
      (input.surfaceRole === "kanban-chat" && input.surfaceId !== KANBAN_CHAT_SURFACE_ID) ||
      (input.surfaceRole === "copilot-dock" && input.surfaceId !== COPILOT_DOCK_SURFACE_ID) ||
      (input.surfaceRole === "selection-explain" && input.surfaceId !== SELECTION_EXPLAIN_SURFACE_ID))
      return { ok: false, check: "fixed_surface_id_mismatch" };
    if (input.surfaceRole === "copilot-dock" &&
      input.surfaceIdentityKey?.trim() === "desktop-route:/kanban")
      return { ok: false, check: "forbidden_route" };
    if (input.surfaceLevel === "child") {
      if (!input.parentSurfaceId && input.surfaceRole !== "project" && input.surfaceRole !== "copilot-dock") {
        return { ok: false, check: "missing_parent_surface" };
      }
      if (input.parentSurfaceId) {
        const canonicalParentSurfaceId = dependencies.resolveCanonicalSurfaceId(input.parentSurfaceId);
        if (canonicalParentSurfaceId !== input.parentSurfaceId ||
          canonicalParentSurfaceId === input.surfaceId ||
          (!dependencies.resolveRegisteredSurface(canonicalParentSurfaceId) && dependencies.workPanelDialogRegistrations.get(input.surfaceId)?.registrationId !== input.registrationId))
          return { ok: false, check: "invalid_parent_surface" };
        const visited = new Set([input.surfaceId]);
        let cursor = dependencies.registeredSurfaces.get(canonicalParentSurfaceId);
        while (cursor) {
          if (visited.has(cursor.surfaceId))
            return { ok: false, check: "parent_cycle" };
          visited.add(cursor.surfaceId);
          cursor = cursor.parentSurfaceId ? dependencies.registeredSurfaces.get(cursor.parentSurfaceId) : undefined;
        }
      }
    }
    else if (input.parentSurfaceId) {
      return { ok: false, check: "unexpected_parent_surface" };
    }
    return { ok: true };
  }

  function isValidSurfaceTab(input: EmbeddedCdpSurfaceTabRegistration): boolean {
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

  function validateSurfaceRegistration(input: EmbeddedCdpSurfaceRegistration): SurfaceRegistrationValidation {
    const validKinds: EmbeddedCdpSurfaceKind[] = ["website", "webapp", "browser", "service", "chat-work-panel"];
    const validSurfaceTypes = new Set([
      "agent-chat",
      "agent-copilot",
      "agent-overview",
      "agent-debug",
      "agent-btw",
      "agent-selection-explain",
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
    const identityValidation = validateRegistrationIdentity(input);
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
      if (!isValidSurfaceTab(tab))
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

  return { validateSurfaceRegistration };
}
