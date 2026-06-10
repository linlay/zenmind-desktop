export type ServiceId = string;
export type ServiceKind = "builtin" | "plugin";
export type FrontendMode = "none" | "embedded" | "standalone";
export type ServiceLogTarget = "main" | "error";
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
  version: string;
  description: string;
  installDir: string;
  paths: ServicePaths;
  installed: boolean;
  status: ServiceStatus;
  statusLabel: string;
  message: string;
  frontendMode: FrontendMode;
  configFiles: ServiceConfigFile[];
  healthMeta: ServiceHealthMeta;
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
  target: ServiceLogTarget;
  title: string;
}

export interface ServiceRevealPathOptions {
  targetType?: "file" | "directory";
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
  target: ServiceLogTarget;
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

export interface TunnelHubAgentSettings {
  relayUrl: string;
  hasAgentToken: boolean;
  agentTokenPreview: string;
  tlsInsecureSkipVerify: boolean;
  reconnectSeconds: number;
}

export interface TunnelHubAgentSettingsInput {
  relayUrl?: string;
  agentToken?: string;
  clearAgentToken?: boolean;
  tlsInsecureSkipVerify?: boolean;
  reconnectSeconds?: number;
}

export interface TunnelHubAgentSettingsResult {
  ok: boolean;
  message: string;
  settings: TunnelHubAgentSettings;
  configPath?: string;
}
