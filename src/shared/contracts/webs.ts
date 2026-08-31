import type { ServiceLogReadOptions, ServiceLogReadResult } from "./services";
import type {
  WebappBackendConfig,
  WebappCopilotConfig,
  WebappDesktopBridgeConfig,
  WebappFrontendConfig,
  WebappManifest,
  WebappUserConfig,
  WebappUserConfigValues
} from "../webapp-manifest";

export type WebKind = "website" | "webapp";
export type WebEntryKey = `website:${string}` | `webapp:${string}`;
export type WebappRuntimeStatus = "stopped" | "starting" | "running" | "blocked" | "error";
export type WebappLogTarget = "main" | "error";
export type WebappSourceKind = "market" | "local" | "plugin";
export type WebappOpenMode = "workspace" | "dialog";
export type WebappLauncherKind = "none" | "electron-node" | "executable" | "runtime";
export type WebappBackendOwnership = "desktop";
export type WebappTarget = WebappManifest["target"];
export interface WebappRuntimeSettings {
  schemaVersion: 1;
  runtimeExecutables: Record<string, string>;
}

export interface WebappRuntimeSettingsInput {
  runtimeExecutables?: Record<string, string>;
}

export interface WebappRuntimeSettingsResult {
  ok: boolean;
  settings: WebappRuntimeSettings;
  message: string;
}

export type WebappHealthConfig = NonNullable<WebappBackendConfig>["health"];
export type WebappHttpHealthConfig = Extract<WebappHealthConfig, { type: "http" }>;
export type WebappTcpHealthConfig = Extract<WebappHealthConfig, { type: "tcp" }>;

export interface WebEntryBase {
  id: string;
  entryKey: WebEntryKey;
  label: string;
  kind: WebKind;
  copilotAgentKey?: string;
  copilotMustUseSkills?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WebsiteEntry extends WebEntryBase {
  kind: "website";
  entryKey: `website:${string}`;
  url: string;
}

export interface WebappEntry extends WebEntryBase {
  kind: "webapp";
  entryKey: `webapp:${string}`;
  schemaVersion: WebappManifest["schemaVersion"];
  key: WebappManifest["key"];
  version: WebappManifest["version"];
  target: WebappTarget;
  openMode: WebappOpenMode;
  appConfig: WebappManifest["appConfig"];
  userConfig?: WebappUserConfig;
  frontend: WebappFrontendConfig;
  backend?: WebappBackendConfig;
  desktopBridge?: WebappDesktopBridgeConfig;
  copilot?: WebappCopilotConfig;
  sourceKind?: WebappSourceKind;
  sourceLabel?: string;
  sourceOwnerId?: string;
  installPath?: string;
  removable?: boolean;
}

export type WebEntry = WebsiteEntry | WebappEntry;

export interface WebappPrerequisiteIssue {
  code: string;
  message: string;
  required?: string;
  detected?: string;
}

export interface WebappRuntimeState {
  id: string;
  entryKey: `webapp:${string}`;
  kind: "webapp";
  status: WebappRuntimeStatus;
  version: string;
  target: WebappTarget;
  launcher: WebappLauncherKind;
  ownership: WebappBackendOwnership | null;
  runtimeVersion: string;
  externalId: string;
  prerequisiteIssues: WebappPrerequisiteIssue[];
  webUrl: string;
  backendUrl: string;
  frontendPort: number | null;
  backendPort: number | null;
  pid: number | null;
  message: string;
  startedAt?: string;
  updatedAt: string;
}

export interface WebListResult {
  ok: boolean;
  items: WebEntry[];
  webappPublishStates: Record<string, WebappPublishState | null>;
  message: string;
}

export interface WebsChangedEvent {
  changedAt: string;
  phase?: "changed" | "disposing";
  webappId?: string;
  reason?: DesktopWebappChangedReason;
}

export type WebsChangedListener = (event: WebsChangedEvent) => void;

export interface WebsiteInput {
  id?: string;
  label?: string;
  url: string;
  copilotAgentKey?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface WebsiteUpdateInput {
  label?: string;
  url?: string;
  copilotAgentKey?: string;
}

export interface WebsiteInputIssue {
  field: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface WebsiteItemsResult {
  ok: boolean;
  items: WebsiteEntry[];
  message: string;
}

export interface WebsiteResult {
  ok: boolean;
  item: WebsiteEntry | null;
  items: WebsiteEntry[];
  message: string;
  issues?: WebsiteInputIssue[];
}

export interface WebsiteDeleteResult {
  ok: boolean;
  items: WebsiteEntry[];
  message: string;
}

export interface WebsiteFaviconCacheInput {
  id: string;
  websiteUrl: string;
  faviconUrl: string;
}

export interface WebsiteFaviconCacheResult {
  ok: boolean;
  faviconUrl: string;
  message: string;
}

export interface WebsiteTransferResult {
  ok: boolean;
  items: WebsiteEntry[];
  path: string;
  message: string;
}

export interface WebappUpdateInput {
  label?: string;
  openMode?: WebappOpenMode;
}

export interface WebappUserConfigIssue {
  field: string;
  message: string;
}

export interface WebappUserConfigResult {
  ok: boolean;
  values: WebappUserConfigValues;
  message: string;
  issues?: WebappUserConfigIssue[];
}

export interface WebappItemsResult {
  ok: boolean;
  items: WebappEntry[];
  message: string;
}

export interface WebappResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebappEntry[];
  message: string;
}

export interface WebappImportResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebEntry[];
  path: string;
  message: string;
  installPath?: string;
  diagnostic?: {
    stage: "archive" | "manifest" | "package" | "runtime" | "startup" | "install";
    code: string;
    message: string;
    suggestion?: string;
    details?: Record<string, unknown>;
  };
}

export interface WebappExportResult {
  ok: boolean;
  item: WebappEntry | null;
  path: string;
  message: string;
}

export interface WebappDeleteResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebappEntry[];
  message: string;
}

