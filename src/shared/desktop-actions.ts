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

// When Desktop asks the user before running an action:
// - none: never asks.
// - external: asks only external entries (Desktop WebSocket, local HTTP, Desktop's own UI);
//   the internal entry, a built-in Agent Platform Run, runs it directly.
// - always: asks every entry, the internal one included.
// Read actions default to none; write actions must declare it.
export type DesktopActionConfirmation = "none" | "external" | "always";

type DesktopActionDefinitionBase = {
  name: string;
  category: string;
  description: string;
  outputSchema?: DesktopActionOutputSchema;
};

export type DesktopActionDefinition = DesktopActionDefinitionBase & (
  | { kind: "read" | "validate" | "preview"; confirmation?: DesktopActionConfirmation }
  | { kind: "apply" | "execute"; confirmation: DesktopActionConfirmation }
);

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

export interface DesktopPetImportActionResult {
  appearanceId: string;
  displayName: string;
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

export interface DesktopSitePinResult {
  entryKey: string;
  pinned: boolean;
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

export type DesktopWebappToolingResult = {
  id: string;
  key: string;
  projectPath?: string;
  manifestPath?: string;
  archivePath?: string;
  outputPath?: string;
  fileCount?: number;
  entryCount?: number;
  totalBytes?: number;
  sourceBytes?: number;
  archiveBytes?: number;
  expandedBytes?: number;
  sha256?: string;
};

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
  { name: "desktop.navigate.toRoute", kind: "execute", category: "navigation", confirmation: "external", description: "Navigate the Desktop shell to a route." },

  { name: "desktop.assistant.chat", kind: "execute", category: "assistant", confirmation: "external", description: "Send a general message to the Desktop helper agent. Args: { message }." },

  { name: "desktop.general.deviceName", kind: "read", category: "general", description: "Read the effective and configured Desktop device names. Args: none. Returns: { deviceName, configuredDeviceName }." },

  { name: "desktop.runtime.info", kind: "read", category: "runtime", description: "Read startup-cached Desktop product, version, and build metadata. Args: none. Returns: { productName, version, buildTime }." },
  { name: "desktop.runtime.diagnostics", kind: "read", category: "runtime", confirmation: "external", description: "Read sensitive Desktop device, path, runtime, canonical SSO credential summary, and internal service diagnostics. Args: none; raw credentials are never returned." },

  { name: "desktop.theme.get", kind: "read", category: "theme", description: "Read the Desktop theme. Args: none. Returns: { themeMode, resolvedTheme }." },
  { name: "desktop.theme.set", kind: "execute", category: "theme", confirmation: "external", description: "Set and persist the Desktop theme. Args: { themeMode: light|dark|system }. Returns: { themeMode, resolvedTheme }." },

  { name: "desktop.skin.get", kind: "read", category: "skin", description: "Read selected and effective Desktop skin and custom background availability. Args: none. Returns: { skinId, activeSkinId, available, customBackground: { configured, available } }." },
  { name: "desktop.skin.list", kind: "read", category: "skin", description: "List built-in and installed skin summaries without image bytes or paths. Args: none. Returns: { skins: [{ skinId, name, source, version?, available }] }." },
  { name: "desktop.skin.import", kind: "execute", category: "skin", confirmation: "external", description: "Import a skin ZIP from an absolute local Desktop-host filePath. Args: { filePath }. Does not apply or replace existing packages. Returns: { skinId, name, source, version, available }." },
  { name: "desktop.skin.set", kind: "execute", category: "skin", confirmation: "external", description: "Apply a Desktop skin. Args: { skinId, keepBackground?: boolean }. Installed skins clear custom background unless keepBackground is true. Returns selected/effective skin and background state." },
  { name: "desktop.skin.remove", kind: "execute", category: "skin", confirmation: "external", description: "Remove an installed skin; built-in skins cannot be removed. The active skin falls back to default. Args: { skinId }. Returns: { skinId, activeSkinId }." },

  { name: "desktop.locale.get", kind: "read", category: "locale", description: "Read the Desktop locale settings. Args: none. Returns LocaleSettings." },
  { name: "desktop.locale.set", kind: "execute", category: "locale", confirmation: "external", description: "Set and persist the Desktop locale, then broadcast the change. Args: { locale: zh-CN|en-US }. Returns LocaleSettings." },

  { name: "desktop.display", kind: "execute", category: "display", confirmation: "none", description: "Show a transient effect in the Desktop Main Window. Args: { kind: effect, effect: fireworks|snowfall|nationalDay, durationMs? }." },

