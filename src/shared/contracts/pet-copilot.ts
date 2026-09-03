import type {
  AssistantAwaitingMode,
  AssistantNavAgentIcon,
  AssistantNavigationAttentionSummary,
} from "./copilot";

export type DesktopPetStatus = "idle" | "running" | "awaiting" | "done" | "error";
export type DesktopPetAgentPresence = "available" | "busy" | "away" | "offline";
export type DesktopPetEdgeDock =
  | "top"
  | "right"
  | "bottom"
  | "left"
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left"
  | null;

export type DesktopPetWindowMode =
  | "base"
  | "bubble"
  | "preview-collapsed"
  | "preview-expanded"
  | "task-list-compact"
  | "task-list";
export type DesktopPetDragDirection = "left" | "right" | null;

export type DesktopPetPanelPlacement =
  | "above"
  | "below"
  | "left"
  | "right"
  | null;

export interface DesktopPetSettings {
  enabled: boolean;
  boundAgentKey: string;
  appearanceId: string;
}

export interface DesktopPetSettingsInput {
  enabled?: boolean;
  boundAgentKey?: string;
  appearanceId?: string;
}

export interface DesktopPetAppearanceOption {
  id: string;
  displayName: string;
  description: string;
  assetBasePath: string;
  preview: string;
  previewUrl: string;
  states: DesktopPetStateAssets;
  signature?: DesktopPetSignatureAction[];
}

export interface DesktopPetAgentOption {
  agentKey: string;
  displayName: string;
  role: string;
  icon?: AssistantNavAgentIcon;
  unreadCount: number;
}

export type DesktopPetTaskStatus = "running" | "awaiting" | "done";

export interface DesktopPetTaskItem {
  id: string;
  agentKey: string;
  agentDisplayName: string;
  chatId: string;
  runId: string | null;
  title: string;
  preview: string;
  status: DesktopPetTaskStatus;
  awaitingCount?: number;
  awaitingMode?: AssistantAwaitingMode;
  updatedAt: number;
}

export type DesktopPetMessageStatus = "running" | "awaiting" | "done" | "error";

export interface DesktopPetMessageItem {
  id: string;
  chatId: string;
  runId: string | null;
  agentKey: string;
  agentDisplayName: string;
  title: string;
  preview: string;
  status: DesktopPetMessageStatus;
  unread: boolean;
  awaitingCount?: number;
  awaitingMode?: AssistantAwaitingMode;
  updatedAt: number;
}

export type DesktopPetPreviewItemKind =
  | "thinking"
  | "content"
  | "tool"
  | "action"
  | "awaiting"
  | "awaiting-answer"
  | "artifact"
  | "plan"
  | "task"
  | "status";

export type DesktopPetPreviewItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled"
  | "done";

export interface DesktopPetPreviewItem {
  id: string;
  kind: DesktopPetPreviewItemKind;
  title: string;
  text: string;
  detailText?: string;
  status: DesktopPetPreviewItemStatus;
  createdAt: number;
}

export interface DesktopPetPreviewAwaiting {
  awaitingId: string;
  mode: AssistantAwaitingMode | "";
  count: number;
  title: string;
  timeoutMs?: number | null;
}

export interface DesktopPetPreviewPanel {
  runId: string;
  chatId: string | null;
  visible: boolean;
  expanded: boolean;
  title: string;
  summary: string;
  status: "running" | "waiting" | "done" | "error" | "stopped";
  items: DesktopPetPreviewItem[];
  artifactCount: number;
  awaiting?: DesktopPetPreviewAwaiting;
  updatedAt: number;
}

export type DesktopPetSignatureTrigger = "manual" | "idle-random";

export interface DesktopPetSignatureVariant {
  path: string;
  frameCount: number;
  durationMs: number;
  weight?: number;
}

export interface DesktopPetSignatureAction {
  id: string;
  label: string;
  trigger: DesktopPetSignatureTrigger[];
  variants: DesktopPetSignatureVariant[];
}

export interface DesktopPetStateAsset {
  path: string;
  frameCount?: number;
  durationMs?: number;
  loop?: boolean;
  mirror?: boolean;
  holdMs?: number;
  alts?: DesktopPetSignatureAction[];
}

export type DesktopPetStateAssets = Partial<Record<string, DesktopPetStateAsset>>;

export interface DesktopPetState {
  supported: boolean;
  enabled: boolean;
  windowMode: DesktopPetWindowMode;
  status: DesktopPetStatus;
  hint: string;
  messagePreview: string;
  unreadCount: number;
  navigationAttention: AssistantNavigationAttentionSummary;
  chatId: string | null;
  appearanceId: string;
  appearanceOptions: DesktopPetAppearanceOption[];
  boundAgentKey: string;
  agentDisplayName: string;
  agentRole: string;
  agentPresence: DesktopPetAgentPresence;
  agentStatusStale: boolean;
  agentOptions: DesktopPetAgentOption[];
  activeTasks: DesktopPetTaskItem[];
  messages: DesktopPetMessageItem[];
  previewPanel: DesktopPetPreviewPanel | null;
  runningTaskCount: number;
  edgeDock: DesktopPetEdgeDock;
  panelPlacement: DesktopPetPanelPlacement;
  dragDirection?: DesktopPetDragDirection;
  dragMoved?: boolean;
  signature?: DesktopPetSignatureAction[];
  updatedAt: number;
}

export type DesktopPetStateListener = (state: DesktopPetState) => void;
export type DesktopPetSignatureRequestedListener = (signatureId?: string) => void;
