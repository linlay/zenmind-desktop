import { type ManifestDesktopCapabilityRequirement, type ServiceId, type ManifestDesktopCapabilityPhase } from "../../../../shared/contracts";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { normalizeProbeUrl, type HttpProbeResult, probeHttpUrl } from "./service-probes";
import { type App } from "electron";
import { ServiceVerificationOptions, integrationPorts } from "./manager-contracts";
import { resolveDesktopCapability, createVerificationCapabilityResolver } from "./capabilities";
import { getService } from "../service-registry";
import { runStartupCheckpoint } from "../../../support/logging/startup-checkpoints";
import { getServiceState } from "./service-state";
import { ensureMutableInstallDir } from "./installation";
import { t } from "../../../support/i18n/main-i18n";
import { type ServiceLayout, resolveConfigPath, getServiceLayout } from "./layout";
import fs from "node:fs";
import { ensureDir, prepareServiceExecutionLayout } from "./execution-layout";
import path from "node:path";
import { type ServicesIntegrationPorts } from "../integration-ports";

export function getCapabilityRequirementAction(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.action) {
    return requirement.action;
  }
  return requirement.capability ? "preload" : "waitHttp";
}

export function describeCapabilityRequirement(requirement: ManifestDesktopCapabilityRequirement) {
  if (requirement.capability) {
    return `capability ${requirement.capability}`;
  }
  return `service ${requirement.service ?? "(unknown)"}`;
}

export function getDefaultRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string) {
  if (requiredService.id === "agent-platform" || requiredService.id === "agent-container-hub") {
    return normalizeProbeUrl(webUrl, "/api/runtime-info");
  }
  return webUrl;
}

export function resolveRequirementHttpTarget(requiredService: ServiceDefinition, webUrl: string, target: string | undefined) {
  const trimmed = target?.trim() ?? "";
  if (!trimmed) {
    return getDefaultRequirementHttpTarget(requiredService, webUrl);
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return trimmed;
  }
  return normalizeProbeUrl(webUrl, trimmed);
}

export function resolveAgentPlatformReadinessFallbackTarget(
  requiredServiceId: string,
  target: string,
  probe: Pick<HttpProbeResult, "statusCode">
) {
  if (requiredServiceId !== "agent-platform" || probe.statusCode !== 404) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.pathname !== "/api/runtime-info") {
    return null;
  }
  return normalizeProbeUrl(target, "/api/agents");
}

export async function ensureRequiredServiceHttpReachable(
  app: App,
  requirement: ManifestDesktopCapabilityRequirement,
  options: ServiceVerificationOptions = {},
  resolveCapability = resolveDesktopCapability
) {
  const requiredServiceId = requirement.service as ServiceId | undefined;
  if (!requiredServiceId) {
    throw new Error("HTTP dependency requirement missing service id.");
  }

  let requiredService: ServiceDefinition;
  try {
    requiredService = getService(requiredServiceId);
  } catch {
    throw new Error(`missing required service provider: ${requiredServiceId}`);
  }

  const state = await runStartupCheckpoint(requiredService.id, "dependency-http", "read-service-state", () => getServiceState(app, requiredService.id, {
    ...options.stateReadOptions,
    integrationPorts: options.integrationPorts
  }));
  if (state.status !== "running") {
    throw new Error(`${requiredService.name} is ${state.status}.`);
  }

  const webUrl = state.healthMeta.webUrl;
  if (!webUrl) {
    throw new Error(`${requiredService.name} does not expose a Desktop web URL.`);
  }

  const target = resolveRequirementHttpTarget(requiredService, webUrl, requirement.target);
  const authCapability = requirement.authCapability?.trim() ?? "";
  const authResult = authCapability
    ? await runStartupCheckpoint(requiredService.id, "dependency-http", "resolve-auth", () => resolveCapability(app, authCapability, {
      ports: integrationPorts(options.integrationPorts),
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService, options.integrationPorts);
      }
    }))
    : null;
  const authToken = authResult?.token || authResult?.text || "";
  const probe = await runStartupCheckpoint(requiredService.id, "dependency-http", "probe", () => probeHttpUrl(target, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  }));
  if (!probe.ok) {
    console.warn("[service-verification] HTTP check failed", { serviceId: requiredService.id, statusCode: probe.statusCode ?? null });
    const fallbackTarget = resolveAgentPlatformReadinessFallbackTarget(requiredService.id, target, probe);
    if (fallbackTarget) {
      const fallbackProbe = await probeHttpUrl(fallbackTarget, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });
      if (fallbackProbe.ok) {
        return;
      }
      console.warn("[service-verification] fallback HTTP check failed", { serviceId: requiredService.id, statusCode: fallbackProbe.statusCode ?? null });
      throw new Error(
        [
          t("service.verify.probeFailed", { target, message: probe.message || t("service.probeHttpUnavailable") }),
          t("service.verify.probeFailed", { target: fallbackTarget, message: fallbackProbe.message || t("service.probeHttpUnavailable") })
        ].join(t("common.listSeparator"))
      );
    }
    throw new Error(t("service.verify.probeFailed", {
      target,
      message: probe.message || t("service.probeHttpUnavailable")
    }));
  }
}

