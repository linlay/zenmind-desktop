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

  { name: "desktop.assistant.chat", kind: "execute", category: "assistant", description: "Send a general message to the Desktop helper agent. Args: { message }." },
  { name: "desktop.assistant.complete", kind: "execute", category: "assistant", description: "Generate text with the Desktop helper agent. Args: { prompt, instruction? }." },

  { name: "desktop.capabilities.list", kind: "read", category: "capabilities", description: "List the capabilities exposed to the calling local WebApp page." },

  { name: "desktop.native.browser.openExternal", kind: "execute", category: "native", description: "Open an HTTP(S) URL in the system browser. Args: { url }." },
  { name: "desktop.native.dialog.selectFiles", kind: "execute", category: "native", description: "Open a native file picker. Args: { multiple?, filters? }." },
  { name: "desktop.native.dialog.selectDirectory", kind: "execute", category: "native", description: "Open a native directory picker for the calling local WebApp." },
  { name: "desktop.native.dialog.selectSavePath", kind: "execute", category: "native", description: "Select a native save path without writing a file. Args: { suggestedName?, filters? }." },
  { name: "desktop.native.microphone.getPermission", kind: "read", category: "native", description: "Read the operating-system microphone permission state for the calling local WebApp." },
  { name: "desktop.native.microphone.requestAccess", kind: "execute", category: "native", description: "Request operating-system microphone access for the calling local WebApp." },
  { name: "desktop.native.clipboard.writeText", kind: "execute", category: "native", description: "Write up to 1 MiB of text to the system clipboard. Args: { text }." },
  { name: "desktop.native.notification.show", kind: "execute", category: "native", description: "Show a rate-limited system notification for the calling local WebApp. Args: { title, body? }." },

  { name: "desktop.general.deviceName", kind: "read", category: "general", description: "Read the effective and configured Desktop device names. Args: none. Returns: { deviceName, configuredDeviceName }." },

  { name: "desktop.theme.get", kind: "read", category: "theme", description: "Read the Desktop theme. Args: none. Returns: { themeMode, resolvedTheme }." },
  { name: "desktop.theme.set", kind: "execute", category: "theme", description: "Set and persist the Desktop theme. Args: { themeMode: light|dark|system }. Returns: { themeMode, resolvedTheme }." },

  { name: "desktop.locale.get", kind: "read", category: "locale", description: "Read the Desktop locale settings. Args: none. Returns LocaleSettings." },
  { name: "desktop.locale.set", kind: "execute", category: "locale", description: "Set and persist the Desktop locale, then broadcast the change. Args: { locale: zh-CN|en-US }. Returns LocaleSettings." },

  { name: "desktop.copilot.getPagePreferences", kind: "read", category: "copilot", description: "Read all Desktop Copilot page preferences and available agent options. Args: none." },
  { name: "desktop.copilot.setPagePreference", kind: "execute", category: "copilot", description: "Update one Desktop Copilot page preference without replacing other pages. Args: { pageKey, enabled?, agentKey? }; pageKey: controlCenter|market|help|agents|schedules|skills." },

  { name: "desktop.web.listSurfaces", kind: "read", category: "web", description: "List Desktop web surfaces." },
  { name: "desktop.web.getSurfaceState", kind: "read", category: "web", description: "Read one Desktop web surface and its complete tab state. Args: { surfaceId }." },
  { name: "desktop.web.interactElement", kind: "execute", category: "web", description: "Interact with an element in the current Desktop web page." },
  { name: "desktop.web.executeScript", kind: "execute", category: "web", description: "Execute a script in the current Desktop web page." },
  { name: "desktop.web.activateSurface", kind: "execute", category: "web", description: "Activate a Desktop web surface." },
  { name: "desktop.web.navigate", kind: "execute", category: "web", description: "Navigate a Desktop web tab to a URL." },
  { name: "desktop.web.reload", kind: "execute", category: "web", description: "Reload a Desktop web tab." },
  { name: "desktop.web.refreshSurface", kind: "execute", category: "web", description: "Reload every live tab in the current Desktop web surface in place. Args: { surfaceId }. Returns { surfaceId, refreshedTabIds, failedTabs, activeTabId }." },
  { name: "desktop.web.goBack", kind: "execute", category: "web", description: "Go back in a Desktop web tab." },
  { name: "desktop.web.openTab", kind: "execute", category: "web", description: "Open a new Desktop web tab." },
  { name: "desktop.web.closeTab", kind: "execute", category: "web", description: "Close a Desktop web tab through the shared tab transaction. Args: { surfaceId, tabId }. Returns { surfaceId, closedTabId, closedSurface, remainingTabIds, activeTabId }." },
  { name: "desktop.web.switchTab", kind: "execute", category: "web", description: "Switch the active Desktop web tab." },
  { name: "desktop.site.list", kind: "read", category: "web", description: "List Desktop website entries and webapps." },
  { name: "desktop.website.list", kind: "read", category: "web", description: "List Desktop website entries.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.add", kind: "execute", category: "web", description: "Add one Desktop website entry. Args: { input: { label, url, copilotAgentKey? } } or top-level label/url; url is required. Do not send items/name-only batches.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.update", kind: "execute", category: "web", description: "Update one Desktop website entry. Args: id or websiteId plus { input|patch: { label?, url?, copilotAgentKey? } }.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.remove", kind: "execute", category: "web", description: "Remove one Desktop website entry.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.open", kind: "execute", category: "web", description: "Open one Desktop website entry. Args: { websiteId|id }." },
  { name: "desktop.webapp.getStatus", kind: "read", category: "web", description: "Read a local webapp runtime status." },
  { name: "desktop.webapp.checkPrerequisites", kind: "validate", category: "web", description: "Check a local webapp's runtime prerequisites without starting it." },
  { name: "desktop.webapp.start", kind: "execute", category: "web", description: "Start a local webapp." },
  { name: "desktop.webapp.stop", kind: "execute", category: "web", description: "Stop a local webapp." },
  { name: "desktop.webapp.restart", kind: "execute", category: "web", description: "Restart a local webapp." },
  { name: "desktop.webapp.open", kind: "execute", category: "web", description: "Start and open a local webapp." },
  { name: "desktop.webapp.updatePreferences", kind: "execute", category: "web", description: "Update a local WebApp label, Copilot agent, or open mode. Args: { webappId|id, patch: { label?, copilotAgentKey?, openMode? } }." },
  { name: "desktop.webapp.installAndOpen", kind: "execute", category: "web", description: "Install and open a website app." },
  { name: "desktop.webapp.selectDirectory", kind: "execute", category: "web", description: "Open the native directory picker for a local WebApp. Args: none. Returns: { canceled, path?, name? }." },
  { name: "desktop.webapp.getPublishInfo", kind: "read", category: "web", description: "Read one local webapp's Tunnel publishing prerequisites, state, and public URL. Args: { webappId|id }." },
  { name: "desktop.webapp.publish", kind: "execute", category: "web", description: "Start a local webapp and publish or refresh its public URL through the configured Tunnel. Args: { webappId|id }." },
  { name: "desktop.webapp.unpublish", kind: "execute", category: "web", description: "Stop publishing a local webapp through Tunnel. Args: { webappId|id }." },

  { name: "desktop.controlCenter.listServices", kind: "read", category: "controlCenter", description: "List Desktop services." },
  { name: "desktop.controlCenter.openService", kind: "execute", category: "controlCenter", description: "Open Control Center and select one service. Args: { serviceId|id }." },
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
  { name: "desktop.market.openItem", kind: "execute", category: "market", description: "Open one item in Desktop Market. Args: { itemId|id }." },
  { name: "desktop.market.importSkill", kind: "execute", category: "market", description: "Open local skill import flow." },
  { name: "desktop.market.importSandboxImage", kind: "execute", category: "market", description: "Open local sandbox image archive import flow." },
  { name: "desktop.market.exportSandboxImage", kind: "execute", category: "market", description: "Export a local sandbox image to a Docker or Podman archive." },
  { name: "desktop.market.deleteSandboxImage", kind: "execute", category: "market", description: "Delete a local sandbox image from Docker or Podman." },

  { name: "desktop.help.openTopic", kind: "execute", category: "help", description: "Open a help topic." },

  { name: "desktop.agent.open", kind: "execute", category: "agent", description: "Open an agent in the Desktop agent client. Args: { agentKey|id }." },
  { name: "desktop.agent.update", kind: "execute", category: "agent", description: "Update an agent definition or prompts in agent-platform. Args: { agentKey, definition?, soulPrompt?, agentsPrompt? }." },
  { name: "desktop.skill.open", kind: "execute", category: "skill", description: "Open a skill in the Desktop skill manager. Args: { skillKey|id }." },
  { name: "desktop.skill.update", kind: "execute", category: "skill", description: "Update one editable text file in an agent-platform skill. Args: { skillKey|id, path?, content, baseSha256? }." },

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
  webappId?: string;
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
