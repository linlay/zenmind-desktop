import type { ServiceLogReadOptions, ServiceLogReadResult } from "./services";
import type { WebappDesktopBridgeConfig } from "../webapp-bridge";

export type WebKind = "website" | "webapp";
export type WebEntryKey = `website:${string}` | `webapp:${string}`;
export type WebappRuntimeStatus = "stopped" | "starting" | "running" | "blocked" | "error";
export type WebappLogTarget = "main" | "error";
export type WebappSourceKind = "market" | "local" | "plugin" | "bundled";
export type WebappOpenMode = "workspace" | "dialog";
export type WebappLauncherKind = "none" | "node" | "native" | "java" | "container";
export type WebappBackendOwnership = "desktop" | "external";
export type WebappTarget =
  | "universal"
  | "darwin-arm64"
  | "darwin-x64"
  | "windows-arm64"
  | "windows-x64";
export type WebappContainerEngine = "auto" | "docker" | "podman";

export interface WebappRuntimeSettings {
  schemaVersion: 1;
  javaExecutable: string;
  containerEngine: WebappContainerEngine;
}

export interface WebappRuntimeSettingsInput {
  javaExecutable?: string;
  containerEngine?: WebappContainerEngine;
}

export interface WebappRuntimeSettingsResult {
  ok: boolean;
  settings: WebappRuntimeSettings;
  message: string;
}

export interface WebappStaticFrontendConfig {
  mode: "static";
  root: string;
  index: string;
  spa: boolean;
  apiPrefix: string;
}

export interface WebappProxyFrontendConfig {
  mode: "proxy";
}

export type WebappFrontendConfig = WebappStaticFrontendConfig | WebappProxyFrontendConfig;

export interface WebappHttpHealthConfig {
  type: "http";
  path: string;
  timeoutMs: number;
}

export interface WebappTcpHealthConfig {
  type: "tcp";
  timeoutMs: number;
}

export type WebappHealthConfig = WebappHttpHealthConfig | WebappTcpHealthConfig;

export interface WebappManagedBackendBase {
  entry: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  health: WebappHealthConfig;
}

export interface WebappNodeBackendConfig extends WebappManagedBackendBase {
  launcher: "node";
  runtime: "node";
}

export interface WebappNativeBackendConfig extends WebappManagedBackendBase {
  launcher: "native";
}

export interface WebappJavaBackendConfig extends WebappManagedBackendBase {
  launcher: "java";
  jvmArgs: string[];
}

export interface WebappContainerBackendConfig {
  launcher: "container";
  management: "external";
  engine: WebappContainerEngine;
  containerName: string;
  image: string;
  containerPort: number;
  health: WebappHealthConfig;
}

export type WebappBackendConfig =
  | WebappNodeBackendConfig
  | WebappNativeBackendConfig
  | WebappJavaBackendConfig
  | WebappContainerBackendConfig;

export interface WebEntryBase {
  id: string;
  entryKey: WebEntryKey;
  label: string;
  kind: WebKind;
  copilotAgentKey?: string;
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
  schemaVersion: 2 | 3 | 4 | 5;
  version: string;
  target: WebappTarget;
  openMode: WebappOpenMode;
  frontend: WebappFrontendConfig;
  backend?: WebappBackendConfig;
  desktopBridge?: WebappDesktopBridgeConfig;
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
  message: string;
}

export interface WebsChangedEvent {
  changedAt: string;
  phase?: "changed" | "disposing";
  webappId?: string;
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
  copilotAgentKey?: string;
  openMode?: WebappOpenMode;
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
