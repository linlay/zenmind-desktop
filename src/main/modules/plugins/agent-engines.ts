import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type { TrustedDeliveryRecord, DeliverySource } from "../../../shared/contracts/agent-engine";
import { readManifestFile } from "../../support/manifest/manifest-utils";
import type { ServiceDefinition } from "../../support/manifest/manifest-utils";
import { getDesktopRoot, getServiceStateRoot } from "../../infrastructure/filesystem/user-paths";

export interface PluginEngineHost {
  getHostId: (app: App) => string;
  prepareNodeRuntime: (app: App) => Promise<{ node: string; nodeVersion: string; arch: string }>;
  /** ACP-004 supplies the authenticated Platform revoke acknowledgement. */
  revoke?: (app: App, pluginId: string, installationRefs: string[]) => Promise<{ ok: boolean; message?: string }>;
}

export interface PluginInstallSource {
  kind: "market";
  authorizationRef: string;
  archiveDigest: string;
  pluginId: string;
  pluginVersion: string;
}

export function getAgentEngineDeliveryRoot(app: App) {
  return path.join(getDesktopRoot(app), "data", "agent-engines");
}

function deliveryPointer(app: App, pluginId: string) {
  return path.join(getServiceStateRoot(app, pluginId, "plugin"), "agent-engine-delivery.json");
}

/** Only committed delivery metadata is discoverable; staged program folders have no authority. */
export function readCurrentAgentEngineDelivery(app: App, pluginId: string) {
  const pointer = deliveryPointer(app, pluginId);
  if (!fs.existsSync(pointer)) return null;
  if (fs.lstatSync(pointer).isSymbolicLink()) throw new Error("Untrusted engine delivery pointer");
  const current = JSON.parse(fs.readFileSync(pointer, "utf8")) as { installationRef: string; artifactDigest: string };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(current.installationRef) || !/^sha256:[a-f0-9]{64}$/u.test(current.artifactDigest)) throw new Error("Invalid engine delivery pointer");
  const root = getAgentEngineDeliveryRoot(app);
  packageFile(root, current.installationRef, true);
  const file = packageFile(root, `${current.installationRef}/record.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as TrustedDeliveryRecord;
  if (record.installationRef !== current.installationRef || record.artifactDigest !== current.artifactDigest || record.pluginId !== pluginId) throw new Error("Engine delivery identity mismatch");
  const manifest = readManifestFile(packageFile(root, `${current.installationRef}/package/manifest.json`));
  if (manifest.pluginApiVersion !== 2 || !manifest.resources?.agentEngines?.length || manifest.id !== pluginId || manifest.version !== record.pluginVersion) throw new Error("Invalid committed engine manifest");
  return { record, manifest };
}

/** Same bytes as Go RuntimeFingerprint; include directories, modes and all dependencies. */
export function agentEngineFingerprint(root: string): string {
  const hash = createHash("sha256");
  function visit(absolute: string, relative: string) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Untrusted engine package file type");
    const mode = (stat.mode & 0o777) + (stat.isDirectory() ? 0x80000000 : 0);
    hash.update(`${relative}\0${mode}\0`);
    if (stat.isFile()) hash.update(fs.readFileSync(absolute));
    hash.update("\0");
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        visit(path.join(absolute, entry), relative === "." ? entry : `${relative}/${entry}`);
      }
    }
  }
  visit(root, ".");
  return `sha256:${hash.digest("hex")}`;
}

function packageFile(root: string, relative: string, directory: boolean | null = false) {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Engine dependency path escapes package");
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || (directory === null ? !stat.isDirectory() && !stat.isFile() : directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Engine dependency is missing or unsafe: ${relative}`);
  return absolute;
}

