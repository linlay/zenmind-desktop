export const DESKTOP_ACTION_BRIDGE_HOST = "127.0.0.1";
export const DESKTOP_ACTION_BRIDGE_PORT = 11788;
export const DESKTOP_ACTION_BRIDGE_URL = `http://${DESKTOP_ACTION_BRIDGE_HOST}:${DESKTOP_ACTION_BRIDGE_PORT}`;

export type DesktopActionKind = "read" | "validate" | "preview" | "apply" | "execute";

export type DesktopActionDefinition = {
  name: string;
  kind: DesktopActionKind;
  category: string;
  description: string;
};

export const DESKTOP_ACTION_DEFINITIONS = [
  { name: "desktop.navigate.toRoute", kind: "execute", category: "navigation", description: "Navigate the Desktop shell to a route." },

  { name: "desktop.settings.getState", kind: "read", category: "settings", description: "Read Desktop settings state." },
  { name: "desktop.settings.validatePatch", kind: "validate", category: "settings", description: "Validate a Desktop settings patch." },
  { name: "desktop.settings.previewPatch", kind: "preview", category: "settings", description: "Preview Desktop settings changes." },
  { name: "desktop.settings.applyPatch", kind: "apply", category: "settings", description: "Apply Desktop settings changes." },

  { name: "desktop.web.listSurfaces", kind: "read", category: "web", description: "List Desktop web surfaces." },
  { name: "desktop.web.getActiveSurface", kind: "read", category: "web", description: "Read the active Desktop web surface." },
  { name: "desktop.web.activateSurface", kind: "execute", category: "web", description: "Activate a Desktop web surface." },
  { name: "desktop.web.getPageContext", kind: "read", category: "web", description: "Read Desktop web page context." },
  { name: "desktop.web.readPageData", kind: "read", category: "web", description: "Read structured page data from a Desktop web surface." },
  { name: "desktop.web.extractStructured", kind: "read", category: "web", description: "Extract structured content from a Desktop web surface." },
  { name: "desktop.web.interactElement", kind: "execute", category: "web", description: "Interact with an element inside a Desktop web surface." },
  { name: "desktop.web.executeScript", kind: "execute", category: "web", description: "Execute JavaScript inside a Desktop web surface." },
  { name: "desktop.web.navigate", kind: "execute", category: "web", description: "Navigate a Desktop web tab to a URL." },
  { name: "desktop.web.reload", kind: "execute", category: "web", description: "Reload a Desktop web tab." },
  { name: "desktop.web.goBack", kind: "execute", category: "web", description: "Go back in a Desktop web tab." },
  { name: "desktop.web.openTab", kind: "execute", category: "web", description: "Open a new Desktop web tab." },
  { name: "desktop.web.closeTab", kind: "execute", category: "web", description: "Close a Desktop web tab." },
  { name: "desktop.web.switchTab", kind: "execute", category: "web", description: "Switch the active Desktop web tab." },
  { name: "desktop.web.list", kind: "read", category: "web", description: "List Desktop website entries and webapps." },
  { name: "desktop.web.websites.list", kind: "read", category: "web", description: "List Desktop website entries." },
  { name: "desktop.web.websites.add", kind: "execute", category: "web", description: "Add a Desktop website entry." },
  { name: "desktop.web.websites.update", kind: "execute", category: "web", description: "Update a Desktop website entry." },
  { name: "desktop.web.websites.remove", kind: "execute", category: "web", description: "Remove a Desktop website entry." },
  { name: "desktop.web.webapps.getStatus", kind: "read", category: "web", description: "Read a local webapp runtime status." },
  { name: "desktop.web.webapps.start", kind: "execute", category: "web", description: "Start a local webapp." },
  { name: "desktop.web.webapps.stop", kind: "execute", category: "web", description: "Stop a local webapp." },
  { name: "desktop.web.webapps.restart", kind: "execute", category: "web", description: "Restart a local webapp." },
  { name: "desktop.web.webapps.open", kind: "execute", category: "web", description: "Start and open a local webapp." },
  { name: "desktop.web.webapps.installAndOpen", kind: "execute", category: "web", description: "Install and open a website app." },

  { name: "desktop.tunnelHub.getSettings", kind: "read", category: "tunnelHub", description: "Read Desktop Tunnel Hub settings." },
  { name: "desktop.tunnelHub.validateSettings", kind: "validate", category: "tunnelHub", description: "Validate Desktop Tunnel Hub settings." },
  { name: "desktop.tunnelHub.applySettings", kind: "apply", category: "tunnelHub", description: "Apply Desktop Tunnel Hub settings." },
  { name: "desktop.tunnelHub.getStatus", kind: "read", category: "tunnelHub", description: "Read Desktop Tunnel Hub status." },
  { name: "desktop.tunnelHub.start", kind: "execute", category: "tunnelHub", description: "Start Desktop Tunnel Hub." },
  { name: "desktop.tunnelHub.stop", kind: "execute", category: "tunnelHub", description: "Stop Desktop Tunnel Hub." },
  { name: "desktop.tunnelHub.restart", kind: "execute", category: "tunnelHub", description: "Restart Desktop Tunnel Hub." },
  { name: "desktop.tunnelHub.readLog", kind: "read", category: "tunnelHub", description: "Read Desktop Tunnel Hub logs." },

  { name: "desktop.controlCenter.listServices", kind: "read", category: "controlCenter", description: "List Desktop services." },
  { name: "desktop.controlCenter.getServiceStatus", kind: "read", category: "controlCenter", description: "Read one service status." },
  { name: "desktop.controlCenter.getServiceDetail", kind: "read", category: "controlCenter", description: "Read one service detail." },
  { name: "desktop.controlCenter.getServiceLogsMeta", kind: "read", category: "controlCenter", description: "Read service log metadata." },
  { name: "desktop.controlCenter.readServiceLog", kind: "read", category: "controlCenter", description: "Read service log content." },
  { name: "desktop.controlCenter.openLogViewer", kind: "execute", category: "controlCenter", description: "Open Desktop log viewer." },
  { name: "desktop.controlCenter.installService", kind: "execute", category: "controlCenter", description: "Install a builtin service from bundled assets." },
  { name: "desktop.controlCenter.initializeService", kind: "execute", category: "controlCenter", description: "Initialize a service." },
  { name: "desktop.controlCenter.startService", kind: "execute", category: "controlCenter", description: "Start a service." },
  { name: "desktop.controlCenter.stopService", kind: "execute", category: "controlCenter", description: "Stop a service." },
  { name: "desktop.controlCenter.restartService", kind: "execute", category: "controlCenter", description: "Restart a service." },

  { name: "desktop.staticServer.list", kind: "read", category: "staticServer", description: "List Desktop-managed static servers." },
  { name: "desktop.staticServer.start", kind: "execute", category: "staticServer", description: "Start a Desktop-managed static server." },
  { name: "desktop.staticServer.stop", kind: "execute", category: "staticServer", description: "Stop a Desktop-managed static server." },
  { name: "desktop.staticServer.restart", kind: "execute", category: "staticServer", description: "Restart a Desktop-managed static server." },

  { name: "desktop.market.getSettings", kind: "read", category: "market", description: "Read market settings." },
  { name: "desktop.market.validateSettings", kind: "validate", category: "market", description: "Validate market settings." },
  { name: "desktop.market.previewSettingsPatch", kind: "preview", category: "market", description: "Preview market settings changes." },
  { name: "desktop.market.applySettingsPatch", kind: "apply", category: "market", description: "Apply market settings changes." },
  { name: "desktop.market.listItems", kind: "read", category: "market", description: "List market items." },
  { name: "desktop.market.refresh", kind: "execute", category: "market", description: "Refresh market catalog." },
  { name: "desktop.market.getItemDetail", kind: "read", category: "market", description: "Read one market item." },
  { name: "desktop.market.installItem", kind: "execute", category: "market", description: "Install a market item." },
  { name: "desktop.market.updateItem", kind: "execute", category: "market", description: "Update a market item." },
  { name: "desktop.market.uninstallItem", kind: "execute", category: "market", description: "Uninstall a market item." },
  { name: "desktop.market.importSkill", kind: "execute", category: "market", description: "Open local skill import flow." },
  { name: "desktop.market.importSandboxImage", kind: "execute", category: "market", description: "Open local sandbox image archive import flow." },
  { name: "desktop.market.exportSandboxImage", kind: "execute", category: "market", description: "Export a local sandbox image to a Docker or Podman archive." },
  { name: "desktop.market.deleteSandboxImage", kind: "execute", category: "market", description: "Delete a local sandbox image from Docker or Podman." },

  { name: "desktop.help.getCurrentTopic", kind: "read", category: "help", description: "Read current help topic." },
  { name: "desktop.help.searchTopics", kind: "read", category: "help", description: "Search help topics." },
  { name: "desktop.help.openTopic", kind: "execute", category: "help", description: "Open a help topic." },
  { name: "desktop.help.explainCurrentPage", kind: "read", category: "help", description: "Explain current Desktop page." },
  { name: "desktop.help.suggestNextAction", kind: "read", category: "help", description: "Suggest next Desktop action." },
  { name: "desktop.help.navigateToRelatedPage", kind: "execute", category: "help", description: "Navigate to a related Desktop page." },

  { name: "desktop.pet.getState", kind: "read", category: "pet", description: "Read Desktop pet state." },
  { name: "desktop.pet.getSettings", kind: "read", category: "pet", description: "Read Desktop pet settings." },
  { name: "desktop.pet.show", kind: "execute", category: "pet", description: "Show the Desktop pet." },
  { name: "desktop.pet.hide", kind: "execute", category: "pet", description: "Hide the Desktop pet." },
  { name: "desktop.pet.setEnabled", kind: "execute", category: "pet", description: "Enable or disable the Desktop pet." },
  { name: "desktop.pet.listAppearances", kind: "read", category: "pet", description: "List Desktop pet appearances." },
  { name: "desktop.pet.setAppearance", kind: "execute", category: "pet", description: "Set the Desktop pet appearance." },

  { name: "desktop.agents.listAgents", kind: "read", category: "agents", description: "List agent-platform agents." },
  { name: "desktop.agents.getAgentDetail", kind: "read", category: "agents", description: "Read one agent detail." },
  { name: "desktop.agents.validateAgentConfig", kind: "validate", category: "agents", description: "Validate an agent config payload." },
  { name: "desktop.agents.previewAgentConfigPatch", kind: "preview", category: "agents", description: "Preview an agent config patch." },
  { name: "desktop.agents.applyAgentConfigPatch", kind: "apply", category: "agents", description: "Apply an agent config patch." },
  { name: "desktop.agents.createAgentDraft", kind: "preview", category: "agents", description: "Create an agent draft payload." },
  { name: "desktop.agents.createAgent", kind: "execute", category: "agents", description: "Create an agent." },
  { name: "desktop.agents.updateAgent", kind: "execute", category: "agents", description: "Update an agent." },
  { name: "desktop.agents.deleteAgent", kind: "execute", category: "agents", description: "Delete an agent." },
  { name: "desktop.agents.cloneAgent", kind: "execute", category: "agents", description: "Clone an agent." },
  { name: "desktop.agents.disableAgent", kind: "execute", category: "agents", description: "Disable an agent." },
  { name: "desktop.agents.reloadAgents", kind: "execute", category: "agents", description: "Reload agents." },

  { name: "desktop.automations.listAutomations", kind: "read", category: "automations", description: "List automations." },
  { name: "desktop.automations.getAutomationDetail", kind: "read", category: "automations", description: "Read one automation." },
  { name: "desktop.automations.validateAutomation", kind: "validate", category: "automations", description: "Validate an automation payload." },
  { name: "desktop.automations.previewAutomation", kind: "preview", category: "automations", description: "Preview an automation payload." },
  { name: "desktop.automations.createAutomation", kind: "execute", category: "automations", description: "Create an automation." },
  { name: "desktop.automations.updateAutomation", kind: "execute", category: "automations", description: "Update an automation." },
  { name: "desktop.automations.pauseAutomation", kind: "execute", category: "automations", description: "Pause an automation." },
  { name: "desktop.automations.resumeAutomation", kind: "execute", category: "automations", description: "Resume an automation." },
  { name: "desktop.automations.deleteAutomation", kind: "execute", category: "automations", description: "Delete an automation." },
  { name: "desktop.automations.explainNextRun", kind: "read", category: "automations", description: "Explain the next schedule run." }
] as const satisfies readonly DesktopActionDefinition[];

