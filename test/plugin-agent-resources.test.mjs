import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { resolveRuntimeRoot } = require("../dist-electron/main/infrastructure/filesystem/runtime-env-paths.js");
const { configurePluginResources, syncPluginResources, stopPluginResources, removePluginResources,
  __testInternals: state } = require("../dist-electron/main/modules/plugins/resources.js");
const { publishPluginAgent, __testInternals: files } = require("../dist-electron/main/modules/plugins/agent-resources.js");
const { uninstallPlugin, getPluginInstallDir } = require("../dist-electron/main/modules/plugins/loader.js");
const { registerPlugin, getService, __testInternals: registry } = require("../dist-electron/main/modules/services/service-registry.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-plugin-agent-"));
  const app = { getPath: name => path.join(root, name) };
  const service = { kind: "plugin", id: "test-plugin", resources: { webapps: [], automations: [], agents: [{
    key: "test-agent", definition: { name: "Test", mode: "GENERAL", modelConfig: { modelKey: "test-model" } },
    soulPrompt: "Be helpful.", agentsPrompt: "Project instructions."
  }] } };
  const target = path.join(resolveRuntimeRoot(app), "agents", "test-agent");
  configurePluginResources({ callAgentPlatform: null });
  t.after(() => { configurePluginResources({ callAgentPlatform: null }); registry.clearServices(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, service, target };
}

test("plugin Agent create, update, stop and restart work with Platform offline", async t => {
  const { root, app, service, target } = fixture(t);
  await syncPluginResources(app, service, root);
  assert.equal(yaml.load(fs.readFileSync(path.join(target, "agent.yml"), "utf8")).key, "test-agent");
  assert.equal(fs.readFileSync(path.join(target, "SOUL.md"), "utf8"), "Be helpful.");
  const first = state.readOwnership(app, service.id).agents["test-agent"];
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  service.resources.agents[0].definition.name = "Updated";
  await syncPluginResources(app, service, root);
  assert.equal(yaml.load(fs.readFileSync(path.join(target, "agent.yml"), "utf8")).name, "Updated");
  assert.equal(state.readOwnership(app, service.id).agents["test-agent"].installationId, first.installationId);
  await stopPluginResources(app, service);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(state.readOwnership(app, service.id).agents, {});
  await syncPluginResources(app, service, root);
  assert.notEqual(state.readOwnership(app, service.id).agents["test-agent"].installationId, first.installationId);
  await removePluginResources(app, service, {});
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(state.readOwnership(app, service.id), {});
  assert.equal(fs.existsSync(path.join(resolveRuntimeRoot(app), "ru-agents")), false);
});

test("same-name sources, user edits and extra content are preserved", async t => {
  const { root, app, service, target } = fixture(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "agent.yml"), "key: test-agent\nname: User\n");
  await assert.rejects(syncPluginResources(app, service, root), /not owned/);
  assert.match(fs.readFileSync(path.join(target, "agent.yml"), "utf8"), /User/);
  fs.rmSync(target, { recursive: true });
  await syncPluginResources(app, service, root);
  const original = fs.readFileSync(path.join(target, "agent.yml"), "utf8");
  fs.appendFileSync(path.join(target, "agent.yml"), "# user edit\n");
  await assert.rejects(syncPluginResources(app, service, root), /has changed/);
  await assert.rejects(removePluginResources(app, service, {}), /has changed/);
  assert.equal(state.readOwnership(app, service.id).pendingAgentPlatformRemoval, true);
  assert.equal(fs.existsSync(target), true);
  fs.writeFileSync(path.join(target, "agent.yml"), original);
  fs.writeFileSync(path.join(target, "user-notes.txt"), "keep");
  await assert.rejects(removePluginResources(app, service, {}), /unowned content/);
  assert.equal(fs.readFileSync(path.join(target, "user-notes.txt"), "utf8"), "keep");
});

test("old ownership cannot delete a later installation of identical Agent content", async t => {
  const { root, app, service, target } = fixture(t);
  await syncPluginResources(app, service, root);
  const old = state.readOwnership(app, service.id);
  await stopPluginResources(app, service);
  await syncPluginResources(app, service, root);
  state.writeOwnership(app, service.id, old);
  await assert.rejects(removePluginResources(app, service, {}), /has changed/);
  assert.equal(fs.existsSync(target), true);
});