  { name: "desktop.copilot.getPagePreferences", kind: "read", category: "copilot", description: "Read all Desktop Copilot page preferences and available agent options. Args: none." },
  { name: "desktop.copilot.setPagePreference", kind: "execute", category: "copilot", confirmation: "external", description: "Update one Desktop Copilot page preference without replacing other pages. Args: { pageKey, enabled?, agentKey? }; pageKey: controlCenter|market|help|agents|schedules|skills. Returns: { pageKey, preference }." },

  { name: "desktop.web.listSurfaces", kind: "read", category: "web", description: "List live webpage Surfaces within the trusted Chat/Run scope. Each page has a surfaceId and containerId." },
  { name: "desktop.web.getSurfaceState", kind: "read", category: "web", description: "Read one authorized webpage. Args: { surfaceId }. Returns { surface }." },
  { name: "desktop.web.interactElement", kind: "execute", category: "web", confirmation: "external", description: "Interact with an authorized webpage element. Args: { surfaceId, selector, action, value? }." },
  { name: "desktop.web.executeScript", kind: "execute", category: "web", confirmation: "external", description: "Execute JavaScript in an authorized webpage. Args: { surfaceId, script }." },
  { name: "desktop.web.exportArtifact", kind: "execute", category: "web", confirmation: "external", description: "Export an artifact from an authorized WebApp Surface directly to Downloads. Args: { surfaceId, format: png|html|project|pdf }. Returns an absolute filePath; payload bytes never enter the agent context." },
  { name: "desktop.web.activateSurface", kind: "execute", category: "web", confirmation: "external", description: "Show an authorized webpage. Args: { surfaceId }." },
  { name: "desktop.web.navigate", kind: "execute", category: "web", confirmation: "external", description: "Navigate one authorized webpage. Args: { surfaceId, url }." },
  { name: "desktop.web.reload", kind: "execute", category: "web", confirmation: "external", description: "Reload one authorized webpage in place. Args: { surfaceId }." },
  { name: "desktop.web.refreshSurface", kind: "execute", category: "web", confirmation: "external", description: "Reload one authorized webpage in place, preserving its Surface identity. Args: { surfaceId }." },
  { name: "desktop.web.goBack", kind: "execute", category: "web", confirmation: "external", description: "Navigate one authorized webpage back. Args: { surfaceId }." },
  { name: "desktop.web.openTab", kind: "execute", category: "web", confirmation: "external", description: "Open a webpage alongside the selected Surface in its owning Container. Args: { surfaceId, url }. Returns the new surfaceId. WebApp is single-page." },
  { name: "desktop.web.closeTab", kind: "execute", category: "web", confirmation: "external", description: "Close one authorized webpage through its host lifecycle. Args: { surfaceId }. Returns { success }." },
  { name: "desktop.web.switchTab", kind: "execute", category: "web", confirmation: "external", description: "Select the exact authorized webpage. Args: { surfaceId }." },
  { name: "desktop.workpanel.getState", kind: "read", category: "workpanel", description: "Read the trusted source chat WorkPanel state." },
  { name: "desktop.workpanel.openTab", kind: "execute", category: "workpanel", confirmation: "external", description: "Open or activate a canonical WorkPanel tab for the trusted source chat. Args: { descriptor }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.openWeb", kind: "execute", category: "workpanel", confirmation: "external", description: "Open or activate an HTTP(S) webpage in the trusted Chat WorkPanel. Default for ordinary Chat requests to open a URL. Args: { url }. Returns { workspace, surfaceId, containerId, status }." },
  { name: "desktop.workpanel.openLocalFile", kind: "execute", category: "workpanel", confirmation: "none", description: "Open, reload, or activate a file of the trusted source Chat, addressed relative to its root. Available only to an authorized internal Agent Platform Run. Args: { root?, path, title?, artifactId? }; artifactId is the manifest id of a published chat-root artifact; root is \"workspace\" (default, the Agent project, local preview) or \"chat\" (the Chat directory, no project required: native preview for HTML and images, WebClient resource page otherwise). Returns: { workspace }; absolute paths are never returned." },
  { name: "desktop.workpanel.refreshWeb", kind: "execute", category: "workpanel", confirmation: "external", description: "Reload and activate an existing HTTP(S) WebView item for the trusted source chat. Args: { url }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.activateTab", kind: "execute", category: "workpanel", confirmation: "external", description: "Activate a WorkPanel tab for the trusted source chat. Args: { tabId }. Returns: { workspace }, containing only that chat's complete workspace." },
  { name: "desktop.workpanel.closeTab", kind: "execute", category: "workpanel", confirmation: "external", description: "Close a closable WorkPanel tab for the trusted source chat. Args: { tabId }. Returns: { closedItemId, workspace }; workspace is null if it was destroyed." },
  { name: "desktop.workpanel.closeWorkpanel", kind: "execute", category: "workpanel", confirmation: "external", description: "Close the trusted source chat WorkPanel. Returns: { workspaceId, closed: true }." },
  { name: "desktop.site.list", kind: "read", category: "web", description: "List Desktop website entries and installed WebApps, including each entry's id, entryKey, label and pinned state." },
  { name: "desktop.site.setPinned", kind: "execute", category: "web", confirmation: "external", description: "Pin or unpin an existing Website or WebApp in Desktop navigation. Args: { entryKey, pinned: boolean }. Use the exact entryKey from site.list. Returns: { entryKey, pinned }." },
  // fill always asks, showing the page's real site and the masked account.
  { name: "desktop.credentials.list", kind: "read", category: "credentials", description: "List the saved accounts a trusted Run may use on one authorized webpage. Args: { surfaceId }. Returns { origin, accounts: [{ accountId, username (masked), isDefault }] }. Never returns a password." },
  { name: "desktop.credentials.fill", kind: "execute", category: "credentials", confirmation: "always", description: "Have Desktop fill a saved login into one authorized webpage. Args: { surfaceId, accountId?, submit? }. Returns a status only; the password never enters the result." },
  { name: "desktop.website.list", kind: "read", category: "web", description: "List Desktop website entries.", outputSchema: WEBSITE_ITEMS_OUTPUT_SCHEMA },
  { name: "desktop.website.add", kind: "execute", category: "web", confirmation: "external", description: "Add one Desktop website entry. Args: { input: { label, url, copilotAgentKey? } } or top-level label/url; url is required. Do not send items/name-only batches. Returns: { item }.", outputSchema: WEBSITE_ITEM_OUTPUT_SCHEMA },
  { name: "desktop.website.update", kind: "execute", category: "web", confirmation: "external", description: "Update one Desktop website entry. Args: id or websiteId plus { input|patch: { label?, url?, copilotAgentKey? } }. Returns: { item }.", outputSchema: WEBSITE_ITEM_OUTPUT_SCHEMA },
  { name: "desktop.website.remove", kind: "execute", category: "web", confirmation: "external", description: "Remove one Desktop website entry. Returns: { websiteId }." },
  { name: "desktop.website.open", kind: "execute", category: "web", confirmation: "external", description: "Open one Desktop website entry. Args: { websiteId|id }." },
  { name: "desktop.webapp.getStatus", kind: "read", category: "web", description: "Read a local webapp runtime status." },
  { name: "desktop.webapp.checkRuntime", kind: "validate", category: "web", description: "Check whether a local WebApp can run without starting it. Args: { webappId|id }." },
  { name: "desktop.webapp.start", kind: "execute", category: "web", confirmation: "external", description: "Start a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.stop", kind: "execute", category: "web", confirmation: "external", description: "Stop a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.restart", kind: "execute", category: "web", confirmation: "external", description: "Restart a local webapp. Returns: { webappId, status }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.open", kind: "execute", category: "web", confirmation: "external", description: "Start and open a local webapp. Returns: { webappId, status, route }. Failures include detailed diagnostics for this WebApp only." },
  { name: "desktop.webapp.updatePreferences", kind: "execute", category: "web", confirmation: "external", description: "Update a local WebApp label or Desktop open-mode preference. Args: { webappId|id, patch: { label?, openMode? } }. Returns: { webappId, label, openMode }." },
  { name: "desktop.webapp.package.init", kind: "execute", category: "web", confirmation: "none", description: "Initialize a Manifest v2 WebApp inside the trusted source Run workspace. Agent Platform only. Args: { projectPath, key, label, target? }; projectPath is workspace-relative." },
  { name: "desktop.webapp.package.validate", kind: "validate", category: "web", description: "Validate a WebApp directory or ZIP inside the trusted source Run workspace. Agent Platform only. Args: exactly one of { projectPath } or { archivePath }; paths are workspace-relative." },
  { name: "desktop.webapp.package.build", kind: "execute", category: "web", confirmation: "none", description: "Build and validate a new WebApp ZIP inside the trusted source Run workspace. Agent Platform only. Args: { projectPath, outputPath }; both paths are workspace-relative and existing output is never overwritten." },
  { name: "desktop.webapp.install", kind: "execute", category: "web", confirmation: "always", description: "Install or update one local WebApp ZIP without starting or opening it. Args: { archivePath, expectedId? }. archivePath accepts a Desktop-host absolute path or an Agent Platform Run Workspace-relative path; Platform resolves @chat/@workspace aliases. External absolute paths are install-only. Omit expectedId when unknown. Validates the ZIP before confirmation. Returns: { webappId, operation }." },
  { name: "desktop.webapp.uninstall", kind: "execute", category: "web", confirmation: "always", description: "Unpublish, stop, and remove one local WebApp installation and its managed data. Args: { webappId|id }. Returns: { webappId }." },
  { name: "desktop.webapp.getPublishStatus", kind: "read", category: "web", description: "Read one local WebApp's Tunnel publishing readiness, state, and public URL. Args: { webappId|id }." },
  { name: "desktop.webapp.publish", kind: "execute", category: "web", confirmation: "always", description: "Publish a running local WebApp gateway through the configured Tunnel. Args: { webappId|id }. Returns: { webappId, status, publicUrl }. Failures include this WebApp's publish info/state only." },
  { name: "desktop.webapp.unpublish", kind: "execute", category: "web", confirmation: "external", description: "Stop publishing a local webapp through Tunnel. Args: { webappId|id }. Returns: { webappId, status }. Failures include this WebApp's publish info/state only." },

