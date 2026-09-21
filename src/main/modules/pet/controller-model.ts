import type { DesktopPetWindowMode } from "./desktop-pet";
import type { DesktopPetWindowLayout } from "./pet-window-layout";
import type { DesktopPetDragDirection } from "../../../shared/contracts";

export type DesktopPetPreviewPanelLike = {
  status?: string;
  chatId?: string | null;
  runId?: string;
};

export type DesktopPetAgentStatusLike = {
  presence: string;
  chatId?: string | null;
  latestPreview?: string;
  unreadCount?: number;
};

export type DesktopPetCompletionEventLike = {
  type?: string | null;
  chatId?: string | null;
  runId?: string | null;
};

export type DesktopPetDismissedPreview = {
  chatId: string;
  runId: string;
};

export interface DesktopPetSettingsLike {
  enabled: boolean;
  unreadCount: number;
  boundAgentKey: string;
  appearanceId: string;
  position?: { x: number; y: number };
}

export type DesktopPetWindowModeStateLike = {
  status?: string;
  hint?: unknown;
  messagePreview?: unknown;
  unreadCount?: unknown;
  activeTasks?: unknown;
  messages?: unknown;
};

export type DesktopPetNavigationSnapshotLike = {
  ok?: unknown;
  items?: unknown;
  activityItems?: unknown;
};

export type DesktopPetBoundsLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export interface DesktopPetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  windowLeftInset?: number;
}

export interface BrowserWindowLike {
  isDestroyed(): boolean;
  getBounds(): DesktopPetBounds;
  setBounds(bounds: DesktopPetBounds, animate?: boolean): void;
  moveTop(): void;
}

export interface DesktopPetDragControllerOptions {
  platform: string;
  getWindow: () => BrowserWindowLike | null;
  getSettings: () => { position?: { x: number; y: number } };
  saveSettings: (settings: { position: { x: number; y: number } }) => void;
  getMode: () => DesktopPetWindowMode;
  getCursorScreenPoint: () => { x: number; y: number };
  getDisplayBounds: (position?: { x: number; y: number }) => DesktopPetBounds;
  getPointDisplayBounds: (point: { x: number; y: number }) => DesktopPetBounds;
  persistPosition: (mode: DesktopPetWindowMode) => void;
  guardProgrammaticBounds?: (bounds: DesktopPetBounds) => void;
  onLayoutChanged?: (layout: import("./desktop-pet").DesktopPetWindowLayout) => void;
  refreshState: () => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  forceEndMs?: number;
}

export interface DesktopPetDragController {
  isDragging(): boolean;
  getDragDirection(): DesktopPetDragDirection;
  hasDragMovement(): boolean;
  beginDrag(point: { x?: unknown; y?: unknown }): { ok: boolean };
  endDrag(): { ok: boolean; moved: boolean };
  moveWindowBy(delta: { x?: unknown; y?: unknown }): { ok: boolean };
  stickToEdge(mode?: DesktopPetWindowMode): { position: { x: number; y: number }; bounds: DesktopPetBounds } | null;
  prepareWindowForDrag(mode: DesktopPetWindowMode): void;
  clearTimer(): void;
}
