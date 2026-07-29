import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceDefinition } from "./manifest-utils";
import { getAllServices } from "./services/service-registry";
import {
  getDesktopWebappsDataRoot,
  getServiceStateRoot
} from "./user-paths";
import { disposeWebappInstallation } from "./webs/webapps/actions";
import { t } from "./i18n/main-i18n";

type AgentPlatformCaller = (app: App, path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;
export type PluginResourceDesiredStatus = "running" | "stopped";

type PluginResourceOwnership = {
  webapps?: Record<string, { updatedAt: string }>;
  agents?: Record<string, { updatedAt: string }>;
  automations?: Record<string, { updatedAt: string; platformId?: string }>;
  desiredStatus?: PluginResourceDesiredStatus;
  pendingAgentPlatformSync?: boolean;
  pendingAgentPlatformRemoval?: boolean;
  lastError?: string;
};

let callAgentPlatformCallback: AgentPlatformCaller | null = null;

function nowIso() {
  return new Date().toISOString();
}

function hasResources(service: ServiceDefinition) {
  return (
    service.resources.webapps.length > 0 ||
    service.resources.agents.length > 0 ||
    service.resources.automations.length > 0
  );
}

function hasOwnedResources(ownership: PluginResourceOwnership) {
  return (
    Object.keys(ownership.webapps ?? {}).length > 0 ||
    Object.keys(ownership.agents ?? {}).length > 0 ||
    Object.keys(ownership.automations ?? {}).length > 0
  );
}

function getOwnershipPath(app: App, pluginId: string) {
  return path.join(getServiceStateRoot(app, pluginId, "plugin"), "plugin-resources.json");
}

function readOwnership(app: App, pluginId: string): PluginResourceOwnership {
  try {
    return JSON.parse(fs.readFileSync(getOwnershipPath(app, pluginId), "utf8")) as PluginResourceOwnership;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function writeOwnership(app: App, pluginId: string, ownership: PluginResourceOwnership) {
  const filePath = getOwnershipPath(app, pluginId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
}

function resolveDesiredStatus(ownership: PluginResourceOwnership): PluginResourceDesiredStatus {
  if (ownership.desiredStatus === "running" || ownership.desiredStatus === "stopped") {
    return ownership.desiredStatus;
  }
  return hasOwnedResources(ownership) ? "running" : "stopped";
}

function ensureDesiredStatus(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  const desiredStatus = resolveDesiredStatus(ownership);
  if (ownership.desiredStatus !== desiredStatus) {
    ownership.desiredStatus = desiredStatus;
    writeOwnership(app, service.id, ownership);
  }
  return desiredStatus;
}

function updateDesiredStatus(
  app: App,
  service: ServiceDefinition,
  desiredStatus: PluginResourceDesiredStatus,
  changes: Partial<PluginResourceOwnership> = {}
) {
  const ownership = readOwnership(app, service.id);
  ownership.desiredStatus = desiredStatus;
  Object.assign(ownership, changes);
  writeOwnership(app, service.id, ownership);
  return ownership;
}

function resolvePluginResourceDir(pluginDir: string, relativePath: string) {
  const resolved = path.resolve(pluginDir, relativePath);
  const root = path.resolve(pluginDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`plugin resource path escapes plugin directory: ${relativePath}`);
  }
  return resolved;
}

function copyWebappResource(app: App, service: ServiceDefinition, pluginDir: string) {
  const webappsRoot = getDesktopWebappsDataRoot(app);
  const ownership = readOwnership(app, service.id);
  ownership.webapps = ownership.webapps ?? {};
  for (const webapp of service.resources.webapps) {
    const sourceDir = resolvePluginResourceDir(pluginDir, webapp.source);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`webapp resource is not a directory: ${webapp.source}`);
    }
    const targetDir = path.join(webappsRoot, webapp.id);
    if (fs.existsSync(targetDir) && !ownership.webapps[webapp.id]) {
      throw new Error(`webapp resource already exists and is not owned by plugin ${service.id}: ${webapp.id}`);
    }
    fs.mkdirSync(webappsRoot, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
    ownership.webapps[webapp.id] = { updatedAt: nowIso() };
  }
  writeOwnership(app, service.id, ownership);
}

async function removeWebappResources(app: App, service: ServiceDefinition, ownership: PluginResourceOwnership) {
  const webappsRoot = getDesktopWebappsDataRoot(app);
  for (const webappId of Object.keys(ownership.webapps ?? {})) {
    const disposed = await disposeWebappInstallation(
      app,
      {
        id: webappId,
        label: `plugin WebApp ${webappId}`,
        installPath: path.join(webappsRoot, webappId)
      },
      t("pluginResources.webappRemoved")
    );
    if (!disposed.ok) {
      throw new Error(disposed.message);
    }
  }
}

function normalizeAgentPayload(agent: ServiceDefinition["resources"]["agents"][number]) {
  return {
    key: agent.key,
    definition: {
      ...agent.definition,
      key: typeof agent.definition.key === "string" && agent.definition.key.trim()
        ? agent.definition.key
        : agent.key
    },
    ...(agent.soulPrompt ? { soulPrompt: agent.soulPrompt } : {}),
    ...(agent.agentsPrompt ? { agentsPrompt: agent.agentsPrompt } : {})
  };
}

function normalizeAutomationPayload(automation: ServiceDefinition["resources"]["automations"][number]) {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description ?? "",
    cron: automation.cron,
    agentKey: automation.agentKey,
    enabled: automation.enabled !== false,
    ...(automation.teamId ? { teamId: automation.teamId } : {}),
    ...(automation.zoneId ? { zoneId: automation.zoneId } : {}),
    ...(automation.remainingRuns !== undefined ? { remainingRuns: automation.remainingRuns } : {}),
    query: automation.query
  };
}

async function callAgentPlatform(app: App, endpoint: string, body: unknown) {
  if (!callAgentPlatformCallback) {
    throw new Error("agent-platform bridge is unavailable");
  }
  return callAgentPlatformCallback(app, endpoint, { method: "POST", body });
}

function readPlatformAutomationId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : typeof record.scheduleId === "string" && record.scheduleId.trim()
      ? record.scheduleId.trim()
      : "";
}

