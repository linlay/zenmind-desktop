import type { KanbanIssue } from "./contracts/kanban";
import type { WorkPanelWorkspace } from "./contracts/agent-webclient-bridge";
import type { DesktopCopilotPageKey, DesktopCopilotPagePreference } from "./assistant-settings";
import type {
  WebappEntry,
  WebappOpenMode,
  WebappPublishInfo,
  WebappPublishState,
  WebappPublishStatus,
  WebappRuntimeState,
  WebappRuntimeStatus,
  WebsiteEntry
} from "./contracts/webs";
import type { SurfaceInteraction, SurfaceLevel, SurfaceRole } from "./surface-identity";

export const DESKTOP_ACTION_BRIDGE_HOST = "127.0.0.1";
export const DESKTOP_ACTION_BRIDGE_PORT = 11788;
export const DESKTOP_ACTION_BRIDGE_URL = `http://${DESKTOP_ACTION_BRIDGE_HOST}:${DESKTOP_ACTION_BRIDGE_PORT}`;

export type DesktopActionKind = "read" | "validate" | "preview" | "apply" | "execute";

export type DesktopActionConfirmationPolicy = "sensitive-read" | "none";

export type DesktopActionDefinition = {
  name: string;
  kind: DesktopActionKind;
  category: string;
  description: string;
  confirmation?: DesktopActionConfirmationPolicy;
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
    items: { type: "array", items: WEBSITE_ENTRY_OUTPUT_SCHEMA }
  }
} satisfies DesktopActionOutputSchema;

const WEBSITE_ITEM_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    item: WEBSITE_ENTRY_OUTPUT_SCHEMA
  }
} satisfies DesktopActionOutputSchema;

export interface DesktopPetStateResult {
  supported: boolean;
  enabled: boolean;
  appearanceId: string;
}

export interface DesktopPetAppearanceSummary {
  id: string;
  displayName: string;
  description: string;
}

export interface DesktopPetListResult {
  appearanceId: string;
  appearances: DesktopPetAppearanceSummary[];
}

export interface DesktopPetVisibilityResult {
  enabled: boolean;
}

export interface DesktopPetSetResult {
  appearanceId: string;
}

export interface DesktopWebsiteItemResult {
  item: WebsiteEntry;
}

export interface DesktopWebsiteRemoveResult {
  websiteId: string;
}

export interface DesktopKanbanIssueResult {
  issue: KanbanIssue;
}

export interface DesktopKanbanDeleteResult {
  deletedIssueId: string;
}

export interface DesktopWebActionSurfaceSummary {
  surfaceId: string;
  surfaceRole: SurfaceRole;
  surfaceLevel: SurfaceLevel;
  parentSurfaceId?: string;
  ownerChatId?: string;
  interaction: SurfaceInteraction;
  kind: "website" | "webapp" | "browser" | "service";
  label: string;
  url: string;
  route: string;
  open: boolean;
  active: boolean;
}

