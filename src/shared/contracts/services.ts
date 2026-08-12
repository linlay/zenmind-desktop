import type {
  ManifestPluginSettingField,
  ManifestPluginSettings,
  ManifestPluginSettingValue,
  ManifestPluginSettingsUi
} from "./manifest";

export type ServiceId = string;
export type ServiceKind = "builtin" | "plugin";
export type FrontendMode = "none" | "embedded" | "standalone";
export type ServiceMode = "service" | "resource";
export type ServiceLogTarget = "main" | "error";
export type DesktopLogTarget = "main" | "error" | "kanban-ws";
export type LogViewerSource = "service" | "desktop";
export type ServiceStatus =
  | "not-installed"
  | "initialization-required"
  | "stopped"
  | "running"
  | "config-required"
  | "dependency-missing"
  | "error";

export interface ServiceConfigFile {
  key: string;
  label: string;
  relativePath: string;
  absolutePath: string;
  required: boolean;
  exists: boolean;
}

export interface ServiceHealthMeta {
  pid: number | null;
  pidFilePath: string;
  logFilePath: string;
  errorLogFilePath: string;
  webUrl: string;
  port: number | null;
  prerequisites: string[];
}

export interface ServicePaths {
  programDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
}

export interface ServiceState {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  serviceMode: ServiceMode;
  version: string;
  description: string;
  installDir: string;
  paths: ServicePaths;
  installed: boolean;
  status: ServiceStatus;
  statusLabel: string;
  message: string;
  frontendMode: FrontendMode;
  pluginActions: ServicePluginAction[];
  configFiles: ServiceConfigFile[];
  healthMeta: ServiceHealthMeta;
}

export interface ServicePluginAction {
  id: string;
  label: string;
  icon?: string;
  placement: "controlCenter";
  requiresRunning: boolean;
  globalShortcut?: {
    settingKey: string;
  };
}

export type PluginSettingValue = ManifestPluginSettingValue;
export type PluginSettingsValues = Record<string, PluginSettingValue>;

export interface PluginGlobalShortcutStatus {
  pluginId: ServiceId;
  actionId: string;
  settingKey: string;
  accelerator: string;
  enabled: boolean;
  reason?: "missing" | "conflict" | "invalid" | "registration-failed" | "settings-error";
  message?: string;
}

export interface PluginSettingsReadResult {
  ok: boolean;
  serviceId: ServiceId;
  settingsPath: string;
  schema: ManifestPluginSettings & {
    schemaVersion: number;
    fields: ManifestPluginSettingField[];
    ui: ManifestPluginSettingsUi;
  };
  values: PluginSettingsValues;
  defaults: PluginSettingsValues;
  shortcutStatuses: PluginGlobalShortcutStatus[];
}

export interface PluginSettingsWriteResult extends PluginSettingsReadResult {
  message: string;
  restartRequired: boolean;
  changedKeys: string[];
}

export interface PluginSettingsPageResult {
  ok: boolean;
  message: string;
  serviceId: ServiceId;
  url?: string;
}

export interface ServiceCommandResult {
  ok: boolean;
  message: string;
  service: ServiceState;
  verification?: ServiceVerification;
}

export type ServiceDesiredStatus = "running" | "stopped";

export interface ServiceVerificationProbe {
  target: string;
  ok: boolean;
  statusCode?: number;
  contentType?: string;
  message?: string;
}

export interface ServiceVerification {
  verified: boolean;
  desired: ServiceDesiredStatus;
  actualStatus: ServiceStatus;
  pidAlive: boolean;
  portListening: boolean;
  managedPortPid: number | null;
  httpOk: boolean | null;
  runtimeInfoOk: boolean | null;
  checkedAt: string;
  issues: string[];
  probes: ServiceVerificationProbe[];
}

export interface ServiceConfigReadResult {
  ok: boolean;
  path: string;
  content: string;
  exists: boolean;
  source: "file" | "template" | "missing";
}

export interface ServiceLogsMeta {
  ok: boolean;
  logPath: string;
  exists: boolean;
}

export interface ServiceLogReadOptions {
  beforeOffset?: number;
  limitBytes?: number;
}

export interface ServiceLogStreamOptions {
  fromOffset?: number;
  pollIntervalMs?: number;
}

export interface ServiceOpenLogViewerRequest {
  serviceId: ServiceId;
  target: ServiceLogTarget | DesktopLogTarget;
  title: string;
  source?: LogViewerSource;
}

export interface ServiceRevealPathOptions {
  targetType?: "file" | "directory";
  directoryAction?: "open" | "reveal";
}

export interface ServiceRevealPathResult {
  ok: boolean;
  message: string;
  path: string;
}

export interface ServiceLogReadResult {
  ok: boolean;
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  startOffset: number;
  endOffset: number;
  hasPrevious: boolean;
  resetRequired: boolean;
  totalBytes: number;
}

export type ServiceLogStreamEventType = "append" | "reset" | "error";

export interface ServiceLogStreamEvent {
  subscriptionId: string;
  serviceId: ServiceId;
  target: ServiceLogTarget | DesktopLogTarget;
  source?: LogViewerSource;
  type: ServiceLogStreamEventType;
  path: string;
  exists: boolean;
  content: string;
  startOffset: number;
  endOffset: number;
  hasPrevious: boolean;
  totalBytes: number;
  message?: string;
}

export type ServiceLogStreamListener = (event: ServiceLogStreamEvent) => void;

export interface ServiceImportResult {
  ok: boolean;
  message: string;
  targetPath: string;
  service: ServiceState;
}

export interface TunnelHubSettings {
  enabled: boolean;
  relayUrl: string;
  deviceId: string;
  hasRelayToken: boolean;
  relayTokenPreview: string;
  publicHost: string;
  publicUrl: string;
  webSocketUrl: string;
  lastRegisteredAt?: string;
  tlsInsecureSkipVerify: boolean;
  reconnectSeconds: number;
}

export interface TunnelHubSettingsInput {
  enabled?: boolean;
  relayUrl?: string;
  deviceId?: string;
  relayToken?: string;
  clearRelayToken?: boolean;
  rotateRelayToken?: boolean;
  tlsInsecureSkipVerify?: boolean;
  reconnectSeconds?: number;
}

export interface TunnelHubSettingsResult {
  ok: boolean;
  message: string;
  settings: TunnelHubSettings;
  configPath?: string;
  runtimeStatus?: TunnelHubRuntimeStatus;
}

export type TunnelHubRuntimePhase =
  | "disabled"
  | "stopped"
  | "starting"
  | "registered"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopping"
  | "error";

export interface TunnelHubRuntimeStatus {
  enabled: boolean;
  running: boolean;
  connected: boolean;
  phase: TunnelHubRuntimePhase;
  deviceId: string;
  relayUrl: string;
  publicHost: string;
  publicUrl: string;
  webSocketUrl: string;
  lastRegisteredAt?: string;
  lastConnectedAt?: string;
  lastError?: string;
  reconnectSeconds: number;
}

export interface TunnelHubRuntimeCommandResult {
  ok: boolean;
  message: string;
  status: TunnelHubRuntimeStatus;
  settings: TunnelHubSettings;
}
