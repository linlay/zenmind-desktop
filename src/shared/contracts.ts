export type ServiceId = string;
export type ServiceKind = "builtin" | "plugin";
export type ServiceStatus =
  | "not-installed"
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
  hasFrontend: boolean;
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
}

export interface ServiceLogsMeta {
  ok: boolean;
  logPath: string;
  exists: boolean;
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

export interface PanAuthEnsureResult {
  ok: boolean;
  refreshed: boolean;
  message: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  hasFrontend: boolean;
  configFiles?: Array<{
    key: string;
    label: string;
    relativePath: string;
    templateRelativePath?: string;
    required: boolean;
  }>;
  runtime: {
    pidRelativePath: string;
    logRelativePath: string;
    startCommand: string[];
    stopCommand: string[];
  };
  web?: {
    routePath: string;
    portEnvKey: string;
    defaultPort: number;
  };
}

export interface PluginInstallResult {
  ok: boolean;
  message: string;
  serviceId?: string;
}

export interface DesktopApi {
  services: {
    list: () => Promise<ServiceState[]>;
    installBuiltin: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    getStatus: (serviceId: ServiceId) => Promise<ServiceState>;
    start: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    stop: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    restart: (serviceId: ServiceId) => Promise<ServiceCommandResult>;
    readConfig: (serviceId: ServiceId, key: string) => Promise<ServiceConfigReadResult>;
    writeConfig: (serviceId: ServiceId, key: string, content: string) => Promise<ServiceCommandResult>;
    importFile: (serviceId: ServiceId, targetKey: string) => Promise<ServiceImportResult>;
    getLogsMeta: (serviceId: ServiceId) => Promise<ServiceLogsMeta>;
  };
  plugins: {
    install: () => Promise<PluginInstallResult>;
    uninstall: (serviceId: ServiceId) => Promise<PluginInstallResult>;
  };
  panAuth: {
    importPrivateKey: () => Promise<PanAuthImportResult>;
    getStatus: () => Promise<PanAuthStatus>;
    ensureSession: (webUrl: string) => Promise<PanAuthEnsureResult>;
  };
}