test("legacy ownership adopts only matching YAML and never unknown defaults", async t => {
  const { root, app, service, target } = fixture(t);
  const agent = service.resources.agents[0];
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "agent.yml"), JSON.stringify({ key: agent.key, ...agent.definition }));
  fs.writeFileSync(path.join(target, "SOUL.md"), agent.soulPrompt);
  fs.writeFileSync(path.join(target, "AGENTS.md"), agent.agentsPrompt);
  state.writeOwnership(app, service.id, { agents: { [agent.key]: { updatedAt: "old" } } });
  await syncPluginResources(app, service, root);
  assert.ok(state.readOwnership(app, service.id).agents[agent.key].digest);
  state.writeOwnership(app, service.id, { agents: { [agent.key]: { updatedAt: "old" } } });
  await assert.rejects(removePluginResources(app, service, {}), /ownership cannot be verified/);
});

test("ownership commit failure restores previous Agent directory", async t => {
  const { root, app, service, target } = fixture(t);
  await syncPluginResources(app, service, root);
  const old = state.readOwnership(app, service.id).agents["test-agent"];
  const content = fs.readFileSync(path.join(target, "agent.yml"), "utf8");
  service.resources.agents[0].definition.name = "Rejected";
  assert.throws(() => publishPluginAgent(app, service.resources.agents[0], old, () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(fs.readFileSync(path.join(target, "agent.yml"), "utf8"), content);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["test-agent"]);
});

test("invalid keys, flat YAML identities and symlink sources fail closed", async t => {
  const { root, app, service, target } = fixture(t);
  for (const key of ["../escape", "CON", "nul.txt", "agent.", "a/b", "a\\b"]) {
    service.resources.agents[0].key = key;
    await assert.rejects(syncPluginResources(app, service, root), /Invalid.*key/);
  }
  service.resources.agents[0].key = "test-agent";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const flat = path.join(path.dirname(target), "different-file.yml");
  fs.writeFileSync(flat, "key: test-agent\n");
  await assert.rejects(syncPluginResources(app, service, root), /conflicts/);
  fs.rmSync(flat);
  const external = path.join(root, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, target, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(syncPluginResources(app, service, root), /not owned|Unsafe/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test("Windows sharing violations and macOS rename failures preserve sources", t => {
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error("held"), { code: "EPERM" }); };
    assert.throws(() => files.moveDirectory(source, target, "win32"), /release file handles/);
    assert.throws(() => files.moveDirectory(source, target, "darwin"), /held/);
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(target), false);
  } finally { fs.renameSync = rename; }
});

test("a held Agent directory leaves cleanup pending and can be removed on retry", async t => {
  const { root, app, service, target } = fixture(t);
  await syncPluginResources(app, service, root);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (source === target) throw Object.assign(new Error("directory held"), { code: "EPERM" });
      return rename(source, destination);
    };
    await assert.rejects(removePluginResources(app, service, {}), /directory held|release file handles/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(target), true);
  assert.equal(state.readOwnership(app, service.id).pendingAgentPlatformRemoval, true);
  await removePluginResources(app, service, {});
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(state.readOwnership(app, service.id), {});
});

test("failed removal record commit restores the source and preserves its ownership", async t => {
  const { root, app, service, target } = fixture(t);
  await syncPluginResources(app, service, root);
  const before = state.readOwnership(app, service.id).agents;
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, content, ...args) => {
      if (String(file).includes("plugin-resources.json.") && JSON.parse(String(content)).agents &&
          Object.keys(JSON.parse(String(content)).agents).length === 0) throw new Error("record unavailable");
      return write(file, content, ...args);
    };
    await assert.rejects(removePluginResources(app, service, {}), /record unavailable/);
  } finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(path.join(target, "agent.yml")), true);
  assert.deepEqual(state.readOwnership(app, service.id).agents, before);
  assert.equal(state.readOwnership(app, service.id).pendingAgentPlatformRemoval, true);
});

test("failed automation removal aborts production uninstall and successful items are not retried", async t => {
  const { root, app, service, target } = fixture(t);
  service.resources.automations = ["first", "second"].map(id => ({ id, name: id, cron: "* * * * *", agentKey: "test-agent", query: { message: "hi" } }));
  const installed = registerPlugin({ pluginApiVersion: 1, id: service.id, name: "Test", version: "v1.0.0",
    description: "Test", runtime: { requiredPaths: ["manifest.json"] }, resources: service.resources });
  const directory = getPluginInstallDir(app, installed.id, installed.version);
  fs.mkdirSync(directory, { recursive: true });
  let fail = true;
  const deletes = [];
  configurePluginResources({ callAgentPlatform: async (_app, endpoint, options) => {
    if (endpoint.endsWith("/create")) return { id: options.body.id };
    deletes.push(options.body.id);
    if (fail && options.body.id === "second") throw new Error("offline");
    return { deleted: true };
  } });
  await syncPluginResources(app, installed, root);
  const services = { getServiceState: async () => ({ status: "stopped" }), stopService: async () => ({ ok: true }) };
  await assert.rejects(uninstallPlugin(app, installed.id, services, {}), /offline/);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(getService(installed.id).id, installed.id);
  assert.deepEqual(Object.keys(state.readOwnership(app, installed.id).automations), ["second"]);
  fail = false;
  await uninstallPlugin(app, installed.id, services, {});
  assert.deepEqual(deletes, ["first", "second", "second"]);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(state.readOwnership(app, installed.id), {});
});