  { name: "desktop.controlCenter.listServices", kind: "read", category: "controlCenter", description: "List Desktop services." },
  { name: "desktop.controlCenter.openService", kind: "execute", category: "controlCenter", confirmation: "external", description: "Open Control Center and select one service. Args: { serviceId|id }." },
  { name: "desktop.controlCenter.getServiceStatus", kind: "read", category: "controlCenter", description: "Read one service status." },
  { name: "desktop.controlCenter.getServiceDetail", kind: "read", category: "controlCenter", description: "Read one service detail." },
  { name: "desktop.controlCenter.getServiceLogsMeta", kind: "read", category: "controlCenter", description: "Read service log metadata." },
  { name: "desktop.controlCenter.readServiceLog", kind: "read", category: "controlCenter", description: "Read service log content." },
  { name: "desktop.controlCenter.openLogViewer", kind: "execute", category: "controlCenter", confirmation: "external", description: "Open Desktop log viewer." },
  { name: "desktop.controlCenter.installService", kind: "execute", category: "controlCenter", confirmation: "always", description: "Install a builtin service from bundled assets." },
  { name: "desktop.controlCenter.initializeService", kind: "execute", category: "controlCenter", confirmation: "always", description: "Initialize a service." },
  { name: "desktop.controlCenter.startService", kind: "execute", category: "controlCenter", confirmation: "always", description: "Start a service." },
  { name: "desktop.controlCenter.stopService", kind: "execute", category: "controlCenter", confirmation: "always", description: "Stop a service." },
  { name: "desktop.controlCenter.restartService", kind: "execute", category: "controlCenter", confirmation: "always", description: "Restart a service." },

