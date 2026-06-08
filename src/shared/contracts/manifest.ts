import type { FrontendMode, ServiceKind } from "./services";

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
}

export interface ManifestEnvBinding {
  key: string;
  value?: string;
  fromService?: string;
  template?: string;
  onlyIfDefault?: boolean;
  defaults?: string[];
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

export const DEFAULT_AGENT_WEBCLIENT_RUNTIME_CONFIG_ENV_KEYS = [
  "DESKTOP_APP",
  "DEBUG_PANEL_ENABLED",
  "DELTA_LOGS_ENABLED",
  "SETTINGS_MENU_ENABLED",
  "QUICK_ACTIONS_ENABLED",
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
    "/automations",
    "/copilot",
    "/memory"
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
      ssePaths: ["/api/query", "/api/attach"],
      disableProxyBuffering: true,
      stripRequestHeaders: ["sec-websocket-extensions"]
    }
  ]
};