export type DesktopActionName = typeof DESKTOP_ACTION_DEFINITIONS[number]["name"];

export const DESKTOP_ACTION_NAMES = DESKTOP_ACTION_DEFINITIONS.map((definition) => definition.name);

export function getDesktopActionDefinition(action: string) {
  return DESKTOP_ACTION_DEFINITIONS.find((definition) => definition.name === action) ?? null;
}

export function isDesktopActionName(action: string): action is DesktopActionName {
  return Boolean(getDesktopActionDefinition(action));
}

export function isDesktopActionMutating(action: string) {
  const definition = getDesktopActionDefinition(action);
  return definition?.kind === "apply" || definition?.kind === "execute";
}

export interface DesktopActionSource {
  runId?: string;
  chatId?: string;
  agentKey?: string;
}

export interface DesktopActionCallRequest {
  requestId?: string;
  action: string;
  args?: Record<string, unknown>;
  source?: DesktopActionSource;
  permissionMode?: "default" | "page_control" | "full_access";
  expectedPageKey?: string;
}

export interface DesktopActionError {
  code: string;
  message: string;
  details?: unknown;
}

export interface DesktopActionCallResponse {
  ok: boolean;
  action: string;
  result?: unknown;
  preview?: unknown;
  requiresConfirmation?: boolean;
  error?: DesktopActionError;
}
