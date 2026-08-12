import type { FrontendMode } from "./services";

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

export interface ManifestLifecycle {
  start?: ManifestCommand;
  stop?: ManifestCommand;
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

export interface ManifestPluginServiceWeb {
  healthPath?: string;
  portEnvKey?: string;
  defaultPort?: number;
}

export interface ManifestPluginService {
  web?: ManifestPluginServiceWeb;
  ui?: FrontendMode;
}

export interface ManifestDesktopRuntimeConfig {
  path?: string;
  envKeys?: string[];
}

export interface ManifestDesktopDisabledResponse {
  status?: number;
  json?: unknown;
  body?: string;
  contentType?: string;
}

export type ManifestDesktopProxyRouteMatch = "exact" | "prefix";
export type ManifestDesktopProxyRouteAuth = "agent-platform-access-token";

export interface ManifestDesktopProxyRoute {
  match: ManifestDesktopProxyRouteMatch;
  path: string;
  targetEnv: string;
  http?: boolean;
  websocket?: boolean;
  optional?: boolean;
  auth?: ManifestDesktopProxyRouteAuth;
  ssePaths?: string[];
  disableProxyBuffering?: boolean;
  stripRequestHeaders?: string[];
  disabledResponse?: ManifestDesktopDisabledResponse;
}

export interface ManifestDesktopHosting {
  runtimeConfig?: ManifestDesktopRuntimeConfig;
  spaRoutes?: string[];
  proxyRoutes?: ManifestDesktopProxyRoute[];
}

export interface ManifestDesktop {
  assetFileName?: string;
  bundleTopLevelDir?: string;
  envBindings?: ManifestEnvBinding[];
  hosting?: ManifestDesktopHosting;
  capabilities?: ManifestDesktopCapabilities;
  actions?: ManifestDesktopAction[];
}

export interface ManifestEnvBinding {
  key: string;
  value?: string;
  fromService?: string;
  template?: string;
  onlyIfDefault?: boolean;
  defaults?: string[];
}

export type ManifestDesktopCapabilityPhase = "preStart" | "verifyRunning";
export type ManifestDesktopCapabilityOutput = "file" | "stdoutLastLine";
export type ManifestDesktopCapabilityRequirementAction = "copyFile" | "preload" | "waitHttp";

export interface ManifestDesktopCapabilityProvider {
  id: string;
  command?: ManifestCommand;
  windowsCommand?: ManifestCommand;
  darwinCommand?: ManifestCommand;
  linuxCommand?: ManifestCommand;
  env?: Record<string, string>;
  output?: ManifestDesktopCapabilityOutput;
  outputPath?: string;
  dependsOn?: string[];
  retryOnSqliteBusy?: boolean;
  validateJwtDeviceId?: boolean;
  allowDeviceIdFallback?: boolean;
}

export interface ManifestDesktopCapabilityRequirement {
  phase: ManifestDesktopCapabilityPhase;
  capability?: string;
  service?: string;
  action?: ManifestDesktopCapabilityRequirementAction;
  target?: string;
  authCapability?: string;
}

export interface ManifestDesktopCapabilities {
  provides?: ManifestDesktopCapabilityProvider[];
  requires?: ManifestDesktopCapabilityRequirement[];
}

export type ManifestDesktopActionPlacement = "controlCenter";

export interface ManifestDesktopActionGlobalShortcut {
  settingKey: string;
}

export interface ManifestDesktopAction {
  id: string;
  label: string;
  icon?: string;
  placement?: ManifestDesktopActionPlacement;
  requiresRunning?: boolean;
  globalShortcut?: ManifestDesktopActionGlobalShortcut;
}

export type ManifestPluginSettingType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "shortcut"
  | "duration";

export type ManifestPluginSettingValue = string | number | boolean | string[];
export type ManifestPluginSettingPlatform = "darwin" | "win32" | "linux";

export interface ManifestPluginSettingOption {
  label: string;
  value: string;
}

export interface ManifestPluginSettingField {
  key: string;
  type: ManifestPluginSettingType;
  label: string;
  description?: string;
  defaultValue?: ManifestPluginSettingValue;
  defaultValueByPlatform?: Partial<Record<ManifestPluginSettingPlatform, ManifestPluginSettingValue>>;
  required?: boolean;
  placeholder?: string;
  options?: ManifestPluginSettingOption[];
  min?: number;
  max?: number;
  step?: number;
  restartRequired?: boolean;
}

export interface ManifestPluginSettingsUi {
  customHtmlPath?: string;
}

export interface ManifestPluginSettings {
  schemaVersion?: number;
  fields?: ManifestPluginSettingField[];
  ui?: ManifestPluginSettingsUi;
}

export interface ManifestPluginHooks {
  subscribe?: string[];
}

export interface ManifestPluginBridge {
  requests?: string[];
}

export interface ManifestPluginWebappResource {
  id: string;
  source: string;
}

export interface ManifestPluginAgentResource {
  key: string;
  definition: Record<string, unknown>;
  soulPrompt?: string;
  agentsPrompt?: string;
}

export interface ManifestPluginAutomationResource {
  id: string;
  name: string;
  description?: string;
  cron: string;
  agentKey: string;
  enabled?: boolean;
  teamId?: string;
  zoneId?: string;
  remainingRuns?: number;
  query: Record<string, unknown>;
}

export interface ManifestPluginResources {
  webapps?: ManifestPluginWebappResource[];
  agents?: ManifestPluginAgentResource[];
  automations?: ManifestPluginAutomationResource[];
}

export interface Manifest {
  pluginApiVersion?: number;
  id: string;
  name: string;
  version: string;
  description: string;
  platform?: ManifestPlatform;
  api?: ManifestApi;
  backend?: ManifestBackend;
  lifecycle?: ManifestLifecycle;
  configFiles?: ManifestConfigFile[];
  runtime?: ManifestRuntime;
  service?: ManifestPluginService;
  prerequisites?: string[];
  desktop?: ManifestDesktop;
  hooks?: ManifestPluginHooks;
  bridge?: ManifestPluginBridge;
  resources?: ManifestPluginResources;
  settings?: ManifestPluginSettings;
}

export interface PluginInstallResult {
  ok: boolean;
  message: string;
  serviceId?: string;
}

export const DEFAULT_AGENT_WEBCLIENT_RUNTIME_CONFIG_ENV_KEYS = [
  "DESKTOP_APP",
  "DEBUG_PANEL_ENABLED",
  "DELTA_LOGS_ENABLED",
  "SETTINGS_MENU_ENABLED",
  "QUICK_ACTIONS_ENABLED",
  "SHARE_APP_DOWNLOAD_URL",
  "VOICE_ASR_CLIENT_GATE_ENABLED",
  "VOICE_ASR_CLIENT_GATE_RMS_THRESHOLD",
  "VOICE_ASR_CLIENT_GATE_OPEN_HOLD_MS",
  "VOICE_ASR_CLIENT_GATE_CLOSE_HOLD_MS",
  "VOICE_ASR_CLIENT_GATE_PRE_ROLL_MS"
];

export const DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING: ManifestDesktopHosting = {
  runtimeConfig: {
    path: "/runtime-config.js",
    envKeys: DEFAULT_AGENT_WEBCLIENT_RUNTIME_CONFIG_ENV_KEYS
  },
  spaRoutes: [
    "/agent/",
    "/agents/",
    "/archives",
    "/automations",
    "/copilot",
    "/memory",
    "/mcp-servers",
    "/project",
    "/registries"
  ],
  proxyRoutes: [
    {
      match: "exact",
      path: "/ws",
      targetEnv: "BASE_URL",
      http: false,
      websocket: true,
      auth: "agent-platform-access-token",
      stripRequestHeaders: ["sec-websocket-extensions"]
    },
    {
      match: "prefix",
      path: "/api/voice",
      targetEnv: "VOICE_BASE_URL",
      optional: true,
      websocket: true,
      stripRequestHeaders: ["sec-websocket-extensions"],
      disabledResponse: {
        status: 404,
        json: { error: "voice disabled" }
      }
    },
    {
      match: "prefix",
      path: "/api",
      targetEnv: "BASE_URL",
      websocket: true,
      auth: "agent-platform-access-token",
      ssePaths: ["/api/query", "/api/attach"],
      disableProxyBuffering: true,
      stripRequestHeaders: ["sec-websocket-extensions"]
    }
  ]
};
