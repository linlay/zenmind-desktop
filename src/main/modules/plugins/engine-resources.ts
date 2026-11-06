import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { App } from "electron";
import { getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import { restrictDirectoryToCurrentUser } from "../credentials";
import { getAllServices } from "../services";
import type { EngineInstallation, ManagementStatus, SyncAck, EngineDirectory } from "../../../shared/contracts/agent-engine";
import { serializePluginOperation } from "./lifecycle-queue";
import { readCurrentAgentEngineDelivery, getAgentEngineDeliveryRoot } from "./agent-engines";

type Ports = {
  getHostId: (app: App) => string;
  getBaseUrl: (app: App) => Promise<string>;
  getDirectory?: (app: App) => Promise<EngineDirectory>;
  onChanged?: () => void;
};
const runtimes = new WeakMap<App, ReturnType<typeof createRuntime>>();
export function createAgentEngineSync(app: App, ports: Ports) {
  let runtime = runtimes.get(app);
  if (!runtime) {
    runtime = createRuntime(app, ports);
    runtimes.set(app, runtime);
  }
  return runtime;
}
export function getAgentEngineSync(app: App) {
  return runtimes.get(app);
}

type DesiredState = {
  revision: number;
  signature: string;
  intent: Record<string, "enabled" | "disabled" | "removed">;
};
function createRuntime(app: App, ports: Ports) {
  const stateFile = path.join(getDesktopStateRoot(app), "agent-engine-sync.json");
  let state: DesiredState = { revision: 0, signature: "", intent: {} };
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as DesiredState;
    if (!Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.signature !== "string" ||
      !state.intent || typeof state.intent !== "object" || Array.isArray(state.intent) || Object.values(state.intent).some(value => !["enabled", "disabled", "removed"].includes(value))) {
      throw new Error("Invalid engine synchronization state");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let appliedRevision = -1;
  let appliedEntries: EngineInstallation[] = [];
  let appliedEpoch = "";
  let lastError = "";
  let directory: EngineDirectory | undefined;
  let directoryGeneration = 0;
  let publishedState = "";
  let desktopUpdating = false;
  function notifyChanged() {
    const next = JSON.stringify({ state, appliedRevision, lastError, directory });
    if (next === publishedState) return;
    publishedState = next;
    ports.onChanged?.();
  }
  async function refreshDirectory() {
    const generation = ++directoryGeneration;
    if (!ports.getDirectory || !authority) return;
    try {
      const next = await ports.getDirectory(app);
      if (generation !== directoryGeneration) return;
      // A directory push can arrive before the matching publication ACK. Keep
      // confirmed observations until that ACK; never expose unconfirmed entries.
      if (next.apiVersion === 1 && next.ready === true && appliedRevision >= 0 &&
        next.revision === state.revision && next.revision > appliedRevision) return;
      directory = next.apiVersion === 1 && next.ready === true && next.revision === appliedRevision && Array.isArray(next.engines) ? next : undefined;
      if (next.apiVersion === 1 && next.ready === false) appliedRevision = -1;
    } catch {
      if (generation !== directoryGeneration) return;
      directory = undefined;
    }
    notifyChanged();
  }
  function invalidateDirectory() {
    directoryGeneration++;
    directory = undefined;
  }
  function persist(next: DesiredState) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, stateFile);
      state = next;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  function desiredEntries() {
    const entries: EngineInstallation[] = [];
    const services = getAllServices();
    const discovered = new Set(services.map(service => service.id));
    // A loader error must not masquerade as an intentional uninstall.
    const previous = JSON.parse(state.signature || "[]") as EngineInstallation[];
    for (const entry of previous) {
      if (!discovered.has(entry.pluginId) && state.intent[entry.pluginId] !== "removed") throw new Error("artifact_untrusted");
    }
    for (const service of services) {
      if (service.kind !== "plugin" || !service.resources.agentEngines?.length || state.intent[service.id] === "removed") continue;
      const current = readCurrentAgentEngineDelivery(app, service.id);
      if (!current || current.record.ownerHostId !== ports.getHostId(app) || current.record.pluginVersion !== service.version) throw new Error("artifact_untrusted");
      for (const engine of current.manifest.resources!.agentEngines!) entries.push({
        engineId: `${service.id}/${engine.id}`, pluginId: service.id, pluginVersion: current.record.pluginVersion,
        installationRef: current.record.installationRef, artifactDigest: current.record.artifactDigest, enabled: !desktopUpdating && state.intent[service.id] === "enabled"
      });
    }
    return entries.sort((a, b) => a.engineId < b.engineId ? -1 : a.engineId > b.engineId ? 1 : 0);
  }
  async function request<T>(session: NonNullable<typeof authority>, route: string, epoch?: string, body?: unknown): Promise<T> {
    const base = new URL(await ports.getBaseUrl(app));
    if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password) throw new Error("unsupported_deployment");
    const response = await fetch(new URL(`/api/desktop/agent-engines${route}`, base), {
      // Publication includes importing the archive and a bounded ACP handshake.
      method: body === undefined ? "GET" : "PUT", redirect: "error", signal: AbortSignal.timeout(body === undefined ? 5000 : 30000),
      headers: { Authorization: `ZenMindEngine ${session.secret}`, "X-ZenMind-Desktop-Host": session.hostId, ...(epoch ? { "X-ZenMind-Engine-Epoch": epoch } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    if (text.length > 1 << 20) throw new Error("engine_sync_unavailable");
    const payload = JSON.parse(text);
    if (!response.ok || payload.code !== 200) {
      const code = ["dependency_missing", "engine_unavailable", "artifact_untrusted", "artifact_digest_mismatch", "management_epoch_mismatch", "revision_conflict", "revision_stale", "registry_not_ready", "unsupported_deployment"].includes(payload.data?.errorCode) ? payload.data.errorCode : "engine_sync_unavailable";
      // A rejected atomic publication leaves the last confirmed directory intact.
      throw Object.assign(new Error(code), { publicationRejected: route === "/snapshot" &&
        ["dependency_missing", "engine_unavailable", "artifact_untrusted", "artifact_digest_mismatch"].includes(code) });
    }
    return payload.data as T;
  }
  async function synchronize() {
    try {
      const entries = desiredEntries();
      const signature = JSON.stringify(entries);
      const revision = state.revision + (signature !== state.signature ? 1 : 0);
      if (!Number.isSafeInteger(revision) || revision < 1 || entries.length > 256) throw new Error("invalid_engine_revision");
      if (signature !== state.signature) {
        directoryGeneration++;
        persist({ ...state, revision, signature });
      }
      const session = authority;
      if (!session) throw new Error("engine_sync_unavailable");
      const status = await request<ManagementStatus>(session, "/status");
      if (authority !== session) return;
      if (status.appliedRevision < 0 || status.apiVersion !== 1 || status.hostId !== session.hostId || !status.epoch || !Number.isSafeInteger(status.appliedRevision)) throw new Error("engine_sync_unavailable");
      if (status.appliedRevision > state.revision) throw new Error("revision_stale");
      if (!status.ready || status.epoch !== appliedEpoch || status.appliedRevision !== appliedRevision) {
        appliedRevision = -1;
        invalidateDirectory();
      }
      // Full snapshots also repair lost notifications and a fresh Platform epoch.
      const ack = await request<SyncAck>(session, "/snapshot", status.epoch, { apiVersion: 1, revision: state.revision, entries });
      if (authority !== session) return;
      if (ack.apiVersion !== 1 || ack.appliedRevision !== state.revision || ack.ready !== true || !["applied", "idempotent"].includes(ack.action)) throw new Error("engine_sync_unavailable");
      appliedRevision = state.revision;
      appliedEntries = entries;
      appliedEpoch = status.epoch;
      lastError = "";
      await refreshDirectory();
      return ack;
    } catch (error) {
      if (!(error instanceof Error && "publicationRejected" in error && error.publicationRejected === true) || appliedRevision < 0) {
        appliedRevision = -1;
        invalidateDirectory();
      }
      lastError = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "engine_sync_unavailable";
    }
    notifyChanged();
  }

  let bootstrapDirectory: string | undefined;
  function clearBootstrap() {
    if (bootstrapDirectory) fs.rmSync(bootstrapDirectory, { recursive: true, force: true });
    bootstrapDirectory = undefined;
  }
  let authority: { secret: string; hostId: string } | undefined;
  return {
    // Use the same retirement/lease acknowledgement as plugin removal. Keep
    // user intent intact; a reconnect must not reopen admission during cleanup.
    prepareDesktopUpdate: () => serializePluginOperation(app, async () => {
      if (desktopUpdating || !authority) throw new Error("updateBusy");
      desktopUpdating = true;
      try {
        let deadline: number | undefined;
        for (;;) {
          const ack = await synchronize();
          if (!ack || !Array.isArray(ack.drainingEngineIds)) throw new Error("updateBusy");
          if (ack.drainingEngineIds.length === 0) break;
          deadline ??= Date.now() + 2000;
          // Idle adapters retire asynchronously. Active work is never cancelled
          // to meet this deadline; the existing update UI can explicitly retry.
          if (Date.now() >= deadline) throw new Error("updateBusy");
          await delay(100);
        }
      } catch (error) {
        desktopUpdating = false;
        await synchronize();
        throw error;
      }
      return () => serializePluginOperation(app, async () => {
        desktopUpdating = false;
        await synchronize();
      });
    }),
    // Installation already holds the shared lifecycle queue.
    async installed(pluginId: string) {
      if (state.intent[pluginId] === "removed") persist({ ...state, intent: { ...state.intent, [pluginId]: "disabled" } });
      await synchronize();
    },
    reconcile: () => serializePluginOperation(app, async () => {
      await synchronize();
      if (bootstrapDirectory && !fs.existsSync(path.join(bootstrapDirectory, "bootstrap.json"))) clearBootstrap();
    }),
    setEnabled: (pluginId: string, enabled: boolean) => serializePluginOperation(app, async () => {
      persist({ ...state, intent: { ...state.intent, [pluginId]: enabled ? "enabled" : "disabled" } });
      await synchronize();
    }),
    refreshDirectory,
    disconnected() {
      appliedRevision = -1;
      invalidateDirectory();
      notifyChanged();
    },
    status(pluginId: string) {
      const desired = (JSON.parse(state.signature || "[]") as EngineInstallation[]).filter(entry => entry.pluginId === pluginId);
      const confirmed = appliedEntries.filter(entry => entry.pluginId === pluginId);
      const applied = appliedRevision >= 0 && Boolean(authority) && JSON.stringify(desired) === JSON.stringify(confirmed);
      const engines = applied ? directory?.engines.filter(engine => engine.pluginId === pluginId) ?? [] : [];
      // Plugins may declare multiple engines. Show a non-ready state before a ready one.
      const aggregate = (key: "dependencyState" | "authState" | "runtimeState", ready: string) =>
        engines.find(engine => engine[key] !== ready)?.[key] ?? engines[0]?.[key] ?? "unknown";
      return {
        desired: state.intent[pluginId] ?? "disabled",
        syncState: applied ? "applied" as const : "pending" as const,
        revision: applied ? appliedRevision : state.revision,
        dependencyState: !applied && lastError === "dependency_missing" ? "missing" : aggregate("dependencyState", "ready"),
        authState: aggregate("authState", "authenticated"),
        runtimeState: aggregate("runtimeState", "stopped"),
        lastError: applied ? "" : lastError
      };
    },
    // Called inside the plugin lifecycle transaction, before any package deletion.
    async revoke(pluginId: string) {
      persist({ ...state, intent: { ...state.intent, [pluginId]: "removed" } });
      const ack = await synchronize();
      if (ack?.drainingEngineIds.some(id => id.startsWith(`${pluginId}/`))) return { ok: false, message: "engine_busy" };
      return { ok: appliedRevision === state.revision && Boolean(authority), message: lastError || undefined };
    },
    hasAuthority: () => Boolean(authority),
    stopped() {
      desktopUpdating = false;
      clearBootstrap();
      authority = undefined;
      appliedRevision = -1;
      invalidateDirectory();
      notifyChanged();
    },
    async prepareLaunch() {
      clearBootstrap();
      if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("unsupported_deployment");
      const deliveryRoot = getAgentEngineDeliveryRoot(app);
      fs.mkdirSync(deliveryRoot, { recursive: true, mode: 0o700 });
      restrictDirectoryToCurrentUser(deliveryRoot);
      const stateRoot = getDesktopStateRoot(app);
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const temporary = fs.mkdtempSync(path.join(stateRoot, "agent-engine-launch-"));
      const file = path.join(temporary, "bootstrap.json");
      const next = { secret: randomBytes(32).toString("hex"), hostId: ports.getHostId(app) };
      try {
        restrictDirectoryToCurrentUser(temporary);
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, hostId: next.hostId, launchNonce: randomUUID(), managementSecret: next.secret, deliveryRoot }), { flag: "wx", mode: 0o600 });
        bootstrapDirectory = temporary;
        authority = next;
        appliedRevision = -1;
        invalidateDirectory();
        return { args: ["--agent-engine-bootstrap-file", file], complete(success: boolean) {
          if (!success && authority === next) authority = undefined;
          // A daemon launcher can exit before Platform reads its one-use file.
          // Readiness reconciliation (or stopped) owns successful-launch cleanup.
          if (!success) clearBootstrap();
        } };
      } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    }
  };
}
