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

export interface ServiceState {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  installDir: string;
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

export interface ServiceImportResult {
  ok: boolean;
  message: string;
  targetPath: string;
  service: ServiceState;
}

export interface PanAuthStatus {
  configured: boolean;
  path: string;
  message: string;
}

export interface PanAuthImportResult {
  ok: boolean;
  message: string;
  status: PanAuthStatus;
}

export type AgentAuthRefreshReason = "missing" | "unauthorized";

export interface AgentAuthIssueResult {
  ok: boolean;
  token: string;
  message: string;
}

export interface ManifestPlatform {
  os: string;
  arch: string;
}

export interface ManifestFrontend {
  mode: FrontendMode;
  entry?: string;
  assetsPrefix?: string;
  directAccess?: boolean;
  hostManaged?: boolean;
  dist?: string;
  index?: string;
  spa?: boolean;
}

export interface ManifestApi {
  enabled: boolean;
  adminBaseUrl?: string;
  openidBaseUrl?: string;
  oauth2BaseUrl?: string;
}

export interface ManifestBackend {
  entry: string;
}

export type ManifestCommand = string | string[];

export interface ManifestScripts {
  start: ManifestCommand;
  stop: ManifestCommand;
  deploy?: ManifestCommand;
}

export interface ManifestConfigFile {
  key: string;
  label: string;
  relativePath: string;
  templateRelativePath?: string;
  required: boolean;
}

export interface ManifestRuntime {
  pidRelativePath?: string;
  logRelativePath?: string;
  errorLogRelativePath?: string;
  requiredPaths?: string[];
}

export interface ManifestWeb {
  routePath: string;
  portEnvKey: string;
  defaultPort: number;
}

export interface ManifestDesktop {
  assetFileName?: string;
  bundleTopLevelDir?: string;
  autoStart?: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  kind: ServiceKind;
  version: string;
  description: string;
  platform?: ManifestPlatform;
  frontend: ManifestFrontend;
  api?: ManifestApi;
  backend?: ManifestBackend;
  scripts: ManifestScripts;
  configFiles?: ManifestConfigFile[];
  runtime: ManifestRuntime;
  web?: ManifestWeb;
  prerequisites?: string[];
  desktop?: ManifestDesktop;
}

export interface PluginInstallResult {
  ok: boolean;
  message: string;
  serviceId?: string;
}

export interface CodeAssistantStatus {
  enabled: boolean;
  fullAccessGranted: boolean;
  running: boolean;
  configured: boolean;
  repoSelected: boolean;
  repoPath: string;
  cliConnected: boolean;
  recovering: boolean;
  ready: boolean;
  error?: string;
}

export interface CodeAssistantCommandResult {
  ok: boolean;
  message: string;
  prompted?: boolean;
  status: CodeAssistantStatus;
}

export interface CodeAssistantRepoContext {
  repoPath: string;
  repoExists: boolean;
  isGitRepo: boolean;
  userSelected: boolean;
  currentBranch: string;
  branches: string[];
}

export interface CodeAssistantRepoCommandResult {
  ok: boolean;
  message: string;
  context: CodeAssistantRepoContext;
}

export interface DataRootChangeResult {
  ok: boolean;
  message: string;
  dataRoot: string;
}

export type NavigateListener = (path: string) => void;

export interface DesktopApi {
  services: {
    list: () => Promise<ServiceState[]>;
    installBuiltinFromBundle: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    installBuiltin: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    initialize: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    getStatus: (serviceId: ServiceId) => Promise<ServiceState>;
    start: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    stop: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    restart: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    readConfig: (serviceId: ServiceId, key: string) => Promise<ServiceConfigReadResult>;
    writeConfig: (serviceId: ServiceId, key: string, content: string) => Promise<ServiceCommandResult>;
    importFile: (serviceId: ServiceId, targetKey: string) => Promise<ServiceImportResult>;
    getLogsMeta: (serviceId: ServiceId) => Promise<ServiceLogsMeta>;
    readLog: (
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options?: ServiceLogReadOptions
    ) => Promise<ServiceLogReadResult>;
  };
  plugins: {
    install: () => Promise<PluginInstallResult>;
    uninstall: (serviceId: ServiceId) => Promise<PluginInstallResult>;
  };
  panAuth: {
    importPrivateKey: () => Promise<PanAuthImportResult>;
    getStatus: () => Promise<PanAuthStatus>;
  };
  agentAuth: {
    issueAccessToken: (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  };
  codeAssistant: {
    getStatus: () => Promise<CodeAssistantStatus>;
    ensureReady: () => Promise<CodeAssistantCommandResult>;
    restartRuntime: () => Promise<CodeAssistantCommandResult>;
    setEnabled: (enabled: boolean) => Promise<CodeAssistantCommandResult>;
    setFullAccessGranted: (granted: boolean) => Promise<CodeAssistantCommandResult>;
    getRepoContext: () => Promise<CodeAssistantRepoContext>;
    selectRepoPath: () => Promise<CodeAssistantRepoCommandResult>;
    setBranch: (branch: string) => Promise<CodeAssistantRepoCommandResult>;
  };
  settings: {
    getDataRoot: () => Promise<string>;
    changeDataRoot: () => Promise<DataRootChangeResult>;
  };
  onNavigate: (listener: NavigateListener) => () => void;
}
