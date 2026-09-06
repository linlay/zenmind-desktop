import fs from "node:fs";

import path from "node:path";

import type { App, Rectangle } from "electron";

import type {
  DesktopPetAppearanceOption,
  DesktopPetSignatureAction,
  DesktopPetStateAsset,
  DesktopPetStateAssets,
  DesktopPetTaskItem,
  DesktopPetMessageItem,
  DesktopPetAgentOption,
  DesktopPetAgentPresence,
  AssistantNavigationAttentionSummary,
  DesktopPetDragDirection,
  DesktopPetEdgeDock,
  DesktopPetPanelPlacement,
  DesktopPetPreviewPanel,
  DesktopPetSettings,
  DesktopPetState,
  DesktopPetStatus,
  DesktopPetWindowMode
} from "../../../shared/contracts";

import {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DEFAULT_DESKTOP_PET_SELECTED_ID,
  DESKTOP_PET_USER_ASSET_PROTOCOL,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  DESKTOP_PET_REQUIRED_STATE_KEYS,
  DESKTOP_PET_STANDARD_ACTION_MAX_FRAMES,
  DESKTOP_PET_STANDARD_ACTION_MIN_FRAMES,
  DESKTOP_PET_STATUS_HINT_TEXTS,
  applyDesktopPetActiveRunEvent,
  getDesktopPetSignatureActions,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey,
  normalizeDesktopPetWhitespaceText,
  resolveDesktopPetSignatureActions,
  resolveDesktopPetRunningTaskCount,
  sanitizeDesktopPetRunningTaskCount,
  sanitizeDesktopPetUnreadCount,
  truncateDesktopPetReplyPreview
} from "../../../shared/desktop-pet";

import { t } from "../../support/i18n/main-i18n";

import {
  getDesktopPetSettingsPath as resolveDesktopPetSettingsPath,
  getDesktopPetsDataRoot,
  getDesktopStateRoot
} from "../../infrastructure/filesystem/user-paths";

import { DEFAULT_DESKTOP_PET_ID, DEFAULT_OFFSET, DESKTOP_PET_CONFIG_FILE, DESKTOP_PET_EDGE_SNAP_DISTANCE_PX, DESKTOP_PET_EDGE_STICK_DISTANCE_PX, DESKTOP_PET_PANEL_WINDOW_INSET_PX, DESKTOP_PET_STATE_FILE, DESKTOP_PET_VISIBLE_FOOTPRINT, DESKTOP_PET_WINDOW_SIZE, DESKTOP_PET_WINDOW_SIZES, DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS, DesktopPetBoundAgentStatus, DesktopPetClampOptions, DesktopPetDisplayBounds, DesktopPetLocalStatus, DesktopPetStoredState, DisplayArea, createDefaultDesktopPetLocalStatus, getDesktopPetRoot, getDesktopPetStatePath, isDesktopPetSupportedPlatform, isGenericDesktopPetDoneHint, listUserDesktopPetAppearanceOptions, listUserDesktopPets, normalizeDesktopPetDragDirection, normalizeUserDesktopPetId, sanitizeDesktopPetAppearanceId, sanitizeDesktopPetAssetRelativePath, sanitizeDesktopPetMessagePreview, sanitizeDesktopPetStoredState, sanitizeUserPetDirectoryName, selectedPetIdForAppearance, userPetAssetBaseUrl, userPetAssetUrl } from "./desktop-pet.part-1";

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
    panelPlacement: options.panelPlacement ?? null,
    dragDirection: normalizeDesktopPetDragDirection(options.dragDirection),
    dragMoved: Boolean(options.dragMoved),
    signature,
    updatedAt: Date.now()
  };
}

export function getDesktopPetWindowSize(mode: DesktopPetWindowMode = "base") {
  return DESKTOP_PET_WINDOW_SIZES[mode] ?? DESKTOP_PET_WINDOW_SIZES.base;
}

