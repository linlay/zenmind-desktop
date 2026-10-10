import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import type { ServiceDefinition } from "../../support/manifest/manifest-utils";
import { getAllServices } from "../services";
import {
  getDesktopWebappsDataRoot,
  getServiceStateRoot
} from "../../infrastructure/filesystem/user-paths";
import { webappManager } from "../webs";
import type { WebappManager } from "../webs";
import { t } from "../../support/i18n/main-i18n";
import { publishPluginAgent, removePluginAgent, type PluginAgentOwnership } from "./agent-resources";

type AgentPlatformCaller = (app: App, path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;
export type PluginResourceDesiredStatus = "running" | "stopped";

type PluginResourceOwnership = {
  webapps?: Record<string, { updatedAt: string }>;
  agents?: Record<string, PluginAgentOwnership>;
  automations?: Record<string, { updatedAt: string; platformId?: string }>;
  desiredStatus?: PluginResourceDesiredStatus;
  pendingAgentPlatformSync?: boolean;
  pendingAgentPlatformRemoval?: boolean;
  lastError?: string;
};

let callAgentPlatformCallback: AgentPlatformCaller | null = null;
const resourceOperations = new Map<string, Promise<unknown>>();

// Ready notifications can race user stop/uninstall while an automation API is
// pending. Serialize the whole operation, not just ownership file writes.
function serializeResources<T>(app: App, service: ServiceDefinition, operation: () => Promise<T>): Promise<T> {
  const key = getOwnershipPath(app, service.id);
  const previous = resourceOperations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  resourceOperations.set(key, next);
  void next.finally(() => { if (resourceOperations.get(key) === next) resourceOperations.delete(key); }).catch(() => undefined);
  return next;
}

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

function hasResourcesToManage(app: App, service: ServiceDefinition) {
  // An upgrade may remove the last declared Agent. Its existing ownership
  // still needs reconciliation even when the new manifest is empty.
  if (hasResources(service)) return true;
  const ownership = readOwnership(app, service.id);
  return hasOwnedResources(ownership) || Boolean(ownership.pendingAgentPlatformSync || ownership.pendingAgentPlatformRemoval);
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
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Do not turn a committed record into a rollback. */ }
  }
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

async function installWebappResources(
  app: App,
  service: ServiceDefinition,
  pluginDir: string,
  manager: WebappManager
) {
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
    await manager.installPackageDirectory(app, sourceDir, {
      expectedId: webapp.id,
      source: "local",
      recordInstallation: false
    });
    ownership.webapps[webapp.id] = { updatedAt: nowIso() };
    writeOwnership(app, service.id, ownership);
  }
}

async function removeWebappResources(
  app: App,
  service: ServiceDefinition,
  ownership: PluginResourceOwnership,
  options: { preserveUserData?: boolean } = {},
  manager: WebappManager = webappManager
) {
  const webappsRoot = getDesktopWebappsDataRoot(app);
  for (const webappId of Object.keys(ownership.webapps ?? {})) {
    const disposed = await manager.dispose(
      app,
      {
        id: webappId,
        label: `plugin WebApp ${webappId}`,
        installPath: path.join(webappsRoot, webappId),
        preserveUserData: options.preserveUserData
      },
      t("pluginResources.webappRemoved")
    );
    if (!disposed.ok) {
      throw new Error(disposed.message);
    }
  }
}

function normalizeAutomationPayload(automation: ServiceDefinition["resources"]["automations"][number]) {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description ?? "",
    cron: automation.cron,
    agentKey: automation.agentKey,
    enabled: automation.enabled !== false,
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
  } catch (error) {
    if (!isAutomationNotFound(error)) throw error;
    const detail = await callAgentPlatform(app, "/api/automation/create", payload);
    return readPlatformAutomationId(detail) || platformId || automation.id;
  }
}

function isAutomationNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const response = error as { status?: unknown; platformCode?: unknown; platformMessage?: unknown };
  // The current Automation HTTP contract has no separate business error code.
  // Match its explicit response, never a timeout or a generic route-level 404.
  return response.status === 404 && response.platformCode === 404 && response.platformMessage === "automation not found";
}

async function deleteAutomationResource(app: App, platformId: string) {
  try {
    await callAgentPlatform(app, "/api/automation/delete", { id: platformId });
  } catch (error) {
    if (!isAutomationNotFound(error)) throw error;
  }
}

async function syncAgentPlatformResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  ownership.agents = ownership.agents ?? {};
  ownership.automations = ownership.automations ?? {};
  ownership.desiredStatus = "running";
  try {
    for (const agent of service.resources.agents) {
      publishPluginAgent(app, agent, ownership.agents[agent.key], record => {
        const next = { ...ownership, agents: { ...ownership.agents, [agent.key]: { ...record, pluginVersion: service.version } } };
        writeOwnership(app, service.id, next);
        Object.assign(ownership, next);
      });
    }
    const declaredAgents = new Set(service.resources.agents.map(agent => agent.key));
    for (const [agentKey, record] of Object.entries(ownership.agents)) {
      if (declaredAgents.has(agentKey)) continue;
      removePluginAgent(app, agentKey, record, undefined, () => {
        const agents = { ...ownership.agents };
        delete agents[agentKey];
        const next = { ...ownership, agents };
        writeOwnership(app, service.id, next);
        Object.assign(ownership, next);
      });
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
      writeOwnership(app, service.id, ownership);
    }
    ownership.pendingAgentPlatformSync = false;
    ownership.pendingAgentPlatformRemoval = false;
    delete ownership.lastError;
  } catch (error) {
    ownership.pendingAgentPlatformSync = true;
    ownership.pendingAgentPlatformRemoval = false;
    ownership.lastError = error instanceof Error ? error.message : String(error);
    writeOwnership(app, service.id, ownership);
    throw error;
  }
  writeOwnership(app, service.id, ownership);
}