export interface DesktopWebActionTabSummary {
  tabId: string;
  title: string;
  currentUrl: string;
  faviconUrl?: string;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface DesktopWebActionStateResult {
  surface: DesktopWebActionSurfaceSummary | null;
  tabs: DesktopWebActionTabSummary[];
  activeTab: DesktopWebActionTabSummary | null;
}

export interface DesktopWebExportArtifactResult {
  surfaceId: string;
  format: "png" | "html" | "project" | "pdf";
  filePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DesktopWebNavigateResult extends DesktopWebActionStateResult {
  targetTabId: string;
  navigatedUrl: string;
}

export interface DesktopWebTargetTabResult extends DesktopWebActionStateResult {
  targetTabId: string;
}

export interface DesktopWebOpenTabResult extends DesktopWebActionStateResult {
  openedTabId: string;
}

export interface DesktopWebCloseTabResult extends DesktopWebActionStateResult {
  closedTabId: string;
  closedSurface: boolean;
}

export interface DesktopWorkPanelWorkspaceResult {
  workspace: WorkPanelWorkspace;
}

export interface DesktopWorkPanelCloseTabResult {
  closedItemId: string;
  workspace: WorkPanelWorkspace | null;
}

export interface DesktopWorkPanelCloseResult {
  workspaceId: string;
  closed: true;
}

export interface DesktopWebappRuntimeMutationResult {
  webappId: string;
  status: WebappRuntimeStatus;
}

export interface DesktopWebappOpenResult extends DesktopWebappRuntimeMutationResult {
  route: string;
}

export interface DesktopWebappPreferenceResult {
  webappId: string;
  label: string;
  openMode: WebappOpenMode;
}

export interface DesktopWebappInstallResult {
  webappId: string;
  operation: "installed" | "updated";
}

export interface DesktopWebappUninstallResult {
  webappId: string;
}

export interface DesktopWebappPublishResult {
  webappId: string;
  status: WebappPublishStatus;
  publicUrl: string;
}

export interface DesktopWebappUnpublishResult {
  webappId: string;
  status: WebappPublishStatus;
}

export type DesktopWebappSummary = Pick<WebappEntry, "id" | "label" | "version" | "target" | "openMode">;

export interface DesktopWebappRuntimeFailureDetails {
  webappId: string;
  operation: "start" | "stop" | "restart" | "open";
  item?: DesktopWebappSummary;
  state?: WebappRuntimeState;
}

export interface DesktopWebappPreferenceFailureDetails {
  webappId: string;
  item?: DesktopWebappSummary;
}

export interface DesktopWebappPublishFailureDetails {
  webappId: string;
  operation: "publish" | "unpublish";
  info: WebappPublishInfo;
  state: WebappPublishState;
}

export interface DesktopWebappInstallDiagnostic {
  stage: "archive" | "manifest" | "package" | "runtime" | "startup" | "install";
  code: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface DesktopWebappInstallFailureDetails {
  webappId?: string;
  operation: "install";
  executable?: string;
  selectedPath?: string;
  path?: string;
  installPath?: string;
  item?: DesktopWebappSummary;
  diagnostic?: DesktopWebappInstallDiagnostic;
}

export interface DesktopWebappInvalidResultDetails {
  webappId: string;
  operation: "start" | "stop" | "restart" | "open" | "update" | "install" | "uninstall" | "publish" | "unpublish";
  missingFields: string[];
}

export interface DesktopCopilotPreferenceResult {
  pageKey: DesktopCopilotPageKey;
  preference: DesktopCopilotPagePreference;
}

export const DESKTOP_ACTION_DEFINITIONS = [
  { name: "desktop.navigate.toRoute", kind: "execute", category: "navigation", description: "Navigate the Desktop shell to a route." },

  { name: "desktop.assistant.chat", kind: "execute", category: "assistant", description: "Send a general message to the Desktop helper agent. Args: { message }." },

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

  { name: "desktop.runtime.info", kind: "read", category: "runtime", description: "Read startup-cached Desktop product, version, and build metadata. Args: none. Returns: { productName, version, buildTime }." },
  { name: "desktop.runtime.diagnostics", kind: "read", category: "runtime", confirmation: "sensitive-read", description: "Read sensitive Desktop device, path, runtime, canonical SSO credential summary, and internal service diagnostics. Args: none; raw credentials are never returned." },

  { name: "desktop.theme.get", kind: "read", category: "theme", description: "Read the Desktop theme. Args: none. Returns: { themeMode, resolvedTheme }." },
  { name: "desktop.theme.set", kind: "execute", category: "theme", description: "Set and persist the Desktop theme. Args: { themeMode: light|dark|system }. Returns: { themeMode, resolvedTheme }." },

  { name: "desktop.locale.get", kind: "read", category: "locale", description: "Read the Desktop locale settings. Args: none. Returns LocaleSettings." },
  { name: "desktop.locale.set", kind: "execute", category: "locale", description: "Set and persist the Desktop locale, then broadcast the change. Args: { locale: zh-CN|en-US }. Returns LocaleSettings." },

  { name: "desktop.display", kind: "execute", category: "display", confirmation: "none", description: "Show a transient effect in the Desktop Main Window. Args: { kind: effect, effect: fireworks|snowfall|nationalDay, durationMs? }." },

  { name: "desktop.copilot.getPagePreferences", kind: "read", category: "copilot", description: "Read all Desktop Copilot page preferences and available agent options. Args: none." },
  { name: "desktop.copilot.setPagePreference", kind: "execute", category: "copilot", description: "Update one Desktop Copilot page preference without replacing other pages. Args: { pageKey, enabled?, agentKey? }; pageKey: controlCenter|market|help|agents|schedules|skills. Returns: { pageKey, preference }." },

  { name: "desktop.web.listSurfaces", kind: "read", category: "web", description: "List Desktop web surfaces." },
  { name: "desktop.web.getSurfaceState", kind: "read", category: "web", description: "Read one Desktop web surface and its complete tab state. Args: { surfaceId }." },
  { name: "desktop.web.interactElement", kind: "execute", category: "web", description: "Interact with an element in the current Desktop web page." },
  { name: "desktop.web.executeScript", kind: "execute", category: "web", description: "Execute a script in the current Desktop web page." },
  { name: "desktop.web.exportArtifact", kind: "execute", category: "web", description: "Export an artifact from the current root WebApp directly to Downloads. Args: { format: png|html|project|pdf }. Returns an absolute filePath; payload bytes never enter the agent context." },
  { name: "desktop.web.activateSurface", kind: "execute", category: "web", description: "Activate a Desktop web surface." },
  { name: "desktop.web.navigate", kind: "execute", category: "web", description: "Navigate a Desktop web tab to a URL. Returns the public surface/tabs/activeTab post-state plus { targetTabId, navigatedUrl }; Electron guest and webContents ids are never returned." },
  { name: "desktop.web.reload", kind: "execute", category: "web", description: "Reload a Desktop web tab. Returns the public surface/tabs/activeTab post-state plus { targetTabId }; Electron guest and webContents ids are never returned." },
  { name: "desktop.web.refreshSurface", kind: "execute", category: "web", description: "Reload every live tab in the current Desktop web surface in place. Args: { surfaceId }. Returns { surfaceId, refreshedTabIds, failedTabs, activeTabId }." },
  { name: "desktop.web.goBack", kind: "execute", category: "web", description: "Go back in a Desktop web tab. Returns the public surface/tabs/activeTab post-state plus { targetTabId }; Electron guest and webContents ids are never returned." },
  { name: "desktop.web.openTab", kind: "execute", category: "web", description: "Open a new Desktop web tab. Returns the public surface/tabs/activeTab post-state plus { openedTabId }; the opened tab is represented once in tabs/activeTab." },
  { name: "desktop.web.closeTab", kind: "execute", category: "web", description: "Close a Desktop web tab through the shared tab transaction. Args: { surfaceId, tabId }. Returns the public surface/tabs/activeTab post-state plus { closedTabId, closedSurface }; surface and activeTab are null after closing the final tab." },
  { name: "desktop.web.switchTab", kind: "execute", category: "web", description: "Switch the active Desktop web tab. Returns the public surface/tabs/activeTab post-state without a duplicate activeTabId." },
  { name: "desktop.workpanel.getState", kind: "read", category: "workpanel", description: "Read the trusted source chat WorkPanel state." },
  { name: "desktop.workpanel.openTab", kind: "execute", category: "workpanel", description: "Open or activate a canonical WorkPanel tab for the trusted source chat. Args: { descriptor }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.openWeb", kind: "execute", category: "workpanel", description: "Open or activate an HTTP(S) WebView item for the trusted source chat. Args: { url }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.openLocalFile", kind: "execute", category: "workpanel", description: "Open, reload, or activate a workspace-relative local file for the trusted source Chat. Available only to an authorized internal Agent Platform Run. Args: { path, title? }. Returns: { workspace }; absolute paths are never returned." },
  { name: "desktop.workpanel.refreshWeb", kind: "execute", category: "workpanel", description: "Reload and activate an existing HTTP(S) WebView item for the trusted source chat. Args: { url }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.activateTab", kind: "execute", category: "workpanel", description: "Activate a WorkPanel tab for the trusted source chat. Args: { tabId }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.closeTab", kind: "execute", category: "workpanel", description: "Close a closable WorkPanel tab for the trusted source chat. Args: { tabId }. Returns: { closedItemId, workspace }; workspace is null if it was destroyed." },
  { name: "desktop.workpanel.closeWorkpanel", kind: "execute", category: "workpanel", description: "Close the trusted source chat WorkPanel. Returns: { workspaceId, closed: true }." },
  { name: "desktop.site.list", kind: "read", category: "web", description: "List Desktop website entries and webapps." },
  { name: "desktop.website.list", kind: "read", category: "web", description: "List Desktop website entries.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.add", kind: "execute", category: "web", description: "Add one Desktop website entry. Args: { input: { label, url, copilotAgentKey? } } or top-level label/url; url is required. Do not send items/name-only batches. Returns: { item }.", outputSchema: WEBSITE_ITEM_OUTPUT_SCHEMA },
  { name: "desktop.website.update", kind: "execute", category: "web", description: "Update one Desktop website entry. Args: id or websiteId plus { input|patch: { label?, url?, copilotAgentKey? } }. Returns: { item }.", outputSchema: WEBSITE_ITEM_OUTPUT_SCHEMA },
  { name: "desktop.website.remove", kind: "execute", category: "web", description: "Remove one Desktop website entry. Returns: { websiteId }." },
  { name: "desktop.website.open", kind: "execute", category: "web", description: "Open one Desktop website entry. Args: { websiteId|id }." },
  { name: "desktop.webapp.getStatus", kind: "read", category: "web", description: "Read a local webapp runtime status." },
  { name: "desktop.webapp.checkRuntime", kind: "validate", category: "web", description: "Check whether a local WebApp can run without starting it. Args: { webappId|id }." },
  { name: "desktop.webapp.start", kind: "execute", category: "web", description: "Start a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.stop", kind: "execute", category: "web", description: "Stop a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.restart", kind: "execute", category: "web", description: "Restart a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.open", kind: "execute", category: "web", description: "Start and open a local webapp. Returns: { webappId, status, route }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.updatePreferences", kind: "execute", category: "web", description: "Update a local WebApp label or Desktop open-mode preference. Args: { webappId|id, patch: { label?, openMode? } }. Returns: { webappId, label, openMode }." },
  { name: "desktop.webapp.install", kind: "execute", category: "web", description: "Install or update a local WebApp archive without starting or opening it. Args: { archivePath, expectedId? }. Returns: { webappId, operation }. Failures include sanitized stage, diagnostic, executable, and directly related path details." },
  { name: "desktop.webapp.uninstall", kind: "execute", category: "web", description: "Unpublish, stop, and remove one local WebApp installation and its managed data. Args: { webappId|id }. Returns: { webappId }." },
  { name: "desktop.webapp.getPublishStatus", kind: "read", category: "web", description: "Read one local WebApp's Tunnel publishing readiness, state, and public URL. Args: { webappId|id }." },
  { name: "desktop.webapp.publish", kind: "execute", category: "web", description: "Publish a running local WebApp gateway through the configured Tunnel. Args: { webappId|id }. Returns: { webappId, status, publicUrl }. Failures include this WebApp's publish info/state only." },
  { name: "desktop.webapp.unpublish", kind: "execute", category: "web", description: "Stop publishing a local webapp through Tunnel. Args: { webappId|id }. Returns: { webappId, status }. Failures include this WebApp's publish info/state only." },

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
  { name: "desktop.kanban.getIssue", kind: "read", category: "kanban", description: "Read one Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.createIssue", kind: "execute", category: "kanban", description: "Create a Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.updateIssue", kind: "execute", category: "kanban", description: "Update a Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.deleteIssue", kind: "execute", category: "kanban", description: "Delete a Desktop Kanban issue. Returns: { deletedIssueId }." },
  { name: "desktop.kanban.moveIssue", kind: "execute", category: "kanban", description: "Move a Desktop Kanban issue. Returns: { issue }." },

  { name: "desktop.pet.state", kind: "read", category: "pet", description: "Read Desktop pet control state. Returns: { supported, enabled, appearanceId }." },
  { name: "desktop.pet.show", kind: "execute", category: "pet", description: "Show the Desktop pet. Returns: { enabled }." },
  { name: "desktop.pet.hide", kind: "execute", category: "pet", description: "Hide the Desktop pet. Returns: { enabled }." },
  { name: "desktop.pet.list", kind: "read", category: "pet", description: "List local Desktop pet appearance summaries. Returns: { appearanceId, appearances: [{ id, displayName, description }] }." },
  { name: "desktop.pet.set", kind: "execute", category: "pet", description: "Set the Desktop pet appearance. Returns: { appearanceId }." }
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
  teamId?: string;
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