export function resolveDesktopPetDisplayArea(display: DesktopPetDisplayBounds): DisplayArea {
  const horizontalBounds = display.bounds ?? display.workArea;
  const workAreaBottom = display.workArea.y + display.workArea.height;
  return {
    x: horizontalBounds.x,
    y: display.workArea.y,
    width: Math.max(1, horizontalBounds.width),
    height: Math.max(1, workAreaBottom - display.workArea.y)
  };
}

export function desktopPetEdgeDockIncludes(edgeDock: DesktopPetEdgeDock, side: "top" | "right" | "bottom" | "left") {
  return edgeDock === side || Boolean(edgeDock?.includes(`${side}-`) || edgeDock?.includes(`-${side}`));
}

export function getDesktopPetVisibleFootprintForMode(mode: DesktopPetWindowMode, edgeDock: DesktopPetEdgeDock = null) {
  const footprint = DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS[mode] ?? DESKTOP_PET_VISIBLE_FOOTPRINT;
  const size = getDesktopPetWindowSize(mode);
  const adjustedFootprint = {
    ...footprint
  };
  if (desktopPetEdgeDockIncludes(edgeDock, "left")) {
    adjustedFootprint.x = 0;
  } else if (desktopPetEdgeDockIncludes(edgeDock, "right")) {
    adjustedFootprint.x = size.width - DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  }
  if (desktopPetEdgeDockIncludes(edgeDock, "top")) {
    adjustedFootprint.y = 0;
  } else if (desktopPetEdgeDockIncludes(edgeDock, "bottom")) {
    adjustedFootprint.y = size.height - DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  }
  return adjustedFootprint;
}

export function clampDesktopPetPosition(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  size: { width: number; height: number } = DESKTOP_PET_WINDOW_SIZE,
  options: DesktopPetClampOptions = {}
) {
  const width = size.width;
  const height = size.height;
  const allowVisibleEdgeDock = options.allowVisibleEdgeDock &&
    width === DESKTOP_PET_WINDOW_SIZE.width &&
    height === DESKTOP_PET_WINDOW_SIZE.height;
  const minX = allowVisibleEdgeDock
    ? displayArea.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x
    : displayArea.x;
  const minY = allowVisibleEdgeDock
    ? displayArea.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y
    : displayArea.y;
  const maxX = allowVisibleEdgeDock
    ? displayArea.x + Math.max(
      0,
      displayArea.width - DESKTOP_PET_VISIBLE_FOOTPRINT.x - DESKTOP_PET_VISIBLE_FOOTPRINT.width
    )
    : displayArea.x + Math.max(0, displayArea.width - width);
  const maxY = allowVisibleEdgeDock
    ? displayArea.y + Math.max(
      0,
      displayArea.height - DESKTOP_PET_VISIBLE_FOOTPRINT.y - DESKTOP_PET_VISIBLE_FOOTPRINT.height
    )
    : displayArea.y + Math.max(0, displayArea.height - height);
  const fallbackX = Math.min(maxX, displayArea.x + DEFAULT_OFFSET.x);
  const fallbackY = Math.min(maxY, displayArea.y + DEFAULT_OFFSET.y);
  const resolved = position ?? { x: fallbackX, y: fallbackY };
  let x = Math.round(resolved.x);
  let y = Math.round(resolved.y);
  if (allowVisibleEdgeDock && options.stickToEdges) {
    const rightEdge = displayArea.x + displayArea.width;
    const bottomEdge = displayArea.y + displayArea.height;
    const visibleLeft = x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
    const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
    const visibleTop = y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
    const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
    if (Math.abs(visibleLeft - displayArea.x) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      x = minX;
    } else if (Math.abs(visibleRight - rightEdge) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      x = maxX;
    }
    if (Math.abs(visibleTop - displayArea.y) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      y = minY;
    } else if (Math.abs(visibleBottom - bottomEdge) <= DESKTOP_PET_EDGE_SNAP_DISTANCE_PX) {
      y = maxY;
    }
  }
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    y: Math.max(minY, Math.min(maxY, y)),
    width,
    height
  };
}