async function upsertAgentResource(
  app: App,
  agent: ServiceDefinition["resources"]["agents"][number],
  owned: boolean
) {
  const payload = normalizeAgentPayload(agent);
  if (!owned) {
    await callAgentPlatform(app, "/api/admin/agents/create", payload);
    return;
  }
  try {
    await callAgentPlatform(app, "/api/admin/agents/create", payload);
  } catch {
    await callAgentPlatform(app, "/api/admin/agents/update", payload);
  }
}

async function upsertAutomationResource(
  app: App,
  automation: ServiceDefinition["resources"]["automations"][number],
  platformId: string
) {
  const payload = normalizeAutomationPayload(automation);
  if (!platformId) {
    const detail = await callAgentPlatform(app, "/api/automation/create", payload);
    return readPlatformAutomationId(detail) || automation.id;
  }
  try {
    const detail = await callAgentPlatform(app, "/api/automation/update", {
      ...payload,
      id: platformId
    });
    return readPlatformAutomationId(detail) || platformId;
  } catch {
    const detail = await callAgentPlatform(app, "/api/automation/create", payload);
    return readPlatformAutomationId(detail) || platformId || automation.id;
  }
}

async function syncAgentPlatformResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  ownership.agents = ownership.agents ?? {};
  ownership.automations = ownership.automations ?? {};
  ownership.desiredStatus = "running";
  try {
    for (const agent of service.resources.agents) {
      await upsertAgentResource(app, agent, Boolean(ownership.agents[agent.key]));
      ownership.agents[agent.key] = { updatedAt: nowIso() };
    }
    for (const automation of service.resources.automations) {
      const ownedAutomation = ownership.automations[automation.id];
      const platformId = await upsertAutomationResource(
        app,
        automation,
        ownedAutomation?.platformId || (ownedAutomation ? automation.id : "")
      );
      ownership.automations[automation.id] = {
        updatedAt: nowIso(),
        ...(platformId ? { platformId } : {})
      };
    }
    ownership.pendingAgentPlatformSync = false;
    ownership.pendingAgentPlatformRemoval = false;
    delete ownership.lastError;
  } catch (error) {
    ownership.pendingAgentPlatformSync = true;
    ownership.pendingAgentPlatformRemoval = false;
    ownership.lastError = error instanceof Error ? error.message : String(error);
  }
  writeOwnership(app, service.id, ownership);
}