async function removeAgentPlatformResources(app: App, service: ServiceDefinition) {
  const ownership = readOwnership(app, service.id);
  ownership.desiredStatus = "stopped";
  try {
    for (const [automationId, record] of Object.entries(ownership.automations ?? {})) {
      await deleteAutomationResource(app, record.platformId || automationId);
      delete ownership.automations![automationId];
      writeOwnership(app, service.id, ownership);
    }
    for (const [agentKey, record] of Object.entries(ownership.agents ?? {})) {
      removePluginAgent(app, agentKey, record, service.resources.agents.find(agent => agent.key === agentKey), () => {
        const agents = { ...ownership.agents };
        delete agents[agentKey];
        const next = { ...ownership, agents };
        writeOwnership(app, service.id, next);
        Object.assign(ownership, next);
      });
    }
    ownership.pendingAgentPlatformRemoval = false;
    ownership.pendingAgentPlatformSync = false;
    delete ownership.lastError;
  } catch (error) {
    ownership.pendingAgentPlatformRemoval = true;
    ownership.pendingAgentPlatformSync = false;
    ownership.lastError = error instanceof Error ? error.message : String(error);
    writeOwnership(app, service.id, ownership);
    throw error;
  }
  writeOwnership(app, service.id, ownership);
}

export function configurePluginResources(options: { callAgentPlatform?: AgentPlatformCaller | null }) {
  callAgentPlatformCallback = options.callAgentPlatform ?? null;
}

export function initializePluginResourceState(app: App, service: ServiceDefinition) {
  if (service.kind !== "plugin" || !hasResourcesToManage(app, service)) {
    return "stopped" satisfies PluginResourceDesiredStatus;
  }
  return ensureDesiredStatus(app, service);
}

export function readPluginResourceDesiredStatus(app: App, service: ServiceDefinition) {
  if (service.kind !== "plugin" || !hasResourcesToManage(app, service)) {
    return "stopped" satisfies PluginResourceDesiredStatus;
  }
  return ensureDesiredStatus(app, service);
}

export async function syncPluginResources(
  app: App,
  service: ServiceDefinition,
  pluginDir: string,
  manager: WebappManager = webappManager
) {
  return serializeResources(app, service, async () => {
    if (service.kind !== "plugin" || !hasResourcesToManage(app, service)) {
      return { ok: true, message: t("pluginResources.noneDeclared") };
    }
    updateDesiredStatus(app, service, "running");
    await installWebappResources(app, service, pluginDir, manager);
    await syncAgentPlatformResources(app, service);
    return { ok: true, message: t("pluginResources.synced") };
  });
}

export async function stopPluginResources(
  app: App,
  service: ServiceDefinition,
  manager: WebappManager = webappManager
) {
  return serializeResources(app, service, async () => {
    if (service.kind !== "plugin" || !hasResourcesToManage(app, service)) {
      return { ok: true, message: t("pluginResources.noneDeclared") };
    }
    const ownership = updateDesiredStatus(app, service, "stopped", {
      pendingAgentPlatformSync: false
    });
    await removeWebappResources(app, service, ownership, { preserveUserData: true }, manager);
    await removeAgentPlatformResources(app, service);
    return { ok: true, message: t("pluginResources.uninstalled") };
  });
}

export async function retryPendingPluginResourceSync(app: App) {
  const errors: unknown[] = [];
  for (const service of getAllServices()) {
    if (service.kind !== "plugin") {
      continue;
    }
    try {
      if (!hasResourcesToManage(app, service)) continue;
      await serializeResources(app, service, async () => {
        // Read after queued stop/uninstall, never replay a stale running intent.
        const ownership = readOwnership(app, service.id);
        const desiredStatus = resolveDesiredStatus(ownership);
        if (desiredStatus === "running" && (ownership.pendingAgentPlatformSync || ownership.pendingAgentPlatformRemoval)) {
          await syncAgentPlatformResources(app, service);
        } else if (desiredStatus === "stopped" && ownership.pendingAgentPlatformRemoval) {
          await removeAgentPlatformResources(app, service);
        }
      });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Plugin resource retry failed");
}

export async function removePluginResources(app: App, service: ServiceDefinition, manager: WebappManager) {
  return serializeResources(app, service, async () => {
    const ownership = updateDesiredStatus(app, service, "stopped", { pendingAgentPlatformSync: false });
    await removeWebappResources(app, service, ownership, {}, manager);
    await removeAgentPlatformResources(app, service);
    // Any failure above leaves both the plugin and its cleanup record installed.
    fs.rmSync(getOwnershipPath(app, service.id), { force: true });
  });
}

export const __testInternals = {
  resolvePluginResourceDir,
  readOwnership,
  writeOwnership,
  readPluginResourceDesiredStatus,
  normalizeAutomationPayload
};