  { name: "desktop.market.getSettings", kind: "read", category: "market", description: "Read market settings." },
  { name: "desktop.market.validateSettings", kind: "validate", category: "market", description: "Validate market settings." },
  { name: "desktop.market.previewSettingsPatch", kind: "preview", category: "market", description: "Preview market settings changes." },
  { name: "desktop.market.applySettingsPatch", kind: "apply", category: "market", confirmation: "always", description: "Apply market settings changes." },
  { name: "desktop.market.listItems", kind: "read", category: "market", description: "List market items." },
  { name: "desktop.market.refresh", kind: "execute", category: "market", confirmation: "external", description: "Refresh market catalog." },
  { name: "desktop.market.getItemDetail", kind: "read", category: "market", description: "Read one market item." },
  { name: "desktop.market.installItem", kind: "execute", category: "market", confirmation: "always", description: "Install a market item." },
  { name: "desktop.market.updateItem", kind: "execute", category: "market", confirmation: "always", description: "Update a market item." },
  { name: "desktop.market.uninstallItem", kind: "execute", category: "market", confirmation: "always", description: "Uninstall a market item." },
  { name: "desktop.market.openItem", kind: "execute", category: "market", confirmation: "external", description: "Open one item in Desktop Market. Args: { itemId|id }." },
  { name: "desktop.market.importSkill", kind: "execute", category: "market", confirmation: "always", description: "Open local skill import flow." },
  { name: "desktop.market.importSandboxImage", kind: "execute", category: "market", confirmation: "always", description: "Open local sandbox image archive import flow." },
  { name: "desktop.market.exportSandboxImage", kind: "execute", category: "market", confirmation: "always", description: "Export a local sandbox image to a Docker or Podman archive." },
  { name: "desktop.market.deleteSandboxImage", kind: "execute", category: "market", confirmation: "always", description: "Delete a local sandbox image from Docker or Podman." },

