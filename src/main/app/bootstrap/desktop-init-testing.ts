import { DESKTOP_INIT_FILE, DESKTOP_INIT_BOOTSTRAP_STATE_FILE, pathApiForRuntimeRoot } from "./desktop-init-state";
import {
  normalizeDesktopInitAssistantDefaults,
  applyProfileDefaults,
  applyKanbanDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyTunnelHubDefaults,
  applyDesktopActionBridgeDefaults,
  applyEnterpriseImDefaults,
  applyHelpDefaults,
  applyServiceDefaults
} from "./desktop-init-settings";
import { applyWebsiteDefaults } from "./desktop-init-sites";

export const __testInternals = {
  DESKTOP_INIT_FILE,
  DESKTOP_INIT_BOOTSTRAP_STATE_FILE,
  pathApiForRuntimeRoot,
  normalizeDesktopInitAssistantDefaults,
  applyProfileDefaults,
  applyKanbanDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyTunnelHubDefaults,
  applyWebsiteDefaults,
  applyDesktopActionBridgeDefaults,
  applyEnterpriseImDefaults,
  applyHelpDefaults,
  applyServiceDefaults
};