export interface WebappStatusResult {
  ok: boolean;
  state: WebappRuntimeState | null;
  message: string;
}

export interface WebappRuntimeCheckResult {
  ready: boolean;
  launcher: WebappLauncherKind;
  ownership: WebappBackendOwnership | null;
  runtimeVersion: string;
  externalId: string;
  backendUrl: string;
  backendPort: number | null;
  issues: WebappPrerequisiteIssue[];
  message: string;
}

export interface WebappCommandResult {
  ok: boolean;
  item: WebappEntry | null;
  state: WebappRuntimeState | null;
  message: string;
}

export type WebappPublishProvider = "tunnel";
export type WebappPublishStatus = "not-configured" | "ready" | "publishing" | "published" | "unpublished" | "error";

export interface WebappPublishInfo {
  provider: WebappPublishProvider;
  configured: boolean;
  signedIn: boolean;
  tunnelEnabled: boolean;
  tunnelConnected: boolean;
  deviceId: string;
  relayUrl: string;
}

export interface WebappPublishState {
  id: string;
  provider: WebappPublishProvider;
  status: WebappPublishStatus;
  name: string;
  routeId: string;
  publicHost: string;
  url: string;
  targetUrl: string;
  active: boolean;
  message: string;
  updatedAt: string;
}

export interface WebappPublishStatusResult {
  ready: boolean;
  info: WebappPublishInfo;
  state: WebappPublishState | null;
  message: string;
}

export interface WebappPublishResult {
  ok: boolean;
  info: WebappPublishInfo;
  state: WebappPublishState;
  message: string;
}

export type DesktopMobileWebappAvailability =
  | "available"
  | "not-published"
  | "publishing"
  | "desktop-offline"
  | "webapp-stopped"
  | "publish-error";

export interface DesktopMobileWebappItem {
  id: string;
  label: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  runtimeStatus: WebappRuntimeStatus;
  publishStatus: WebappPublishStatus;
  available: boolean;
  publicUrl: string;
  availability: DesktopMobileWebappAvailability;
}

export interface DesktopMobileWebappCatalog {
  desktopDeviceId: string;
  tunnelConnected: boolean;
  generatedAt: string;
  items: DesktopMobileWebappItem[];
}

export type DesktopWebappChangedReason =
  | "installed"
  | "updated"
  | "published"
  | "unpublished"
  | "removed"
  | "route-synced"
  | "publish-failed";

export interface DesktopWebappChangedEvent {
  reason: DesktopWebappChangedReason;
  webappId: string;
  changedAt: string;
  item: DesktopMobileWebappItem | null;
}

export interface WebappLogReadResult extends ServiceLogReadResult {}
export interface WebappLogReadOptions extends ServiceLogReadOptions {}
