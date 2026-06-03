import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../../../shared/contracts";
import type { ServiceDefinition } from "../../manifest-utils";
import { getPluginInstallDir } from "../../plugin-loader";
import {
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServicesRoot,
  getServiceStateRoot
} from "../../user-paths";
import { STORAGE_NAMESPACE } from "../../../shared/generated/brand";

const INITIALIZATION_STATE_DIRNAME = `.${STORAGE_NAMESPACE}`;
const INITIALIZATION_STATE_FILE = "init-state.json";

export type ServiceLayout = {
  programDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
  envPath: string;
};

export function getInstallDir(app: App, service: ServiceDefinition) {
  if (service.kind === "plugin") {
    return getPluginInstallDir(app, service.id);
  }
  return path.join(getServicesRoot(app), service.id, service.version);
}

export function getServiceLayout(app: App, service: ServiceDefinition): ServiceLayout {
  const programDir = getInstallDir(app, service);
  const configDir = getServiceConfigRoot(app, service.id, service.kind);
  const dataDir = getServiceDataRoot(app, service.id, service.kind);
  const stateDir = getServiceStateRoot(app, service.id, service.kind);
  const logDir = getServiceLogsRoot(app, service.id, service.kind);
  return {
    programDir,
    configDir,
    dataDir,
    stateDir,
    logDir,
    envPath: path.join(configDir, ".env")
  };
}

export function resolveConfigPath(layout: ServiceLayout, relativePath: string) {
  return path.join(layout.configDir, relativePath);
}

export function resolveProgramPath(layout: ServiceLayout, relativePath: string) {
  return path.join(layout.programDir, relativePath);
}

export function resolveConfigTemplatePath(layout: ServiceLayout, relativePath: string) {
  return resolveProgramPath(layout, relativePath);
}

export function resolveServiceRuntimePath(layout: ServiceLayout, relativePath: string) {
  if (!relativePath) {
    return "";
  }
  const baseName = path.basename(relativePath);
  if (/\.pid$/iu.test(baseName) || /(^|[\\/])pid([\\/]|$)/iu.test(relativePath)) {
    return path.join(layout.stateDir, baseName);
  }
  if (/\.log$/iu.test(baseName)) {
    return path.join(layout.logDir, baseName);
  }
  return path.join(layout.stateDir, relativePath);
}

export function getInitializationStatePath(layoutOrInstallDir: ServiceLayout | string) {
  if (typeof layoutOrInstallDir === "string") {
    return path.join(layoutOrInstallDir, INITIALIZATION_STATE_DIRNAME, INITIALIZATION_STATE_FILE);
  }
  return path.join(layoutOrInstallDir.stateDir, INITIALIZATION_STATE_FILE);
}

export function buildServiceLayoutEnv(layout: ServiceLayout): NodeJS.ProcessEnv {
  return {
    SERVICE_PROGRAM_DIR: layout.programDir,
    SERVICE_CONFIG_DIR: layout.configDir,
    SERVICE_DATA_DIR: layout.dataDir,
    SERVICE_STATE_DIR: layout.stateDir,
    SERVICE_LOG_DIR: layout.logDir
  };
}

export function getBuiltinServiceVersionRoot(app: App, serviceId: ServiceId) {
  return path.join(getServicesRoot(app), serviceId);
}
