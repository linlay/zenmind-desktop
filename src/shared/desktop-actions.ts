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
  { name: "desktop.page.getContext", kind: "read", category: "page", description: "Read the current visible Desktop page context." },
  { name: "desktop.page.getFormState", kind: "read", category: "page", description: "Read the active page form state." },
  { name: "desktop.page.validateForm", kind: "validate", category: "page", description: "Validate the active page form." },
  { name: "desktop.page.previewPatch", kind: "preview", category: "page", description: "Preview a patch for the active page form." },
  { name: "desktop.page.applyPatch", kind: "apply", category: "page", description: "Apply a patch to the active page form." },
  { name: "desktop.navigate.toRoute", kind: "execute", category: "navigation", description: "Navigate the Desktop shell to a route." },

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

  { name: "desktop.help.getCurrentTopic", kind: "read", category: "help", description: "Read current help topic." },
  { name: "desktop.help.searchTopics", kind: "read", category: "help", description: "Search help topics." },
  { name: "desktop.help.openTopic", kind: "execute", category: "help", description: "Open a help topic." },
  { name: "desktop.help.explainCurrentPage", kind: "read", category: "help", description: "Explain current Desktop page." },
  { name: "desktop.help.suggestNextAction", kind: "read", category: "help", description: "Suggest next Desktop action." },
  { name: "desktop.help.navigateToRelatedPage", kind: "execute", category: "help", description: "Navigate to a related Desktop page." },

  { name: "desktop.agents.listAgents", kind: "read", category: "agents", description: "List agent-platform agents." },
  { name: "desktop.agents.getAgentDetail", kind: "read", category: "agents", description: "Read one agent detail." },
  { name: "desktop.agents.validateAgentConfig", kind: "validate", category: "agents", description: "Validate an agent config payload." },
  { name: "desktop.agents.previewAgentConfigPatch", kind: "preview", category: "agents", description: "Preview an agent config patch." },
  { name: "desktop.agents.applyAgentConfigPatch", kind: "apply", category: "agents", description: "Apply an agent config patch." },
  { name: "desktop.agents.createAgentDraft", kind: "preview", category: "agents", description: "Create an agent draft payload." },
  { name: "desktop.agents.createAgent", kind: "execute", category: "agents", description: "Create an agent." },
  { name: "desktop.agents.updateAgent", kind: "execute", category: "agents", description: "Update an agent." },
  { name: "desktop.agents.cloneAgent", kind: "execute", category: "agents", description: "Clone an agent." },
  { name: "desktop.agents.disableAgent", kind: "execute", category: "agents", description: "Disable an agent." },
  { name: "desktop.agents.reloadAgents", kind: "execute", category: "agents", description: "Reload agents." },

  { name: "desktop.automations.listSchedules", kind: "read", category: "automations", description: "List schedules." },
  { name: "desktop.automations.getScheduleDetail", kind: "read", category: "automations", description: "Read one schedule." },
  { name: "desktop.automations.validateSchedule", kind: "validate", category: "automations", description: "Validate a schedule payload." },
  { name: "desktop.automations.previewSchedule", kind: "preview", category: "automations", description: "Preview a schedule payload." },
  { name: "desktop.automations.createSchedule", kind: "execute", category: "automations", description: "Create a schedule." },
  { name: "desktop.automations.updateSchedule", kind: "execute", category: "automations", description: "Update a schedule." },
  { name: "desktop.automations.pauseSchedule", kind: "execute", category: "automations", description: "Pause a schedule." },
  { name: "desktop.automations.resumeSchedule", kind: "execute", category: "automations", description: "Resume a schedule." },
  { name: "desktop.automations.deleteSchedule", kind: "execute", category: "automations", description: "Delete a schedule." },
  { name: "desktop.automations.explainNextRun", kind: "read", category: "automations", description: "Explain the next schedule run." },

  { name: "desktop.memory.getSettings", kind: "read", category: "memory", description: "Read memory settings." },
  { name: "desktop.memory.getSummary", kind: "read", category: "memory", description: "Read memory summary." },
  { name: "desktop.memory.listRecentItems", kind: "read", category: "memory", description: "List recent memory items." },
  { name: "desktop.memory.searchItems", kind: "read", category: "memory", description: "Search memory items." },
  { name: "desktop.memory.previewItem", kind: "read", category: "memory", description: "Preview one memory item." },
  { name: "desktop.memory.enableAutoLearn", kind: "apply", category: "memory", description: "Enable memory auto learn." },
  { name: "desktop.memory.disableAutoLearn", kind: "apply", category: "memory", description: "Disable memory auto learn." }
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
