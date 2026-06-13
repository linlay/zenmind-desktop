import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceDefinition } from "./manifest-utils";
import { getAllServices } from "./services/service-registry";
import { getDesktopWebappsDataRoot, getServiceStateRoot } from "./user-paths";

type AgentPlatformCaller = (app: App, path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;

type PluginResourceOwnership = {
  webapps?: Record<string, { updatedAt: string }>;
  agents?: Record<string, { updatedAt: string }>;
  automations?: Record<string, { updatedAt: string }>;
  pendingAgentPlatformSync?: boolean;
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

async function upsertAgentResource(
  app: App,
  agent: ServiceDefinition["resources"]["agents"][number],
  owned: boolean
) {
  const payload = normalizeAgentPayload(agent);
  if (!owned) {
    await callAgentPlatform(app, "/api/agent/create", payload);
    return;
  }
  try {
    await callAgentPlatform(app, "/api/agent/create", payload);
  } catch {
    await callAgentPlatform(app, "/api/agent/update", payload);
  }
}

async function upsertAutomationResource(
  app: App,
  automation: ServiceDefinition["resources"]["automations"][number],
  owned: boolean
) {
  const payload = normalizeAutomationPayload(automation);
  if (!owned) {
    await callAgentPlatform(app, "/api/automation/create", payload);
    return;
  }
  try {
    await callAgentPlatform(app, "/api/automation/create", payload);
  } catch {
    await callAgentPlatform(app, "/api/automation/update", payload);
  }
}

async function syncAgentPlatformResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  ownership.agents = ownership.agents ?? {};
  ownership.automations = ownership.automations ?? {};
  try {
    for (const agent of service.resources.agents) {
      await upsertAgentResource(app, agent, Boolean(ownership.agents[agent.key]));
      ownership.agents[agent.key] = { updatedAt: nowIso() };
    }
    for (const automation of service.resources.automations) {
      await upsertAutomationResource(app, automation, Boolean(ownership.automations[automation.id]));
      ownership.automations[automation.id] = { updatedAt: nowIso() };
    }
    ownership.pendingAgentPlatformSync = false;
    delete ownership.lastError;
  } catch (error) {
    ownership.pendingAgentPlatformSync = true;
    ownership.lastError = error instanceof Error ? error.message : String(error);
  }
  writeOwnership(app, service.id, ownership);
}

export function configurePluginResources(options: { callAgentPlatform?: AgentPlatformCaller | null }) {
  callAgentPlatformCallback = options.callAgentPlatform ?? null;
}

export async function syncPluginResources(app: App, service: ServiceDefinition, pluginDir: string) {
  if (service.kind !== "plugin" || !hasResources(service)) {
    return { ok: true, message: "插件未声明资源。" };
  }
  copyWebappResource(app, service, pluginDir);
  await syncAgentPlatformResources(app, service);
  return { ok: true, message: "插件资源已同步。" };
}

export async function retryPendingPluginResourceSync(app: App) {
  for (const service of getAllServices()) {
    if (service.kind !== "plugin" || !hasResources(service)) {
      continue;
    }
    const ownership = readOwnership(app, service.id);
    if (ownership.pendingAgentPlatformSync) {
      await syncAgentPlatformResources(app, service);
    }
  }
}

export async function removePluginResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  const webappsRoot = getDesktopWebappsDataRoot(app);
  for (const webappId of Object.keys(ownership.webapps ?? {})) {
    fs.rmSync(path.join(webappsRoot, webappId), { recursive: true, force: true });
  }
  for (const automationId of Object.keys(ownership.automations ?? {})) {
    if (callAgentPlatformCallback) {
      await callAgentPlatform(app, "/api/automation/delete", { id: automationId }).catch(() => undefined);
    }
  }
  for (const agentKey of Object.keys(ownership.agents ?? {})) {
    if (callAgentPlatformCallback) {
      await callAgentPlatform(app, "/api/agent/delete", { key: agentKey }).catch(() => undefined);
    }
  }
  fs.rmSync(getOwnershipPath(app, service.id), { force: true });
}

export const __testInternals = {
  resolvePluginResourceDir,
  normalizeAgentPayload,
  normalizeAutomationPayload
};
