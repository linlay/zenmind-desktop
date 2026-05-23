import type { AssistantAwaitingMode } from "./copilot";

export type DesktopPetStatus = "idle" | "running" | "awaiting" | "done" | "error";
export type DesktopPetAgentPresence = "available" | "busy" | "away" | "offline";

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
  previewAssetPath: string;
}

export interface DesktopPetAgentOption {
  agentKey: string;
  displayName: string;
  role: string;
  unreadCount: number;
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
  createdAt: string;
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
  updatedAt: string;
}

export interface DesktopPetState {
  supported: boolean;
  enabled: boolean;
  visible: boolean;
  status: DesktopPetStatus;
  hint: string;
  messagePreview: string;
  unreadCount: number;
  chatId: string | null;
  appearanceId: string;
  appearanceOptions: DesktopPetAppearanceOption[];
  boundAgentKey: string;
  agentDisplayName: string;
  agentRole: string;
  agentPresence: DesktopPetAgentPresence;
  agentStatusStale: boolean;
  agentOptions: DesktopPetAgentOption[];
  previewPanel: DesktopPetPreviewPanel | null;
  runningTaskCount: number;
  updatedAt: string;
}

export type DesktopPetStateListener = (state: DesktopPetState) => void;
export type DesktopPetDanceRequestedListener = () => void;
