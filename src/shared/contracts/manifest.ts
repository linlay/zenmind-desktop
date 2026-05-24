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

export interface ManifestDesktop {
  assetFileName?: string;
  bundleTopLevelDir?: string;
  envBindings?: ManifestEnvBinding[];
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