async function removeAgentPlatformResources(app: App, service: ServiceDefinition, options: { deleteOwnership?: boolean } = {}) {
  const ownership = readOwnership(app, service.id);
  ownership.desiredStatus = "stopped";
  try {
    for (const [automationId, record] of Object.entries(ownership.automations ?? {})) {
      await callAgentPlatform(app, "/api/automation/delete", { id: record.platformId || automationId });
    }
    for (const agentKey of Object.keys(ownership.agents ?? {})) {
      await callAgentPlatform(app, "/api/admin/agents/delete", { key: agentKey });
    }
    ownership.pendingAgentPlatformRemoval = false;
    ownership.pendingAgentPlatformSync = false;
    delete ownership.lastError;
  } catch (error) {
    ownership.pendingAgentPlatformRemoval = true;
    ownership.pendingAgentPlatformSync = false;
    ownership.lastError = error instanceof Error ? error.message : String(error);
  }
  if (options.deleteOwnership && !ownership.pendingAgentPlatformRemoval) {
    fs.rmSync(getOwnershipPath(app, service.id), { force: true });
    return;
  }
  writeOwnership(app, service.id, ownership);
}

export function configurePluginResources(options: { callAgentPlatform?: AgentPlatformCaller | null }) {
  callAgentPlatformCallback = options.callAgentPlatform ?? null;
}

export function initializePluginResourceState(app: App, service: ServiceDefinition) {
  if (service.kind !== "plugin" || !hasResources(service)) {
    return "stopped" satisfies PluginResourceDesiredStatus;
  }
  return ensureDesiredStatus(app, service);
}

export function readPluginResourceDesiredStatus(app: App, service: ServiceDefinition) {
  if (service.kind !== "plugin" || !hasResources(service)) {
    return "stopped" satisfies PluginResourceDesiredStatus;
  }
  return ensureDesiredStatus(app, service);
}

export async function syncPluginResources(app: App, service: ServiceDefinition, pluginDir: string) {
  if (service.kind !== "plugin" || !hasResources(service)) {
    return { ok: true, message: t("pluginResources.noneDeclared") };
  }
  updateDesiredStatus(app, service, "running");
  copyWebappResource(app, service, pluginDir);
  await syncAgentPlatformResources(app, service);
  return { ok: true, message: t("pluginResources.synced") };
}

export async function stopPluginResources(app: App, service: ServiceDefinition) {
  if (service.kind !== "plugin" || !hasResources(service)) {
    return { ok: true, message: t("pluginResources.noneDeclared") };
  }
  const ownership = updateDesiredStatus(app, service, "stopped", {
    pendingAgentPlatformSync: false
  });
  await removeWebappResources(app, service, ownership);
  await removeAgentPlatformResources(app, service);
  return { ok: true, message: t("pluginResources.uninstalled") };
}

export async function retryPendingPluginResourceSync(app: App) {
  for (const service of getAllServices()) {
    if (service.kind !== "plugin" || !hasResources(service)) {
      continue;
    }
    const ownership = readOwnership(app, service.id);
    const desiredStatus = resolveDesiredStatus(ownership);
    if (desiredStatus === "running" && (ownership.pendingAgentPlatformSync || ownership.pendingAgentPlatformRemoval)) {
      await syncAgentPlatformResources(app, service);
    } else if (desiredStatus === "stopped" && ownership.pendingAgentPlatformRemoval) {
      await removeAgentPlatformResources(app, service);
    }
  }
}

export async function removePluginResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  await removeWebappResources(app, service, ownership);
  if (callAgentPlatformCallback) {
    await removeAgentPlatformResources(app, service, { deleteOwnership: true });
  }
  fs.rmSync(getOwnershipPath(app, service.id), { force: true });
}

export const __testInternals = {
  resolvePluginResourceDir,
  readOwnership,
  writeOwnership,
  readPluginResourceDesiredStatus,
  normalizeAgentPayload,
  normalizeAutomationPayload
};
