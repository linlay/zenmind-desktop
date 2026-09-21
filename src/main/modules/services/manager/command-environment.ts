import { type ServiceId } from "../../../../shared/contracts";
import { LOCAL_CLI_ACP_RELAY_PLUGIN_ID } from "./env-normalization";
import { resolveNodeBin } from "./command-env";
import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { getPreparedEmbeddedNodeStartEnv } from "./embedded-node-runtime";
import { RunServiceCommandOptions, integrationPorts } from "./manager-contracts";
import { type ServiceLayout } from "./layout";
import { type ServicesIntegrationPorts } from "../integration-ports";
import fs from "node:fs";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";

export const NODE_BIN_START_ENV_SERVICE_IDS = new Set<ServiceId>([
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID
]);

export function resolveNodeBinStartEnv() {
  const nodeBin = resolveNodeBin();
  const env: Record<string, string> = { NODE_BIN: nodeBin };
  if (nodeBin === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function getStartCommandEnvOverrides(app: App, service: ServiceDefinition) {
  if (service.id === "agent-platform") return getPreparedEmbeddedNodeStartEnv(app);
  if (!NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)) {
    return undefined;
  }

  return resolveNodeBinStartEnv();
}

export function getDesktopStartCommandOptions(app: App, service: ServiceDefinition): RunServiceCommandOptions {
  return {
    refreshBuiltinAsset: false,
    env: getStartCommandEnvOverrides(app, service)
  };
}

export function buildDesktopServiceCommandEnv(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  overrides: NodeJS.ProcessEnv | undefined,
  ports?: ServicesIntegrationPorts
) {
  const pluginFileEnv = service.kind === "plugin" && fs.existsSync(layout.envPath)
    ? Object.fromEntries(readEnvFile(layout.envPath))
    : {};
  const env: NodeJS.ProcessEnv = {
    ...pluginFileEnv,
    ...(service.kind === "plugin"
      ? {
          SERVICE_PROGRAM_DIR: layout.programDir,
          SERVICE_CONFIG_DIR: layout.configDir,
          SERVICE_DATA_DIR: layout.dataDir,
          SERVICE_STATE_DIR: layout.stateDir,
          SERVICE_LOG_DIR: layout.logDir,
          SERVICE_ENV_PATH: layout.envPath
        }
      : {}),
    ...integrationPorts(ports).getPluginBridgeEnv(app, service),
    ...integrationPorts(ports).getPluginSettingsEnv(app, service),
    ...(overrides ?? {})
  };
  if (service.id === "identity-center") {
    env.DESKTOP_DEVICE_ID = integrationPorts(ports).getDesktopDeviceId(app);
  }
  return env;
}

export function buildDesktopServiceCommandEnvForTests(
  app: App,
  serviceOrLayout: ServiceDefinition | ServiceLayout,
  layoutOrOverrides: ServiceLayout | NodeJS.ProcessEnv | undefined,
  overrides?: NodeJS.ProcessEnv,
  ports?: ServicesIntegrationPorts
) {
  if ("programDir" in serviceOrLayout) {
    return {
      ...((layoutOrOverrides as NodeJS.ProcessEnv | undefined) ?? {})
    };
  }
  return buildDesktopServiceCommandEnv(
    app,
    serviceOrLayout,
    layoutOrOverrides as ServiceLayout,
    overrides,
    ports
  );
}