  { name: "desktop.help.openTopic", kind: "execute", category: "help", confirmation: "external", description: "Open a help topic." },

  { name: "desktop.agent.open", kind: "execute", category: "agent", confirmation: "external", description: "Open an agent in the Desktop agent client. Args: { agentKey|id }." },
  { name: "desktop.agent.update", kind: "execute", category: "agent", confirmation: "external", description: "Update an agent definition or prompts in agent-platform. Args: { agentKey, definition?, soulPrompt?, agentsPrompt? }." },
  { name: "desktop.skill.open", kind: "execute", category: "skill", confirmation: "external", description: "Open a skill in the Desktop skill manager. Args: { id }." },
  { name: "desktop.skill.update", kind: "execute", category: "skill", confirmation: "external", description: "Update one editable text file in an agent-platform skill. Args: { id, path?, content, baseSha256? }." },

  { name: "desktop.kanban.listIssues", kind: "read", category: "kanban", description: "List Desktop Kanban issues." },
  { name: "desktop.kanban.getIssue", kind: "read", category: "kanban", description: "Read one Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.createIssue", kind: "execute", category: "kanban", confirmation: "external", description: "Create a Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.updateIssue", kind: "execute", category: "kanban", confirmation: "external", description: "Update a Desktop Kanban issue. Returns: { issue }." },
  { name: "desktop.kanban.deleteIssue", kind: "execute", category: "kanban", confirmation: "external", description: "Delete a Desktop Kanban issue. Returns: { deletedIssueId }." },
  { name: "desktop.kanban.moveIssue", kind: "execute", category: "kanban", confirmation: "external", description: "Move a Desktop Kanban issue. Returns: { issue }." },

  { name: "desktop.pet.state", kind: "read", category: "pet", description: "Read Desktop pet control state. Returns: { supported, enabled, appearanceId }." },
  { name: "desktop.pet.show", kind: "execute", category: "pet", confirmation: "external", description: "Show the Desktop pet. Returns: { enabled }." },
  { name: "desktop.pet.hide", kind: "execute", category: "pet", confirmation: "external", description: "Hide the Desktop pet. Returns: { enabled }." },
  { name: "desktop.pet.list", kind: "read", category: "pet", description: "List local Desktop pet appearance summaries. Returns: { appearanceId, appearances: [{ id, displayName, description }] }." },
  { name: "desktop.pet.import", kind: "execute", category: "pet", confirmation: "external", description: "Import a pet ZIP from an absolute local Desktop-host filePath. Args: { filePath }. Installs only; does not select or show the pet or replace existing packages. Returns: { appearanceId, displayName }." },
  { name: "desktop.pet.set", kind: "execute", category: "pet", confirmation: "external", description: "Set the Desktop pet appearance. Returns: { appearanceId }." }
] as const satisfies readonly DesktopActionDefinition[];

export type DesktopActionName = typeof DESKTOP_ACTION_DEFINITIONS[number]["name"];

export const DESKTOP_ACTION_NAMES = DESKTOP_ACTION_DEFINITIONS.map((definition) => definition.name);

export function getDesktopActionDefinition(action: string): DesktopActionDefinition | null {
  return DESKTOP_ACTION_DEFINITIONS.find((definition) => definition.name === action) ?? null;
}

export function isDesktopActionName(action: string): action is DesktopActionName {
  return Boolean(getDesktopActionDefinition(action));
}

export function getDesktopActionConfirmation(definition: DesktopActionDefinition): DesktopActionConfirmation {
  return definition.confirmation ?? "none";
}

export interface DesktopActionSource {
  runId?: string;
  chatId?: string;
  agentKey?: string;
  workspaceRoot?: string;
  webappId?: string;
}

export interface DesktopActionCallRequest {
  requestId?: string;
  action: string;
  args?: Record<string, unknown>;
  source?: DesktopActionSource;
  permissionMode?: "default" | "full_access";
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