export function resolveDesktopPetEdgeDock(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea
): DesktopPetEdgeDock {
  if (!position) {
    return null;
  }
  const rightEdge = displayArea.x + displayArea.width;
  const bottomEdge = displayArea.y + displayArea.height;
  const visibleLeft = position.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x;
  const visibleTop = position.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y;
  const visibleRight = visibleLeft + DESKTOP_PET_VISIBLE_FOOTPRINT.width;
  const visibleBottom = visibleTop + DESKTOP_PET_VISIBLE_FOOTPRINT.height;
  const vertical = visibleTop <= displayArea.y + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
    ? "top"
    : visibleBottom >= bottomEdge - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? "bottom"
      : "";
  const horizontal = visibleLeft <= displayArea.x + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
    ? "left"
    : visibleRight >= rightEdge - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? "right"
      : "";
  if (vertical && horizontal) {
    return `${vertical}-${horizontal}` as DesktopPetEdgeDock;
  }
  return (vertical || horizontal || null) as DesktopPetEdgeDock;
}

export type DesktopPetPanelLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopPetPanelLayoutSide = "above" | "below" | "left" | "right";

export function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampDesktopPetPanelAxis(center: number, size: number, min: number, max: number) {
  return Math.round(clampNumber(center - size / 2, min, max - size));
}

export function clampDesktopPetPanelRect(
  rect: DesktopPetPanelLayoutRect,
  displayArea: DisplayArea,
  displayRight: number,
  displayBottom: number
) {
  return {
    ...rect,
    x: Math.round(clampNumber(rect.x, displayArea.x, displayRight - rect.width)),
    y: Math.round(clampNumber(rect.y, displayArea.y, displayBottom - rect.height))
  };
}

