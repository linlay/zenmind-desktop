import type {
  DesktopPetSignatureAction,
  DesktopPetState,
  DesktopPetTaskItem,
  AssistantNavigationAttentionSummary,
  DesktopPetWindowMode,
  DesktopPetAgentOption,
  DesktopPetMessageItem,
  DesktopPetAppearanceOption,
  DesktopPetPreviewPanel,
  DesktopPetEdgeDock,
  DesktopPetPanelPlacement,
  DesktopPetDragDirection
} from "../../../shared/contracts";
import {
  getDesktopPetSignatureActions,
  resolveDesktopPetSignatureActions,
  normalizeDesktopPetBoundAgentKey,
  sanitizeDesktopPetUnreadCount,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  sanitizeDesktopPetRunningTaskCount
} from "../../../shared/desktop-pet";
import type { DesktopPetContextMenuItem, DesktopPetBoundAgentStatus, DesktopPetLocalStatus, DesktopPetStoredState } from "./pet-model";
import { t } from "../../support/i18n/main-i18n";
import { sanitizeDesktopPetMessagePreview, isGenericDesktopPetDoneHint, createDefaultDesktopPetLocalStatus } from "./pet-status-values";
import { sanitizeDesktopPetAppearanceId, normalizeDesktopPetDragDirection } from "./pet-model";
import { isDesktopPetSupportedPlatform } from "./pet-settings";

export function getDesktopPetContextMenuItems(
  appearanceId: unknown,
  signature: DesktopPetSignatureAction[] = getDesktopPetSignatureActions(appearanceId)
): DesktopPetContextMenuItem[] {
  const resolvedSignature = resolveDesktopPetSignatureActions(appearanceId, signature);
  return [
    ...resolvedSignature
      .filter((action) => action.trigger.includes("manual"))
      .map((action) => ({
        action: "signature" as const,
        signatureId: action.id,
        label: action.label
      })),
    {
      action: "hide",
      label: t("desktopPet.context.close")
    }
  ];
}

export function createDefaultDesktopPetAgentStatus(boundAgentKey: string): Pick<
  DesktopPetBoundAgentStatus,
  "agentKey" | "displayName" | "role" | "presence" | "stale"
> {
  return {
    agentKey: normalizeDesktopPetBoundAgentKey(boundAgentKey),
    displayName: "",
    role: "",
    presence: "offline",
    stale: true
  };
}

export function getAgentStatusHint(agentStatus: DesktopPetBoundAgentStatus | null) {
  if (!agentStatus || agentStatus.stale) {
    return "";
  }
  if (agentStatus.hasPendingAwaiting || agentStatus.presence === "busy") {
    return t("desktopPet.status.thinking");
  }
  if (agentStatus.presence === "away") {
    return sanitizeDesktopPetMessagePreview(agentStatus.latestPreview) || t("desktopPet.doneFallback");
  }
  return "";
}

