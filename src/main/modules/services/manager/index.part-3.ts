import fs from "node:fs";
import type { App } from "electron";
import type {
  ServiceId,
  ServiceState
} from "../../../../shared/contracts";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { getService } from "../service-registry";
import type { ServicesIntegrationPorts } from "../integration-ports";
import { readEnvFile } from "../../../infrastructure/filesystem/env-file";
import {
  type ServiceLayout
} from "./layout";
import {
  resolveNodeBin
} from "./command-env";
import {
  LOCAL_CLI_ACP_RELAY_PLUGIN_ID,
  PROCESS_EXEC_PATH_PLACEHOLDER
} from "./env-normalization";
import { CORE_SERVICE_IDS, ServiceCommandKind, ServiceStateReadOptions, ServiceVerificationOptions, integrationPorts } from "./index.part-1";
import { getEnvBindingTemplateValues, getServiceState, getStartupResponsiveServiceStateReadOptions, getStartupServiceStateReadOptions, renderEnvBindingTemplate } from "./index.part-2";





export function getEnvBindingDefaultValues(
  app: App,
  service: ServiceDefinition,
  binding: ServiceDefinition["desktop"]["envBindings"][number]
) {
  const values = getEnvBindingTemplateValues(app, service);
  return (binding.defaults ?? [""]).map((item) => renderEnvBindingTemplate(item, values));
}

export function resolveEnvBindingLiteralValue(app: App, service: ServiceDefinition, value: string) {
  return renderEnvBindingTemplate(value, getEnvBindingTemplateValues(app, service));
}

export async function applyEnvBindings(
  app: App,
  service: ServiceDefinition,
  env: Map<string, string>,
  updates: Map<string, string>,
  ports?: ServicesIntegrationPorts
) {
  for (const binding of service.desktop.envBindings) {
    const bindingKey = binding.key;
    const currentValue = env.get(bindingKey) ?? "";

    if (binding.onlyIfDefault) {
      const defaults = new Set(getEnvBindingDefaultValues(app, service, binding));
      if (!defaults.has(currentValue)) {
        continue;
      }
    }

    if (binding.fromService && binding.template) {
      try {
        const depState = await getServiceState(app, binding.fromService, { integrationPorts: ports });
        const port = depState.healthMeta.port ?? 0;
        const resolved = binding.template.replace("{{port}}", String(port));
        updates.set(bindingKey, resolved);
      } catch {
        // Dependency service not registered; skip this binding.
      }
      continue;
    }

    if (binding.value !== undefined) {
      if (
        bindingKey === "NODE_BIN" &&
        binding.value.trim() === PROCESS_EXEC_PATH_PLACEHOLDER &&
        NODE_BIN_START_ENV_SERVICE_IDS.has(service.id)
      ) {
        continue;
      }
      const resolved = resolveEnvBindingLiteralValue(app, service, binding.value);
      updates.set(bindingKey, resolved);
    }
  }
}

export async function getServicePortForEnvSync(app: App, serviceId: ServiceId) {
  try {
    const state = await getServiceState(app, serviceId);
    return state.healthMeta.port ?? getService(serviceId).web.defaultPort;
  } catch {
    try {
      return getService(serviceId).web.defaultPort;
    } catch {
      return null;
    }
  }
}

export function shouldReinitializeMissingCoreServiceConfig(service: ServiceDefinition, state: ServiceState) {
  return (
    service.kind === "builtin" &&
    CORE_SERVICE_IDS.has(service.id) &&
    state.status === "config-required" &&
    state.configFiles.some((configFile) => configFile.required && !configFile.exists)
  );
}

export type RunServiceCommandOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  commandKind?: ServiceCommandKind;
  stateReadOptions?: ServiceStateReadOptions;
};

export type StartServiceOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  skipPreStartRequirements?: boolean;
  skipBuiltinAssetRefresh?: boolean;
  stateReadOptions?: ServiceStateReadOptions;
  commandStateReadOptions?: ServiceStateReadOptions;
  verificationOptions?: ServiceVerificationOptions;
};

export function getPreparedStartupStartOptions(): StartServiceOptions {
  const stateReadOptions = getStartupServiceStateReadOptions();
  const responsiveReadOptions = getStartupResponsiveServiceStateReadOptions();
  return {
    skipPreStartRequirements: true,
    skipBuiltinAssetRefresh: true,
    stateReadOptions,
    commandStateReadOptions: responsiveReadOptions,
    verificationOptions: {
      stateReadOptions: responsiveReadOptions,
      skipManagedPortProbe: true
    }
  };
}

export function yieldStartupScheduler() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

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

export function getStartCommandEnvOverrides(_app: App, service: ServiceDefinition) {
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

export function isDaemonStartArg(value: string) {
  return value.trim().toLowerCase() === "--daemon" || value.trim().toLowerCase() === "-daemon";
}

export function getDesktopStartCommand(service: Pick<ServiceDefinition, "id" | "kind" | "startCommand">) {
  if (service.kind !== "builtin" || !CORE_SERVICE_IDS.has(service.id)) {
    return service.startCommand;
  }

  let command = [...service.startCommand];
  if (service.id === "agent-platform") {
    const withoutRuntimeMode: string[] = [];
    for (let index = 0; index < command.length; index += 1) {
      const arg = command[index];
      if (arg === "--runtime-mode") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--runtime-mode=")) continue;
      withoutRuntimeMode.push(arg);
    }
    command = withoutRuntimeMode;
    const daemonIndex = command.findIndex(isDaemonStartArg);
    if (daemonIndex >= 0) command.splice(daemonIndex, 0, "--runtime-mode=desktop");
    else command.push("--runtime-mode=desktop");
  }
  if (!command.some(isDaemonStartArg)) {
    command.push("--daemon");
  }
  return command;
}
