export const DESKTOP_ACTION_BRIDGE_HOST = "127.0.0.1";
export const DESKTOP_ACTION_BRIDGE_PORT = 11788;
export const DESKTOP_ACTION_BRIDGE_URL = `http://${DESKTOP_ACTION_BRIDGE_HOST}:${DESKTOP_ACTION_BRIDGE_PORT}`;

export type DesktopActionKind = "read" | "validate" | "preview" | "apply" | "execute";

export type DesktopActionDefinition = {
  name: string;
  kind: DesktopActionKind;
  category: string;
  description: string;
  outputSchema?: DesktopActionOutputSchema;
};

// The bridge uses this small JSON-Schema-shaped declaration only to locate
// explicitly declared time values. Names such as createdAt have no special
// meaning unless a schema opts in with x-platform-time or format: date-time.
export type DesktopActionOutputSchema = Record<string, unknown>;

const WEBSITE_ENTRY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    createdAt: { "x-platform-time": "epoch-ms" },
    updatedAt: { "x-platform-time": "epoch-ms" }
  }
} satisfies DesktopActionOutputSchema;

const WEBSITE_ITEMS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: WEBSITE_ENTRY_OUTPUT_SCHEMA },
    item: WEBSITE_ENTRY_OUTPUT_SCHEMA
  }
} satisfies DesktopActionOutputSchema;

const PET_STATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    updatedAt: { "x-platform-time": "epoch-ms" }
  }
} satisfies DesktopActionOutputSchema;

