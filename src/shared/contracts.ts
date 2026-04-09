export type ServiceId = "agent-container-hub" | "pan-webclient";
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
}
