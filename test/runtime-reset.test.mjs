import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { prepareRuntimeEnvReset, armRuntimeEnvReset, cancelRuntimeEnvReset, consumeRuntimeEnvReset } =
  require("../dist-electron/main/infrastructure/filesystem/runtime-env-reset-transaction.js");
const { resolveRuntimeRoot } = require("../dist-electron/main/infrastructure/filesystem/runtime-env-paths.js");
const { createRuntimeResetCoordinator } = require("../dist-electron/main/app/lifecycle/runtime-reset.js");
const { createMainAppState } = require("../dist-electron/main/app/state.js");
const { createServicesRuntime } = require("../dist-electron/main/modules/services/runtime.js");

async function fixture(t, platform) {
  // Never consult an actual Windows installation's registered data directory.
  const roots = require("../dist-electron/main/infrastructure/filesystem/runtime-root.js");
  const resolveRoot = roots.resolveRuntimeRootPath;
  t.mock.method(roots, "resolveRuntimeRootPath", (options) => resolveRoot({ ...options, registryDataRootPath: "" }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-reset-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const appPath = path.join(resources, "app");
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, "VERSION"), "1.0.0");
  const app = { isPackaged: true, getAppPath: () => appPath, getVersion: () => "1.0.0",
    getPath: (name) => path.join(root, name) };
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "user-data.txt"), "preserve me");
  const zip = new JSZip();
  zip.file("env/VERSION", "1.0.0");
  zip.file("env/agents/seed/agent.yml", "key: seed");
  zip.file("env/desktop-init.json", "{}");
  zip.file("env/skills-center/demo/SKILL.md", "# Demo\n");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const envRoot = path.join(resources, "env");
  fs.mkdirSync(envRoot);
  fs.writeFileSync(path.join(envRoot, "env.zip"), bytes);
  fs.writeFileSync(path.join(envRoot, "manifest.json"), JSON.stringify({ bundled: true, fileName: "env.zip",
    version: "1.0.0", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  return { app, root, runtimeRoot, envRoot };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: reset restores bundled Agents and preserves current user Agents`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const seed = path.join(runtimeRoot, "agents", platform === "win32" ? "SEED" : "seed");
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, "agent.yml"), "modified seed");
    fs.writeFileSync(path.join(seed, "obsolete.txt"), "old extra file");
    const prepared = await prepareRuntimeEnvReset(app, platform);
    // Changes made after preparation must also survive the restart.
    const custom = path.join(runtimeRoot, "agents", "my-agent");
    fs.mkdirSync(path.join(custom, "assets"), { recursive: true });
    fs.writeFileSync(path.join(custom, "agent.yml"), "user definition");
    fs.writeFileSync(path.join(custom, "assets", "data.bin"), Buffer.from([0, 1, 255]));
    armRuntimeEnvReset(app, platform, prepared.id);
    assert.equal(consumeRuntimeEnvReset(app, platform), true);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "agents/seed/agent.yml"), "utf8"), "key: seed");
    assert.equal(fs.existsSync(path.join(runtimeRoot, "agents/seed/obsolete.txt")), false);
    if (platform === "win32") {
      assert.equal(fs.readdirSync(path.join(runtimeRoot, "agents")).includes("SEED"), false);
    }
    assert.equal(fs.readFileSync(path.join(custom, "agent.yml"), "utf8"), "user definition");
    assert.deepEqual(fs.readFileSync(path.join(custom, "assets/data.bin")), Buffer.from([0, 1, 255]));
    assert.equal(fs.readFileSync(path.join(prepared.result.backupPath, "agents", path.basename(seed), "agent.yml"), "utf8"), "modified seed");
  });

  test(`${platform}: failure to preserve a user Agent aborts before moving the old root`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const custom = path.join(runtimeRoot, "agents/custom");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "agent.yml"), "user definition");
    const prepared = await prepareRuntimeEnvReset(app, platform);
    armRuntimeEnvReset(app, platform, prepared.id);
    t.mock.method(fs, "cpSync", () => { throw new Error("injected copy failure"); });
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /Runtime reset failed/);
    assert.equal(fs.existsSync(prepared.result.backupPath), false);
    assert.equal(fs.readFileSync(path.join(custom, "agent.yml"), "utf8"), "user definition");
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /requires recovery/);
  });

  test(`${platform}: reset prepares without touching user data and applies exactly once on restart`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    fs.mkdirSync(path.join(runtimeRoot, "skills-market"));
    fs.writeFileSync(path.join(runtimeRoot, "skills-market/keep.txt"), "legacy");
    const prepared = await prepareRuntimeEnvReset(app, platform);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
    assert.equal(consumeRuntimeEnvReset(app, platform), false, "unarmed preparation cannot reset");
    armRuntimeEnvReset(app, platform, prepared.id);
    assert.equal(consumeRuntimeEnvReset(app, platform), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "user-data.txt")), false);
    assert.equal(fs.readFileSync(path.join(prepared.result.backupPath, "user-data.txt"), "utf8"), "preserve me");
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "agents/seed/agent.yml"), "utf8"), "key: seed");
    assert.equal(fs.readFileSync(path.join(prepared.result.backupPath, "skills-market/keep.txt"), "utf8"), "legacy");
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "skills-center/demo/SKILL.md"), "utf8"), "# Demo\n");
    assert.equal(fs.existsSync(path.join(runtimeRoot, "skills-market")), false);
    assert.equal(fs.existsSync(path.join(runtimeRoot, ".desktop/state/desktop/env-resource-sync.json")), false);
    assert.equal(consumeRuntimeEnvReset(app, platform), false);
  });

  test(`${platform}: invalid bundle is rejected before shutdown or live-root mutation`, async (t) => {
    const { app, runtimeRoot, envRoot } = await fixture(t, platform);
    fs.writeFileSync(path.join(envRoot, "env.zip"), "broken");
    await assert.rejects(prepareRuntimeEnvReset(app, platform));
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
    assert.equal(consumeRuntimeEnvReset(app, platform), false);
  });

  test(`${platform}: failed publication preserves backup and never retries destructive steps automatically`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const prepared = await prepareRuntimeEnvReset(app, platform);
    armRuntimeEnvReset(app, platform, prepared.id);
    const renameSync = fs.renameSync;
    const rename = t.mock.method(fs, "renameSync", (source, target) => {
      if (target === runtimeRoot) throw Object.assign(new Error("injected sharing violation"), { code: "EPERM" });
      return renameSync(source, target);
    });
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /Runtime reset failed/);
    rename.mock.restore();
    assert.equal(fs.readFileSync(path.join(prepared.result.backupPath, "user-data.txt"), "utf8"), "preserve me");
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /requires recovery/);
    assert.equal(fs.existsSync(runtimeRoot), false);
  });

  test(`${platform}: unsafe request id cannot redirect a reset`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    await prepareRuntimeEnvReset(app, platform);
    const requestPath = `${runtimeRoot}.desktop-reset/request.json`;
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    fs.writeFileSync(requestPath, JSON.stringify({ ...request, id: "../outside", status: "ready" }));
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /Invalid runtime reset request/);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
  });

  test(`${platform}: cleanup failure cancels reset without scheduling a restart`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const state = createMainAppState({ startupPhase: "core-ready" });
    const reset = createRuntimeResetCoordinator({ state,
      prepare: () => prepareRuntimeEnvReset(app, platform),
      arm: () => assert.fail("must not arm"),
      cancel: (id) => cancelRuntimeEnvReset(app, platform, id),
      beginShutdown: () => {}, cleanup: async () => ({ ok: false, survivors: [123] }),
      flushLogs: async () => {}, relaunch: () => assert.fail("must not relaunch"), quit: () => assert.fail("must not quit") });
    await assert.rejects(reset(), /cleanup failed/);
    assert.equal(state.isHandlingQuit, false);
    assert.equal(consumeRuntimeEnvReset(app, platform), false);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
  });
}

test("reset coordinator arms only after cleanup, schedules one relaunch and returns before quit", async () => {
  const events = [];
  let scheduled;
  const state = createMainAppState({ startupPhase: "core-ready" });
  const reset = createRuntimeResetCoordinator({ state,
    prepare: async () => { events.push("prepare"); return { id: "request", result: {} }; },
    arm: () => events.push("arm"), cancel: () => assert.fail("must not cancel"),
    beginShutdown: () => events.push("shutdown"),
    cleanup: async () => { events.push("cleanup"); return { ok: true, survivors: [] }; },
    flushLogs: async () => events.push("flush"), relaunch: () => events.push("relaunch"),
    quit: () => events.push("quit"), scheduleQuit: (quit) => { scheduled = quit; } });
  const pending = reset();
  await assert.rejects(reset(), /already shutting down/);
  assert.equal((await pending).restartScheduled, true);
  assert.deepEqual(events, ["prepare", "shutdown", "cleanup", "flush", "arm", "relaunch"]);
  scheduled();
  assert.equal(events.at(-1), "quit");
});

test("service mutations queued behind reset are rejected while shutdown is active", async () => {
  let stopping = false;
  const runtime = createServicesRuntime({ app: {}, notifyServicesChanged: () => {}, isShuttingDown: () => stopping });
  const first = runtime.runServiceMutation(async () => { stopping = true; });
  const next = runtime.runServiceMutation(async () => assert.fail("must not restart a service after cleanup"));
  await first;
  await assert.rejects(next, /shutting down/);
});

test("reset publication occurs after single-instance ownership and before snapshots or profile creation", () => {
  const source = fs.readFileSync(new URL("../src/main/app/runtime.ts", import.meta.url), "utf8");
  const consume = source.indexOf("consumeRuntimeEnvReset(app, startupPlatform)");
  assert.ok(source.indexOf("if (!gotSingleInstanceLock)") < consume);
  assert.ok(consume < source.indexOf("const isFirstDesktopInstall ="));
  assert.ok(consume < source.indexOf("artifactRuntime = createArtifactRuntime("));
  assert.ok(consume < source.indexOf("initializeElectronProfile(app, startupPlatform)"));
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: a locked old root stays intact and reset is not retried`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const prepared = await prepareRuntimeEnvReset(app, platform);
    armRuntimeEnvReset(app, platform, prepared.id);
    const originalRename = fs.renameSync;
    const rename = t.mock.method(fs, "renameSync", (source, target) => {
      if (source === runtimeRoot) throw Object.assign(new Error("locked profile"), { code: "EPERM" });
      return originalRename(source, target);
    });
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /Runtime reset failed/);
    rename.mock.restore();
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
    assert.equal(fs.existsSync(prepared.result.backupPath), false);
    assert.throws(() => consumeRuntimeEnvReset(app, platform), /requires recovery/);
  });

  test(`${platform}: relaunch failure disarms the request and leaves the old root untouched`, async (t) => {
    const { app, runtimeRoot } = await fixture(t, platform);
    const state = createMainAppState({ startupPhase: "core-ready" });
    const reset = createRuntimeResetCoordinator({ state,
      prepare: () => prepareRuntimeEnvReset(app, platform),
      arm: (id) => armRuntimeEnvReset(app, platform, id),
      cancel: (id) => cancelRuntimeEnvReset(app, platform, id),
      beginShutdown: () => {}, cleanup: async () => ({ ok: true, survivors: [] }),
      flushLogs: async () => {}, relaunch: () => { throw new Error("injected relaunch failure"); },
      quit: () => assert.fail("must not quit") });
    await assert.rejects(reset(), /injected relaunch failure/);
    assert.equal(consumeRuntimeEnvReset(app, platform), false);
    assert.equal(state.isHandlingQuit, false);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "user-data.txt"), "utf8"), "preserve me");
  });
}

test("reset does not interrupt unfinished startup", async () => {
  const reset = createRuntimeResetCoordinator({ state: createMainAppState(),
    prepare: () => assert.fail("must not prepare during startup") });
  await assert.rejects(reset(), /startup to finish/);
});
