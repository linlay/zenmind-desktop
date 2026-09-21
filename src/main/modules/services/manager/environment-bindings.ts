import { type App } from "electron";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { getServiceLayout } from "./layout";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { getServiceState } from "./service-state";
import { PROCESS_EXEC_PATH_PLACEHOLDER } from "./env-normalization";
import { NODE_BIN_START_ENV_SERVICE_IDS } from "./command-environment";
import { type ServiceId } from "../../../../shared/contracts";
import { getService } from "../service-registry";

export function renderEnvBindingTemplate(value: string, values: Record<string, string>) {
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_match, key: string) => values[key] ?? "");
}

export function getEnvBindingTemplateValues(app: App, service: ServiceDefinition) {
  const layout = getServiceLayout(app, service);
  return {
    "service.programDir": layout.programDir,
    "service.configDir": layout.configDir,
    "service.dataDir": layout.dataDir,
    "service.stateDir": layout.stateDir,
    "service.logDir": layout.logDir,
    "service.envPath": layout.envPath,
    serviceDefaultPort: String(service.web.defaultPort)
  };
}

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
