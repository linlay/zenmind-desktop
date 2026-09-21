export * from "./pet-model";
export * from "./pet-window-metrics";
export * from "./pet-paths";
export * from "./pet-state";
export * from "./pet-status-values";
export * from "./pet-settings";
export * from "./pet-assets";
export * from "./pet-window-layout";
export * from "./pet-test-internals";
export {
  DEFAULT_DESKTOP_PET_APPEARANCE_ID,
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  DEFAULT_DESKTOP_PET_SELECTED_ID,
  DESKTOP_PET_APPEARANCE_OPTIONS,
  applyDesktopPetActiveRunEvent,
  normalizeDesktopPetAppearanceId,
  normalizeDesktopPetBoundAgentKey,
  resolveDesktopPetRunningTaskCount
} from "../../../shared/desktop-pet";
export type { DesktopPetWindowMode } from "../../../shared/contracts";
