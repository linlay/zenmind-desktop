import type { DesktopPetSettingsLike, DesktopPetWindowModeStateLike } from "./controller-model";
import type { DesktopPetWindowMode } from "./desktop-pet";
import type { DesktopPetLocalStatus, DesktopPetBoundAgentStatus } from "./pet-model";
import type {
  DesktopPetAgentOption,
  DesktopPetTaskItem,
  DesktopPetMessageItem,
  AssistantNavigationAttentionSummary,
  DesktopPetAppearanceOption,
  DesktopPetPreviewPanel,
  DesktopPetEdgeDock,
  DesktopPetPanelPlacement,
  DesktopPetDragDirection
} from "../../../shared/contracts";
import { createDesktopPetState } from "./pet-state";

export function computeDesktopPetStateRefresh(input: {
  settings: DesktopPetSettingsLike;
  supported: boolean;
  enabled: boolean;
  windowMode?: DesktopPetWindowMode;
  localStatus: DesktopPetLocalStatus;
  patch?: Partial<DesktopPetLocalStatus>;
  agentStatus: DesktopPetBoundAgentStatus | null;
  agentOptions: DesktopPetAgentOption[];
  activeTasks?: DesktopPetTaskItem[];
  messages?: DesktopPetMessageItem[];
  navigationAttention?: AssistantNavigationAttentionSummary;
  appearanceOptions?: DesktopPetAppearanceOption[];
  previewPanel: DesktopPetPreviewPanel | null;
  runningTaskCount: number;
  edgeDock: DesktopPetEdgeDock;
  bodyOffset?: { x: number; y: number };
  panelPlacement?: DesktopPetPanelPlacement;
  dragDirection?: DesktopPetDragDirection;
  dragMoved?: unknown;
}) {
  const localStatus = input.patch && Object.keys(input.patch).length > 0
    ? {
        ...input.localStatus,
        ...input.patch
      }
    : input.localStatus;
  const state = createDesktopPetState(input.settings, {
    supported: input.supported,
    enabled: input.enabled,
    windowMode: input.windowMode ?? "base",
    localStatus,
    agentStatus: input.agentStatus,
    agentOptions: input.agentOptions,
    activeTasks: input.activeTasks,
    messages: input.messages,
    navigationAttention: input.navigationAttention,
    appearanceOptions: input.appearanceOptions,
    previewPanel: input.previewPanel,
    runningTaskCount: input.runningTaskCount,
    edgeDock: input.edgeDock,
    bodyOffset: input.bodyOffset,
    panelPlacement: input.panelPlacement,
    dragDirection: input.dragDirection ?? null,
    dragMoved: input.dragMoved
  });
  const settingsPatch = input.settings.unreadCount !== state.unreadCount
    ? {
        unreadCount: state.unreadCount
      }
    : null;
  return {
    localStatus,
    settingsPatch,
    state
  };
}

export function resolveDesktopPetWindowMode(input: {
  dragging?: boolean;
  layoutMode?: DesktopPetWindowMode;
  state: DesktopPetWindowModeStateLike;
  previewPanel?: { visible?: boolean; expanded?: boolean; status?: string } | null;
}): DesktopPetWindowMode {
  if (input.dragging) {
    return "base";
  }
  if (input.layoutMode) {
    return input.layoutMode === "bubble" ? "bubble" : "base";
  }
  const hasHistoryMessages = Array.isArray(input.state.messages) && input.state.messages.length > 0;
  return hasHistoryMessages ? "bubble" : "base";
}

export function createDesktopPetIdleResetAction(clearPreview = false) {
  return {
    clearPreview,
    rememberDismissedDonePreview: clearPreview,
    patch: {
      status: "idle" as const,
      hint: "",
      unreadCount: 0
    }
  };
}