export function resolveDesktopPetPanelLayout(input: {
  displayArea: DisplayArea;
  petRect: DesktopPetPanelLayoutRect;
  panelSize: { width: number; height: number };
  gap?: number;
}): { side: DesktopPetPanelLayoutSide; rect: DesktopPetPanelLayoutRect } {
  const gap = Math.max(0, Math.round(input.gap ?? 10));
  const displayRight = input.displayArea.x + input.displayArea.width;
  const displayBottom = input.displayArea.y + input.displayArea.height;
  const panelWidth = Math.min(input.panelSize.width, input.displayArea.width);
  const panelHeight = Math.min(input.panelSize.height, input.displayArea.height);
  const petCenterX = input.petRect.x + input.petRect.width / 2;
  const petCenterY = input.petRect.y + input.petRect.height / 2;
  const displayCenterY = input.displayArea.y + input.displayArea.height / 2;
  const horizontalX = clampDesktopPetPanelAxis(petCenterX, panelWidth, input.displayArea.x, displayRight);
  const verticalY = clampDesktopPetPanelAxis(petCenterY, panelHeight, input.displayArea.y, displayBottom);
  const candidates = [
    {
      side: "below" as const,
      rect: {
        x: horizontalX,
        y: Math.round(input.petRect.y + input.petRect.height + gap),
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "above" as const,
      rect: {
        x: horizontalX,
        y: Math.round(input.petRect.y - gap - panelHeight),
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "right" as const,
      rect: {
        x: Math.round(input.petRect.x + input.petRect.width + gap),
        y: verticalY,
        width: panelWidth,
        height: panelHeight
      }
    },
    {
      side: "left" as const,
      rect: {
        x: Math.round(input.petRect.x - gap - panelWidth),
        y: verticalY,
        width: panelWidth,
        height: panelHeight
      }
    }
  ];
  const preferredSides: DesktopPetPanelLayoutSide[] =
    input.petRect.y <= input.displayArea.y + DESKTOP_PET_EDGE_STICK_DISTANCE_PX
      ? ["below", "right", "left", "above"]
      : input.petRect.y + input.petRect.height >= displayBottom - DESKTOP_PET_EDGE_STICK_DISTANCE_PX
        ? ["above", "right", "left", "below"]
        : petCenterY <= displayCenterY
          ? ["below", "above", "right", "left"]
          : ["above", "below", "right", "left"];

  for (const side of preferredSides) {
    const candidate = candidates.find((item) => item.side === side);
    if (!candidate) {
      continue;
    }
    const rectRight = candidate.rect.x + candidate.rect.width;
    const rectBottom = candidate.rect.y + candidate.rect.height;
    if (
      candidate.rect.x >= input.displayArea.x &&
      candidate.rect.y >= input.displayArea.y &&
      rectRight <= displayRight &&
      rectBottom <= displayBottom
    ) {
      return candidate;
    }
  }

  const fallbackCandidate =
    candidates.find((item) => item.side === preferredSides[0]) ?? candidates[0];
  return {
    side: fallbackCandidate.side,
    rect: clampDesktopPetPanelRect(
      fallbackCandidate.rect,
      input.displayArea,
      displayRight,
      displayBottom
    )
  };
}

export function resolveDesktopPetPanelWindowBounds(input: {
  displayArea: DisplayArea;
  petRect: DesktopPetPanelLayoutRect;
  windowSize: { width: number; height: number };
  gap?: number;
  inset?: number;
}): {
  side: DesktopPetPanelLayoutSide;
  rect: DesktopPetPanelLayoutRect;
  panelRect: DesktopPetPanelLayoutRect;
} {
  const inset = Math.max(0, Math.round(input.inset ?? DESKTOP_PET_PANEL_WINDOW_INSET_PX));
  const panelSize = {
    width: Math.max(1, input.windowSize.width - inset * 2),
    height: Math.max(1, input.windowSize.height - inset * 2)
  };
  const layout = resolveDesktopPetPanelLayout({
    displayArea: input.displayArea,
    petRect: input.petRect,
    panelSize,
    gap: input.gap
  });
  return {
    side: layout.side,
    panelRect: layout.rect,
    rect: {
      x: layout.rect.x - inset,
      y: layout.rect.y - inset,
      width: panelSize.width + inset * 2,
      height: panelSize.height + inset * 2
    }
  };
}

export function getAnchoredDesktopPetBounds(
  position: { x: number; y: number } | undefined,
  displayArea: DisplayArea,
  mode: DesktopPetWindowMode = "base"
) {
  const size = getDesktopPetWindowSize(mode);
  const baseBounds = clampDesktopPetPosition(position, displayArea, DESKTOP_PET_WINDOW_SIZE, {
    allowVisibleEdgeDock: true
  });
  const edgeDock = resolveDesktopPetEdgeDock(baseBounds, displayArea);
  const footprint = getDesktopPetVisibleFootprintForMode(mode, edgeDock);
  const anchoredX = baseBounds.x + DESKTOP_PET_VISIBLE_FOOTPRINT.x - footprint.x;
  const anchoredY = baseBounds.y + DESKTOP_PET_VISIBLE_FOOTPRINT.y - footprint.y;
  if (mode === "base" && desktopPetEdgeDockIncludes(edgeDock, "left")) {
    return {
      x: displayArea.x,
      y: anchoredY,
      width: Math.max(size.width, displayArea.width),
      height: size.height
    };
  }
  return {
    x: anchoredX,
    y: anchoredY,
    width: size.width,
    height: size.height
  };
}

export function getDesktopPetLogicalPositionFromBounds(
  bounds: { x: number; y: number },
  mode: DesktopPetWindowMode = "base",
  displayArea?: DisplayArea,
  preferredPosition?: { x: number; y: number }
) {
  if (displayArea) {
    const displayRight = displayArea.x + displayArea.width;
    const shouldPreferWindowBoundaryEdges = mode === "base";
    const boundsTouchLeft = shouldPreferWindowBoundaryEdges && bounds.x <= displayArea.x + 1;
    const boundsWidth = "width" in bounds ? Number((bounds as { width?: number }).width) : Number.NaN;
    const isFullWidthLeftHost = boundsTouchLeft &&
      Number.isFinite(boundsWidth) &&
      boundsWidth >= displayArea.width - 1;
    const boundsTouchRight = shouldPreferWindowBoundaryEdges && !isFullWidthLeftHost && Number.isFinite(boundsWidth)
      ? bounds.x + boundsWidth >= displayRight - 1
      : false;
    const edgeCandidates: DesktopPetEdgeDock[] = [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
      "top",
      "right",
      "bottom",
      "left",
      null
    ];
    const matches: Array<{
      logicalPosition: { x: number; y: number };
      distance: number;
      edgeScore: number;
    }> = [];
    for (const edgeDock of edgeCandidates) {
      const footprint = getDesktopPetVisibleFootprintForMode(mode, edgeDock);
      const logicalPosition = {
        x: Math.round(bounds.x + footprint.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x),
        y: Math.round(bounds.y + footprint.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y)
      };
      const reanchoredBounds = getAnchoredDesktopPetBounds(logicalPosition, displayArea, mode);
      if (
        resolveDesktopPetEdgeDock(logicalPosition, displayArea) === edgeDock &&
        reanchoredBounds.x === bounds.x &&
        reanchoredBounds.y === bounds.y
      ) {
        const distance = preferredPosition
          ? Math.hypot(logicalPosition.x - preferredPosition.x, logicalPosition.y - preferredPosition.y)
          : matches.length;
        const edgeScore =
          (boundsTouchLeft && desktopPetEdgeDockIncludes(edgeDock, "left") ? 1 : 0) +
          (boundsTouchRight && desktopPetEdgeDockIncludes(edgeDock, "right") ? 1 : 0);
        matches.push({
          logicalPosition,
          distance,
          edgeScore
        });
      }
    }
    if (matches.length > 0) {
      matches.sort((left, right) => right.edgeScore - left.edgeScore || left.distance - right.distance);
      return matches[0].logicalPosition;
    }
  }
  const footprint = getDesktopPetVisibleFootprintForMode(mode);
  return {
    x: Math.round(bounds.x + footprint.x - DESKTOP_PET_VISIBLE_FOOTPRINT.x),
    y: Math.round(bounds.y + footprint.y - DESKTOP_PET_VISIBLE_FOOTPRINT.y)
  };
}

export const __testInternals = {
  DEFAULT_OFFSET,
  DEFAULT_DESKTOP_PET_ID,
  DESKTOP_PET_CONFIG_FILE,
  DESKTOP_PET_STATE_FILE,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
  DESKTOP_PET_WINDOW_SIZES,
  DESKTOP_PET_PANEL_WINDOW_INSET_PX,
  DESKTOP_PET_EDGE_SNAP_DISTANCE_PX,
  getDesktopPetVisibleFootprintForMode,
  resolveDesktopPetDisplayArea,
  sanitizeDesktopPetStoredState,
  normalizeDesktopPetAppearanceId,
  selectedPetIdForAppearance,
  sanitizeUserPetDirectoryName,
  sanitizeDesktopPetAssetRelativePath,
  userPetAssetBaseUrl,
  userPetAssetUrl,
  normalizeUserDesktopPetId,
  sanitizeDesktopPetMessagePreview,
  sanitizeDesktopPetUnreadCount,
  resolveMergedDesktopPetStatus,
  resolveDesktopPetEdgeDock,
  resolveDesktopPetPanelLayout,
  resolveDesktopPetPanelWindowBounds,
  getAnchoredDesktopPetBounds,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetRoot,
  getDesktopPetStatePath,
  listUserDesktopPets,
  listUserDesktopPetAppearanceOptions
};