// Bundle contents are pinned by the trusted tree digest. Package-manager
// metadata belongs to the plugin build, not the host's ACP installation protocol.
function validateEngineDependencies(service: ServiceDefinition, root: string, runtime?: { node: string; nodeVersion: string; arch: string }) {
  for (const engine of service.resources.agentEngines) {
    const entry = packageFile(root, engine.launch.entry);
    if (engine.launch.runtime === "executable") {
      if (service.platform?.os === "windows") {
        if (!entry.toLowerCase().endsWith(".exe")) throw new Error("Windows engine entry must be an executable .exe");
      } else if (service.platform?.os === "darwin") {
        if (!(fs.statSync(entry).mode & 0o111)) throw new Error("Engine entry is not executable");
      }
    }
    let hasNode = false;
    for (const dependency of engine.dependencies) {
      if (dependency.delivery === "host-managed") {
        if (dependency.id !== "node" || dependency.path || dependency.entry || !runtime) throw new Error(`Unsupported managed engine dependency: ${dependency.id}`);
        const arch = runtime.arch === "x64" ? "amd64" : runtime.arch;
        if (!path.isAbsolute(runtime.node) || !fs.statSync(runtime.node).isFile() || arch !== service.platform?.arch || dependency.version !== runtime.nodeVersion) throw new Error("Engine Node runtime dependency version/architecture mismatch");
        hasNode = true;
      } else {
        if (!dependency.path) throw new Error(`Engine bundled dependency path is missing: ${dependency.id}`);
        const absolute = path.resolve(root, dependency.path);
        packageFile(root, dependency.path, null);
        if (dependency.entry) {
          const executable = packageFile(root, dependency.entry);
          if (executable !== absolute && !executable.startsWith(`${absolute}${path.sep}`)) throw new Error("Engine dependency entry escapes its declared package");
        }
      }
    }
    if (engine.launch.runtime === "node" && !hasNode) throw new Error("Engine Node runtime dependency is missing");
  }
}

export async function prepareAgentEngineDelivery(
  app: App, service: ServiceDefinition, packageDir: string, archiveDigest: string,
  host: PluginEngineHost | undefined, source?: PluginInstallSource
) {
  if (!host) throw new Error("Agent engine installation requires composition-root host ports");
  const ownerHostId = host.getHostId(app);
  if (!ownerHostId) throw new Error("Engine host identity is unavailable");
  const needsNode = service.resources.agentEngines.some(engine => engine.launch.runtime === "node" || engine.dependencies.some(dependency => dependency.delivery === "host-managed" && dependency.id === "node"));
  const runtime = needsNode ? await host.prepareNodeRuntime(app) : undefined;
  agentEngineFingerprint(packageDir);
  validateEngineDependencies(service, packageDir, runtime);
  const installationRef = randomUUID();
  const root = getAgentEngineDeliveryRoot(app);
  for (const directory of [path.dirname(root), root]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Untrusted engine delivery root");
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(root, ".stage-"));
  const target = path.join(root, installationRef);
  let committed = false;
  try {
    fs.cpSync(packageDir, path.join(stage, "package"), { recursive: true });
    const artifactDigest = agentEngineFingerprint(path.join(stage, "package"));
    const deliverySource: DeliverySource = source
      ? { kind: "market", authorizationRef: source.authorizationRef, archiveDigest }
      : { kind: "local-import", authorizationRef: `local-import:${installationRef}`, archiveDigest };
    const record: TrustedDeliveryRecord = {
      schemaVersion: 1, installationRef, ownerHostId, pluginId: service.id, pluginVersion: service.version,
      platform: service.platform as TrustedDeliveryRecord["platform"], artifactDigest, source: deliverySource
    };
    fs.writeFileSync(path.join(stage, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return {
      commit() {
        fs.renameSync(stage, target);
        const pointer = deliveryPointer(app, service.id);
        fs.mkdirSync(path.dirname(pointer), { recursive: true });
        const temporary = `${pointer}.${installationRef}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ installationRef, artifactDigest }), { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, pointer);
          committed = true;
        } finally { fs.rmSync(temporary, { force: true }); }
      },
      dispose() {
        fs.rmSync(stage, { recursive: true, force: true });
        if (!committed) fs.rmSync(target, { recursive: true, force: true });
      }
    };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}

export async function revokeAgentEngineDeliveries(app: App, service: ServiceDefinition, host?: PluginEngineHost) {
  if (!host?.revoke) throw new Error("Engine revocation acknowledgement is unavailable until Platform sync is connected");
  const root = getAgentEngineDeliveryRoot(app);
  const hostId = host.getHostId(app);
  const records: TrustedDeliveryRecord[] = [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Untrusted engine delivery root");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(root, entry.name, "record.json");
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Untrusted engine delivery record");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as TrustedDeliveryRecord;
    if (record.pluginId !== service.id) continue;
    if (record.ownerHostId !== hostId || record.installationRef !== entry.name) throw new Error("Engine delivery ownership mismatch");
    records.push(record);
  }
  if (!records.length) throw new Error("Engine delivery ownership is unavailable");
  const ack = await host.revoke(app, service.id, records.map(record => record.installationRef));
  if (!ack?.ok) throw new Error(ack?.message || "Engine revocation was not acknowledged");
  // Platform executes its own immutable copies. Never touch ru-agent-engines or profiles.
  return () => {
    for (const record of records) fs.rmSync(path.join(root, record.installationRef), { recursive: true, force: true });
    fs.rmSync(deliveryPointer(app, service.id), { force: true });
  };
}