export function normalizeLocalDesktopPetStatus(
  localStatus: DesktopPetLocalStatus
): Pick<DesktopPetState, "status" | "hint" | "messagePreview" | "unreadCount" | "chatId"> {
  if (localStatus.status === "done") {
    return {
      status: "done",
      hint: localStatus.hint.trim() || t("desktopPet.doneFallback"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "error") {
    return {
      status: "error",
      hint: localStatus.hint.trim() || t("desktopPet.status.error"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "awaiting") {
    return {
      status: "awaiting",
      hint: localStatus.hint.trim() || t("desktopPet.status.awaitingConfirm"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  if (localStatus.status === "running") {
    return {
      status: "running",
      hint: t("desktopPet.status.thinking"),
      messagePreview: "",
      unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
      chatId: localStatus.chatId
    };
  }
  return {
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
    chatId: localStatus.chatId
  };
}

export function hasAwaitingDesktopPetTask(activeTasks: DesktopPetTaskItem[] | undefined) {
  return (activeTasks ?? []).some((task) => task.status === "awaiting");
}

export function resolveMergedDesktopPetStatus(
  localStatus: DesktopPetLocalStatus,
  agentStatus: DesktopPetBoundAgentStatus | null,
  activeTasks: DesktopPetTaskItem[] = [],
  navigationAttention?: AssistantNavigationAttentionSummary,
): Pick<DesktopPetState, "status" | "hint" | "messagePreview" | "unreadCount" | "chatId"> {
  if (
    localStatus.status === "done" &&
    agentStatus &&
    !agentStatus.stale &&
    agentStatus.presence === "away" &&
    (!localStatus.chatId || !agentStatus.chatId || localStatus.chatId === agentStatus.chatId)
  ) {
    const agentReplyPreview = sanitizeDesktopPetMessagePreview(agentStatus.latestPreview);
    if (agentReplyPreview && isGenericDesktopPetDoneHint(localStatus.hint)) {
      return {
        status: "done",
        hint: agentReplyPreview,
        messagePreview: "",
        unreadCount: sanitizeDesktopPetUnreadCount(localStatus.unreadCount),
        chatId: agentStatus.chatId || localStatus.chatId
      };
    }
  }

  if (localStatus.status !== "idle") {
    return normalizeLocalDesktopPetStatus(localStatus);
  }

  const attentionTask = activeTasks.find((task) => task.status === "awaiting") ?? activeTasks[0];
  if (attentionTask) {
    return {
      status: attentionTask.status === "awaiting" ? "awaiting" : "running",
      hint: attentionTask.status === "awaiting"
        ? t("desktopPet.status.awaitingConfirm")
        : t("desktopPet.status.thinking"),
      messagePreview: "",
      unreadCount: navigationAttention?.total.unreadCount ?? 0,
      chatId: attentionTask.chatId,
    };
  }

  if (agentStatus && !agentStatus.stale) {
    const hint = getAgentStatusHint(agentStatus);
    const unreadCount = sanitizeDesktopPetUnreadCount(agentStatus.unreadCount);
    const status = agentStatus.presence === "away"
      ? "done"
      : agentStatus.hasPendingAwaiting || hasAwaitingDesktopPetTask(activeTasks)
        ? "awaiting"
        : agentStatus.presence === "busy"
          ? "running"
        : "idle";
    const awaitingHint = status === "awaiting"
      ? sanitizeDesktopPetMessagePreview(agentStatus.latestPreview) || t("desktopPet.status.awaitingConfirm")
      : hint;
    return {
      status,
      hint: awaitingHint,
      messagePreview: status === "idle" && unreadCount > 0
        ? sanitizeDesktopPetMessagePreview(agentStatus.latestPreview)
        : "",
      unreadCount,
      chatId: agentStatus.chatId
    };
  }

  return {
    status: "idle",
    hint: "",
    messagePreview: "",
    unreadCount: navigationAttention?.total.unreadCount ?? 0,
    chatId: null
  };
}

export function createDesktopPetState(
  settings: DesktopPetStoredState,
  options: {
    supported?: boolean;
    enabled?: boolean;
    windowMode?: DesktopPetWindowMode;
    localStatus?: DesktopPetLocalStatus;
    agentStatus?: DesktopPetBoundAgentStatus | null;
    agentOptions?: DesktopPetAgentOption[];
    activeTasks?: DesktopPetTaskItem[];
    messages?: DesktopPetMessageItem[];
    navigationAttention?: AssistantNavigationAttentionSummary;
    appearanceOptions?: DesktopPetAppearanceOption[];
    previewPanel?: DesktopPetPreviewPanel | null;
    runningTaskCount?: unknown;
    edgeDock?: DesktopPetEdgeDock;
    bodyOffset?: { x: number; y: number };
    panelPlacement?: DesktopPetPanelPlacement;
    dragDirection?: DesktopPetDragDirection;
    dragMoved?: unknown;
  } = {}
): DesktopPetState {
  const localStatus = options.localStatus ?? createDefaultDesktopPetLocalStatus(settings);
  const agentStatus = options.agentStatus ?? null;
  const activeTasks = options.activeTasks ?? [];
  const navigationAttention = options.navigationAttention ?? {
    chats: { unreadCount: 0, pendingCount: 0 },
    projects: { unreadCount: 0, pendingCount: 0 },
    total: { unreadCount: 0, pendingCount: 0 },
  };
  const mergedStatus = resolveMergedDesktopPetStatus(
    localStatus,
    agentStatus,
    activeTasks,
    navigationAttention,
  );
  const appearanceOptions: DesktopPetAppearanceOption[] = [
    ...DESKTOP_PET_APPEARANCE_OPTIONS,
    ...(options.appearanceOptions ?? [])
  ];
  const sanitizedAppearanceId = sanitizeDesktopPetAppearanceId(settings.appearanceId);
  const appearanceId = appearanceOptions.some((appearance) => appearance.id === sanitizedAppearanceId)
    ? sanitizedAppearanceId
    : DEFAULT_DESKTOP_PET_APPEARANCE_ID;
  const appearanceOption = appearanceOptions.find((appearance) => appearance.id === appearanceId);
  const signature = resolveDesktopPetSignatureActions(
    appearanceId,
    appearanceOption?.signature
  );
  const activeAgentKey = agentStatus?.agentKey || settings.boundAgentKey;
  const agentDefaults = createDefaultDesktopPetAgentStatus(activeAgentKey);
  return {
    supported: options.supported ?? isDesktopPetSupportedPlatform(process.platform),
    enabled: Boolean(options.enabled),
    windowMode: options.windowMode ?? "base",
    ...mergedStatus,
    unreadCount: navigationAttention.total.unreadCount,
    navigationAttention,
    appearanceId,
    appearanceOptions,
    boundAgentKey: activeAgentKey,
    agentDisplayName: agentStatus?.displayName ?? agentDefaults.displayName,
    agentRole: agentStatus?.role ?? agentDefaults.role,
    agentPresence: agentStatus?.presence ?? agentDefaults.presence,
    agentStatusStale: agentStatus?.stale ?? agentDefaults.stale,
    agentOptions: options.agentOptions ?? [],
    activeTasks,
    messages: options.messages ?? [],
    previewPanel: options.previewPanel ?? null,
    runningTaskCount: sanitizeDesktopPetRunningTaskCount(options.runningTaskCount),
    edgeDock: options.edgeDock ?? null,
    ...(options.bodyOffset ? { bodyOffset: options.bodyOffset } : {}),
    panelPlacement: options.panelPlacement ?? null,
    dragDirection: normalizeDesktopPetDragDirection(options.dragDirection),
    dragMoved: Boolean(options.dragMoved),
    signature,
    updatedAt: Date.now()
  };
}
