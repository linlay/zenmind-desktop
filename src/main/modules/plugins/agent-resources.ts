import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import type { App } from "electron";
import type { ServiceDefinition } from "../../support/manifest/manifest-utils";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-env-paths";

type AgentResource = ServiceDefinition["resources"]["agents"][number];
export type PluginAgentOwnership = { updatedAt: string; digest?: string; installationId?: string; pluginVersion?: string };
const OWNER_FILE = ".desktop-plugin-agent.json";

function exists(file: string) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe plugin Agent directory: ${directory}`);
}

function parseAgentDefinition(content: string, source: string) {
  try { return yaml.load(content); } catch {
    // YAML diagnostics include source lines; do not log unrelated Agent config.
    throw new Error(`Cannot inspect plugin Agent source identity: ${source}`);
  }
}

function agentLocation(app: App, key: string) {
  // Portable identities also reject Windows device names and trailing dots.
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(key) || key.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(key)) {
    throw new Error(`Invalid plugin Agent key: ${key}`);
  }
  const runtime = resolveRuntimeRoot(app);
  fs.mkdirSync(runtime, { recursive: true });
  assertDirectory(runtime);
  const root = path.join(runtime, "agents");
  if (!exists(root)) fs.mkdirSync(root);
  assertDirectory(root);
  // Protect flat YAML sources as well as directories, including case aliases on
  // the default macOS filesystem and Windows. No source is adopted by its name.
  for (const name of fs.readdirSync(root)) {
    if (name === key) continue;
    if (name.toLowerCase() === key.toLowerCase() || name.replace(/\.ya?ml$/iu, "").toLowerCase() === key.toLowerCase()) {
      throw new Error(`Plugin Agent conflicts with an existing source: ${name}`);
    }
    if (/\.ya?ml$/iu.test(name) && !name.startsWith(".")) {
      const file = path.join(root, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe Agent source: ${file}`);
      const value = parseAgentDefinition(fs.readFileSync(file, "utf8"), file) as { key?: unknown } | null;
      if (typeof value?.key === "string" && value.key.toLowerCase() === key.toLowerCase()) {
        throw new Error(`Plugin Agent conflicts with an existing source: ${name}`);
      }
    }
  }
  return { root, target: path.join(root, key) };
}

function agentFiles(agent: AgentResource): Record<string, string> {
  if (agent.definition.key !== undefined && agent.definition.key !== agent.key) {
    throw new Error(`Plugin Agent definition key must match its directory: ${agent.key}`);
  }
  return {
    "agent.yml": yaml.dump({ ...agent.definition, key: agent.key }, { noRefs: true, lineWidth: 120 }),
    ...(agent.soulPrompt ? { "SOUL.md": agent.soulPrompt } : {}),
    ...(agent.agentsPrompt ? { "AGENTS.md": agent.agentsPrompt } : {})
  };
}

function digestFiles(files: Record<string, string | Buffer>) {
  return createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map(name => [name, Buffer.from(files[name]).toString("base64")]))).digest("hex");
}

function readAgentFiles(directory: string) {
  assertDirectory(directory);
  const files: Record<string, Buffer> = {};
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    // A plugin only owns the files it delivered. Extra files, subdirectories or
    // links mean the source was changed externally and must be preserved.
    if (!["agent.yml", "SOUL.md", "AGENTS.md", OWNER_FILE].includes(name) || !fs.lstatSync(file).isFile()) {
      throw new Error(`Plugin Agent contains unowned content: ${file}`);
    }
    files[name] = fs.readFileSync(file);
  }
  return files;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => canonical(item)));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return JSON.stringify(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return JSON.stringify(value);
}