export async function applyDesktopCapabilityRequirement(
  app: App,
  _service: ServiceDefinition,
  layout: ServiceLayout,
  requirement: ManifestDesktopCapabilityRequirement,
  options: ServiceVerificationOptions = {},
  resolveCapability = resolveDesktopCapability
) {
  const action = getCapabilityRequirementAction(requirement);

  if (requirement.capability) {
    if (action === "waitHttp") {
      throw new Error(`${describeCapabilityRequirement(requirement)} cannot use waitHttp.`);
    }
    const result = await resolveCapability(app, requirement.capability, {
      ports: integrationPorts(options.integrationPorts),
      ensureProviderInstall: async (providerService) => {
        await ensureMutableInstallDir(app, providerService, options.integrationPorts);
      }
    });

    if (action === "copyFile") {
      if (!requirement.target) {
        throw new Error(`${describeCapabilityRequirement(requirement)} copyFile missing target.`);
      }
      if (!result.filePath) {
        throw new Error(`${describeCapabilityRequirement(requirement)} did not produce file output.`);
      }
      const targetPath = resolveConfigPath(layout, requirement.target);
      const nextContent = result.text ?? fs.readFileSync(result.filePath, "utf8");
      ensureDir(path.dirname(targetPath));
      const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      if (currentContent !== nextContent) {
        fs.writeFileSync(targetPath, nextContent, "utf8");
      }
      return;
    }

    if (action !== "preload") {
      throw new Error(`${describeCapabilityRequirement(requirement)} unsupported action ${action}.`);
    }
    return;
  }

  if (requirement.service) {
    if (action !== "waitHttp") {
      throw new Error(`${describeCapabilityRequirement(requirement)} must use waitHttp.`);
    }
    await ensureRequiredServiceHttpReachable(app, requirement, options, resolveCapability);
    return;
  }

  throw new Error("Desktop capability requirement missing capability or service.");
}

export async function applyDesktopCapabilityRequirements(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  phase: ManifestDesktopCapabilityPhase,
  options: ServiceVerificationOptions = {}
) {
  const requirements = service.desktop.capabilities.requires.filter((requirement) => requirement.phase === phase);
  for (const requirement of requirements) {
    await applyDesktopCapabilityRequirement(app, service, layout, requirement, options);
  }
}

export async function collectDesktopCapabilityRequirementIssues(
  app: App,
  service: ServiceDefinition,
  layout: ServiceLayout,
  phase: ManifestDesktopCapabilityPhase,
  options: ServiceVerificationOptions = {}
) {
  const issues: string[] = [];
  const resolveCapability = createVerificationCapabilityResolver();
  const requirements = service.desktop.capabilities.requires.filter((requirement) => requirement.phase === phase);
  for (const requirement of requirements) {
    try {
      await runStartupCheckpoint(service.id, `requirement-${phase}`, describeCapabilityRequirement(requirement).replace(/\s+/gu, "-"),
        () => applyDesktopCapabilityRequirement(app, service, layout, requirement, options, resolveCapability));
    } catch (error) {
      console.warn("[service-verification] requirement failed", { serviceId: service.id, phase, requirement: describeCapabilityRequirement(requirement) });
      const message = error instanceof Error ? error.message : String(error);
      issues.push(t("service.verify.requirementNotReady", {
        requirement: describeCapabilityRequirement(requirement),
        message
      }));
    }
  }
  return issues;
}

export async function ensurePreStartRequirements(
  app: App,
  service: ServiceDefinition,
  ports?: ServicesIntegrationPorts
) {
  const layout = getServiceLayout(app, service);
  prepareServiceExecutionLayout(service, layout);

  if (service.id === "agent-platform") {
    await integrationPorts(ports).ensureProviderRegisterApiKey(app);
  }

  if (service.id !== "agent-platform") {
    await applyDesktopCapabilityRequirements(app, service, layout, "preStart", {
      integrationPorts: ports
    });
  }
}