export const DESKTOP_ACTION_DEFINITIONS = [
  { name: "desktop.navigate.toRoute", kind: "execute", category: "navigation", description: "Navigate the Desktop shell to a route." },

  { name: "desktop.assistant.translate", kind: "execute", category: "assistant", description: "Translate text with the Desktop assistant model. Args: { text, targetLanguage: en|ja|zh }." },
  { name: "desktop.assistant.complete", kind: "execute", category: "assistant", description: "Generate text with the Desktop helper agent. Args: { prompt, instruction? }." },

  { name: "desktop.setting.getState", kind: "read", category: "setting", description: "Read Desktop setting state." },
  { name: "desktop.setting.validatePatch", kind: "validate", category: "setting", description: "Validate a Desktop setting patch." },
  { name: "desktop.setting.previewPatch", kind: "preview", category: "setting", description: "Preview Desktop setting changes." },
  { name: "desktop.setting.applyPatch", kind: "apply", category: "setting", description: "Apply Desktop setting changes." },

  { name: "desktop.web.listSurfaces", kind: "read", category: "web", description: "List Desktop web surfaces." },
  { name: "desktop.web.getActiveSurface", kind: "read", category: "web", description: "Read the active Desktop web surface." },
  { name: "desktop.web.getPageContext", kind: "read", category: "web", description: "Read the current Desktop web page context." },
  { name: "desktop.web.readPageData", kind: "read", category: "web", description: "Read structured content from the current Desktop web page." },
  { name: "desktop.web.extractStructured", kind: "read", category: "web", description: "Extract structured data from the current Desktop web page." },
  { name: "desktop.web.interactElement", kind: "execute", category: "web", description: "Interact with an element in the current Desktop web page." },
  { name: "desktop.web.executeScript", kind: "execute", category: "web", description: "Execute a script in the current Desktop web page." },
  { name: "desktop.web.activateSurface", kind: "execute", category: "web", description: "Activate a Desktop web surface." },
  { name: "desktop.web.navigate", kind: "execute", category: "web", description: "Navigate a Desktop web tab to a URL." },
  { name: "desktop.web.reload", kind: "execute", category: "web", description: "Reload a Desktop web tab." },
  { name: "desktop.web.goBack", kind: "execute", category: "web", description: "Go back in a Desktop web tab." },
  { name: "desktop.web.openTab", kind: "execute", category: "web", description: "Open a new Desktop web tab." },
  { name: "desktop.web.closeTab", kind: "execute", category: "web", description: "Close a Desktop web tab." },
  { name: "desktop.web.switchTab", kind: "execute", category: "web", description: "Switch the active Desktop web tab." },
  { name: "desktop.web.list", kind: "read", category: "web", description: "List Desktop website entries and webapps." },
  { name: "desktop.web.website.list", kind: "read", category: "web", description: "List Desktop website entries.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.web.website.add", kind: "execute", category: "web", description: "Add one Desktop website entry. Args: { input: { label, url, agentKey? } } or top-level label/url; url is required. Do not send items/name-only batches.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.web.website.update", kind: "execute", category: "web", description: "Update one Desktop website entry. Args: id or websiteId plus { input|patch: { label?, url?, agentKey? } }.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.web.website.remove", kind: "execute", category: "web", description: "Remove one Desktop website entry.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.web.webapp.getStatus", kind: "read", category: "web", description: "Read a local webapp runtime status." },
  { name: "desktop.web.webapp.start", kind: "execute", category: "web", description: "Start a local webapp." },
  { name: "desktop.web.webapp.stop", kind: "execute", category: "web", description: "Stop a local webapp." },
  { name: "desktop.web.webapp.restart", kind: "execute", category: "web", description: "Restart a local webapp." },
  { name: "desktop.web.webapp.open", kind: "execute", category: "web", description: "Start and open a local webapp." },
  { name: "desktop.web.webapps.installAndOpen", kind: "execute", category: "web", description: "Install and open a website app." },
  { name: "desktop.web.webapp.installAndOpen", kind: "execute", category: "web", description: "Install and open a website app." },

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
  { name: "desktop.market.importSandboxImage", kind: "execute", category: "market", description: "Open local sandbox image archive import flow." },
  { name: "desktop.market.exportSandboxImage", kind: "execute", category: "market", description: "Export a local sandbox image to a Docker or Podman archive." },
  { name: "desktop.market.deleteSandboxImage", kind: "execute", category: "market", description: "Delete a local sandbox image from Docker or Podman." },

  { name: "desktop.help.openTopic", kind: "execute", category: "help", description: "Open a help topic." },

  { name: "desktop.kanban.listIssues", kind: "read", category: "kanban", description: "List Desktop Kanban issues." },
  { name: "desktop.kanban.getIssue", kind: "read", category: "kanban", description: "Read one Desktop Kanban issue." },
  { name: "desktop.kanban.createIssue", kind: "execute", category: "kanban", description: "Create a Desktop Kanban issue." },
  { name: "desktop.kanban.updateIssue", kind: "execute", category: "kanban", description: "Update a Desktop Kanban issue." },
  { name: "desktop.kanban.deleteIssue", kind: "execute", category: "kanban", description: "Delete a Desktop Kanban issue." },
  { name: "desktop.kanban.moveIssue", kind: "execute", category: "kanban", description: "Move a Desktop Kanban issue." },

  { name: "desktop.pet.state", kind: "read", category: "pet", description: "Read Desktop pet state.", outputSchema: PET_STATE_OUTPUT_SCHEMA },
  { name: "desktop.pet.show", kind: "execute", category: "pet", description: "Show the Desktop pet.", outputSchema: PET_STATE_OUTPUT_SCHEMA },
  { name: "desktop.pet.hide", kind: "execute", category: "pet", description: "Hide the Desktop pet.", outputSchema: PET_STATE_OUTPUT_SCHEMA },
  { name: "desktop.pet.list", kind: "read", category: "pet", description: "List local Desktop pet appearances." },
  { name: "desktop.pet.set", kind: "execute", category: "pet", description: "Set the Desktop pet appearance.", outputSchema: PET_STATE_OUTPUT_SCHEMA }
] as const satisfies readonly DesktopActionDefinition[];

export type DesktopActionName = typeof DESKTOP_ACTION_DEFINITIONS[number]["name"];

export const DESKTOP_ACTION_NAMES = DESKTOP_ACTION_DEFINITIONS.map((definition) => definition.name);

export function getDesktopActionDefinition(action: string): DesktopActionDefinition | null {
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
