import type { DesktopPetStatus, DesktopPetAgentPresence, DesktopPetDragDirection } from "../../../shared/contracts";
import type { Rectangle } from "electron";
import { normalizeDesktopPetAppearanceId, normalizeDesktopPetBoundAgentKey, DEFAULT_DESKTOP_PET_SELECTED_ID } from "../../../shared/desktop-pet";

export type Platform = NodeJS.Platform | string;

export type DesktopPetStoredState = {
  schemaVersion?: 1;
  enabled: boolean;
  unreadCount: number;
  boundAgentKey: string;
  appearanceId: string;
  selectedPetId?: string;
  position?: {
    x: number;
    y: number;
    displayId?: string;
  };
  window?: {
    edgeDock: "none" | "top";
    previewExpanded: boolean;
  };
};

export type DesktopPetReadOptions = {
  isFirstInstall?: boolean;
};

export type DesktopPetLocalStatus = {
  status: DesktopPetStatus;
  hint: string;
  unreadCount: number;
  chatId: string | null;
};

export type DesktopPetBoundAgentStatus = {
  agentKey: string;
  displayName: string;
  role: string;
  presence: DesktopPetAgentPresence;
  unreadCount: number;
  latestPreview: string;
  chatId: string | null;
  hasPendingAwaiting: boolean;
  stale: boolean;
  updatedAt?: number;
};

export type DisplayArea = Pick<Rectangle, "x" | "y" | "width" | "height"> & {
  windowLeftInset?: number;
};

export type DesktopPetDisplayBounds = {
  bounds?: DisplayArea;
  workArea: DisplayArea;
};

export type DesktopPetClampOptions = {
  allowVisibleEdgeDock?: boolean;
  stickToEdges?: boolean;
};

export type DesktopPetContextMenuItem =
  | {
      action: "signature";
      signatureId: string;
      label: string;
    }
  | {
      action: "hide";
      label: string;
    };

export type UserDesktopPetAsset = {
  id: string;
  petId: string;
  rootPath: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
};

export const sanitizeDesktopPetAppearanceId = normalizeDesktopPetAppearanceId;

export const sanitizeDesktopPetBoundAgentKey = normalizeDesktopPetBoundAgentKey;

export function normalizeDesktopPetDragDirection(value: unknown): DesktopPetDragDirection {
  return value === "left" || value === "right" ? value : null;
}

export const DESKTOP_PET_SCHEMA_VERSION = 1;

export const DEFAULT_DESKTOP_PET_ID = DEFAULT_DESKTOP_PET_SELECTED_ID;

export const DESKTOP_PET_CONFIG_FILE = "pet.json";

export const DESKTOP_PET_STATE_FILE = "pet-state.json";
