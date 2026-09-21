import {
  DEFAULT_OFFSET,
  DESKTOP_PET_VISIBLE_FOOTPRINT,
  DESKTOP_PET_WINDOW_VISIBLE_FOOTPRINTS,
  DESKTOP_PET_WINDOW_SIZES,
  DESKTOP_PET_PANEL_WINDOW_INSET_PX,
  DESKTOP_PET_EDGE_SNAP_DISTANCE_PX
} from "./pet-window-metrics";
import { DEFAULT_DESKTOP_PET_ID, DESKTOP_PET_CONFIG_FILE, DESKTOP_PET_STATE_FILE } from "./pet-model";
import { DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY, normalizeDesktopPetAppearanceId, sanitizeDesktopPetUnreadCount } from "../../../shared/desktop-pet";
import {
  getDesktopPetVisibleFootprintForMode,
  resolveDesktopPetDisplayArea,
  resolveDesktopPetEdgeDock,
  resolveDesktopPetPanelLayout,
  resolveDesktopPetPanelWindowBounds,
  getAnchoredDesktopPetBounds,
  resolveDesktopPetWindowLayout,
  getDesktopPetLogicalPositionFromBounds
} from "./pet-window-layout";
import { sanitizeDesktopPetStoredState, selectedPetIdForAppearance } from "./pet-settings";
import {
  sanitizeUserPetDirectoryName,
  sanitizeDesktopPetAssetRelativePath,
  userPetAssetBaseUrl,
  userPetAssetUrl,
  normalizeUserDesktopPetId,
  listUserDesktopPets,
  listUserDesktopPetAppearanceOptions
} from "./pet-assets";
import { sanitizeDesktopPetMessagePreview } from "./pet-status-values";
import { resolveMergedDesktopPetStatus } from "./pet-state";
import { getDesktopPetRoot, getDesktopPetStatePath } from "./pet-paths";

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
  resolveDesktopPetWindowLayout,
  getDesktopPetLogicalPositionFromBounds,
  getDesktopPetRoot,
  getDesktopPetStatePath,
  listUserDesktopPets,
  listUserDesktopPetAppearanceOptions
};