function assertOwned(directory: string, owned: PluginAgentOwnership | undefined, agent?: AgentResource) {
  if (!owned) throw new Error(`Plugin Agent source is not owned by this plugin: ${directory}`);
  const files = readAgentFiles(directory);
  const digest = digestFiles(files);
  if (owned.digest === digest) return digest;
  // Old API installations had only a timestamp. Adopt only an exact manifest
  // match (ignoring YAML formatting), never an unknown or user-edited source.
  if (!owned.digest && agent && !files[OWNER_FILE]) {
    const expected = agentFiles(agent);
    if (canonical(parseAgentDefinition(files["agent.yml"]?.toString("utf8") || "", directory)) === canonical(yaml.load(expected["agent.yml"])) &&
        (files["SOUL.md"]?.toString("utf8") || "") === (expected["SOUL.md"] || "") &&
        (files["AGENTS.md"]?.toString("utf8") || "") === (expected["AGENTS.md"] || "")) return digest;
  }
  throw new Error(`Plugin Agent source has changed or its ownership cannot be verified: ${directory}`);
}

function moveDirectory(source: string, target: string, platform: NodeJS.Platform = process.platform) {
  if (exists(target)) throw new Error(`Refusing to replace an unexpected Agent directory: ${target}`);
  if (platform === "win32") {
    // A watcher or another process may hold a Windows directory handle. Fail
    // without in-place deletion; keep ownership so an explicit retry is safe.
    try { fs.renameSync(source, target); } catch (error) {
      throw new Error(`Cannot move plugin Agent directory; release file handles and retry: ${source}`, { cause: error });
    }
  } else if (platform === "darwin") {
    fs.renameSync(source, target);
  } else {
    fs.renameSync(source, target);
  }
}

export function publishPluginAgent(app: App, agent: AgentResource, owned: PluginAgentOwnership | undefined,
  commit: (record: PluginAgentOwnership) => void) {
  const { root, target } = agentLocation(app, agent.key);
  const files = agentFiles(agent);
  const installationId = owned?.installationId || randomUUID();
  files[OWNER_FILE] = `${JSON.stringify({ installationId })}\n`;
  const digest = digestFiles(files);
  const previous = exists(target) ? assertOwned(target, owned, agent) : undefined;
  const record = { updatedAt: new Date().toISOString(), digest, installationId };
  if (previous === digest) { commit(record); return; }
  const stage = fs.mkdtempSync(path.join(root, ".desktop-plugin-agent-"));
  const backup = path.join(root, `.desktop-plugin-agent-backup-${randomUUID()}`);
  let movedOld = false;
  let published = false;
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(stage, name), content, { mode: 0o600, flag: "wx" });
    if (previous) {
      moveDirectory(target, backup);
      movedOld = true;
      if (digestFiles(readAgentFiles(backup)) !== previous) throw new Error(`Plugin Agent changed during publication: ${agent.key}`);
    }
    moveDirectory(stage, target);
    published = true;
    commit(record);
  } catch (error) {
    try {
      if (published) {
        if (digestFiles(readAgentFiles(target)) !== digest) throw new Error("Published Agent was modified externally");
        moveDirectory(target, stage);
      }
      if (movedOld) moveDirectory(backup, target);
    } catch (rollbackError) {
      throw new Error(`Plugin Agent rollback failed; preserve recovery directory ${backup}: ${String(rollbackError)}`, { cause: error });
    }
    throw error;
  } finally {
    // Staging holds only unpublished plugin files. Backups are never removed on
    // rollback failure, and are ignored by the Platform directory loader.
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* Retry can use a new staging directory. */ }
  }
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* Committed; retain hidden backup. */ }
}

export const __testInternals = { moveDirectory };

export function removePluginAgent(app: App, key: string, owned: PluginAgentOwnership, agent: AgentResource | undefined,
  commit: () => void) {
  const { root, target } = agentLocation(app, key);
  if (!exists(target)) { commit(); return; }
  const digest = assertOwned(target, owned, agent);
  const backup = path.join(root, `.desktop-plugin-agent-backup-${randomUUID()}`);
  moveDirectory(target, backup);
  try {
    if (digestFiles(readAgentFiles(backup)) !== digest) throw new Error(`Plugin Agent changed during removal: ${key}`);
    commit();
  } catch (error) {
    try { moveDirectory(backup, target); } catch (rollbackError) {
      throw new Error(`Plugin Agent removal rollback failed; preserve ${backup}: ${String(rollbackError)}`, { cause: error });
    }
    throw error;
  }
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* Source removed; preserve hidden backup. */ }
}