test("stop queues behind in-flight synchronization and cannot be overwritten by it", async t => {
  const { root, app, service, target } = fixture(t);
  service.resources.automations = [{ id: "job", name: "Job", cron: "* * * * *", agentKey: "test-agent", query: { message: "hi" } }];
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  configurePluginResources({ callAgentPlatform: async (_app, endpoint) => {
    if (endpoint.endsWith("/create")) { entered(); await new Promise(resolve => { release = resolve; }); return { id: "job" }; }
    return { deleted: true };
  } });
  const syncing = syncPluginResources(app, service, root);
  await started;
  const stopping = stopPluginResources(app, service);
  release();
  await Promise.all([syncing, stopping]);
  assert.equal(fs.existsSync(target), false);
  assert.equal(state.readOwnership(app, service.id).desiredStatus, "stopped");
  assert.deepEqual(state.readOwnership(app, service.id).agents, {});
});

test("Agent upgrade updates all retained entries, adds new entries and removes cancelled entries", async t => {
  const { root, app, service, target } = fixture(t);
  service.version = "v1";
  const original = structuredClone(service.resources.agents[0]);
  service.resources.agents.push({ ...structuredClone(original), key: "retired-agent" });
  await syncPluginResources(app, service, root);
  const agentsRoot = path.dirname(target);
  fs.mkdirSync(path.join(agentsRoot, "user-agent"));
  fs.writeFileSync(path.join(agentsRoot, "user-agent", "agent.yml"), "key: user-agent\nname: User\n");
  service.version = "v2";
  service.resources.agents = [
    { ...original, definition: { ...original.definition, name: "Version 2" }, soulPrompt: "New prompt", agentsPrompt: "" },
    { ...structuredClone(original), key: "new-agent" }
  ];
  await syncPluginResources(app, service, root);
  assert.equal(yaml.load(fs.readFileSync(path.join(target, "agent.yml"), "utf8")).name, "Version 2");
  assert.equal(fs.readFileSync(path.join(target, "SOUL.md"), "utf8"), "New prompt");
  assert.equal(fs.existsSync(path.join(target, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(agentsRoot, "retired-agent")), false);
  assert.equal(fs.existsSync(path.join(agentsRoot, "user-agent", "agent.yml")), true);
  const owned = state.readOwnership(app, service.id).agents;
  assert.deepEqual(Object.keys(owned).sort(), ["new-agent", "test-agent"]);
  assert.ok(Object.values(owned).every(record => record.pluginVersion === "v2"));
  await syncPluginResources(app, service, root);
  assert.deepEqual(Object.keys(state.readOwnership(app, service.id).agents).sort(), ["new-agent", "test-agent"]);
});

test("removing the last Agent declaration retains conflicts for retry, then clears the old source", async t => {
  const { root, app, service, target } = fixture(t);
  service.version = "v1";
  await syncPluginResources(app, service, root);
  const source = path.join(target, "agent.yml");
  const original = fs.readFileSync(source, "utf8");
  fs.appendFileSync(source, "# user modification\n");
  service.version = "v2";
  service.resources.agents = [];
  await assert.rejects(syncPluginResources(app, service, root), /has changed/);
  const failed = state.readOwnership(app, service.id);
  assert.equal(failed.agents["test-agent"].pluginVersion, "v1");
  assert.equal(failed.pendingAgentPlatformSync, true);
  assert.match(fs.readFileSync(source, "utf8"), /user modification/);
  fs.writeFileSync(source, original);
  registerPlugin({ pluginApiVersion: 1, id: service.id, name: "Test", version: "v2", resources: service.resources });
  const { retryPendingPluginResourceSync } = require("../dist-electron/main/modules/plugins/resources.js");
  await retryPendingPluginResourceSync(app);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(state.readOwnership(app, service.id).agents, {});
  assert.equal(state.readOwnership(app, service.id).pendingAgentPlatformSync, false);
});
