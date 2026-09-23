import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeInstallerInclude } from "../scripts/lib/brand-installers.mjs";
const require = createRequire(import.meta.url);
const { createShutdownCleanupRunner } = require("../dist-electron/main/app/lifecycle/shutdown.js");

async function shutdown({ platform = "win32", mode = "installer", stopMs = 31_000, listening = false, running = false, cleanupMs = 2_000, snapshotError, effects = [] } = {}) {
  let clock = 0;
  return createShutdownCleanupRunner({
    app: {}, platform, getMode: () => mode,
    getExistingPromise: () => null, setPromise: () => {},
    markComplete: () => {}, emitProgress: () => {}, now: () => clock,
    dependencies: {
      closeWebappWindows: () => { effects.push("close"); return []; }, listOpenWebappWindowIds: () => [],
      listInitialPortTargets: () => [], captureManagedProcessSnapshot: async () => { if(snapshotError) throw snapshotError; return []; },
      stopStaticSites: async () => { effects.push("static"); return []; }, stopWebapps: async () => { effects.push("webapps"); return []; },
      stopServices: async (_app, { stopCommandTimeoutMs }) => {
        effects.push("services");
        clock += Math.min(stopMs, stopCommandTimeoutMs);
        return {
          failures: stopMs > stopCommandTimeoutMs
            ? [{ serviceId: "agent-platform", message: "PowerShell command timed out" }] : [],
          runningServicePorts: [{ serviceId: "agent-platform", port: 19001 }]
        };
      },
      stopTunnel: async () => { effects.push("tunnel"); return { ok: true, message: "" }; },
      forceCleanup: async () => { effects.push("force"); clock += cleanupMs; return { ok: !running, failures: running
        ? [{ serviceId: "agent-platform", pids: [1001] }] : [], survivors: running ? [1001] : [] }; },
      isProcessRunning: () => running, isPortListening: async () => listening
    }
  })();
}

test("Windows update refuses a failed snapshot before closing or stopping resources", async () => {
  const effects = [];
  const report = await shutdown({ snapshotError: new Error("inventory unavailable"), effects });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0].id, "managed-process-snapshot");
  assert.deepEqual(effects, []);
});

test("Windows update permits a service to finish its 30-second stop and verifies cleanup", async () => {
  const report = await shutdown();
  assert.equal(report.ok, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.elapsedMs, 33_000);
});

test("Windows update retains service, port, process and total-deadline safety gates", async () => {
  for (const scenario of [{ stopMs: 36_000 }, { listening: true }, { running: true }, { cleanupMs: 30_000 }]) {
    const report = await shutdown(scenario);
    assert.equal(report.ok, false, JSON.stringify(scenario));
  }
});

test("macOS update and ordinary exit retain existing timeout behavior", async () => {
  for (const scenario of [{ platform: "darwin", stopMs: 5_000 }, { mode: "user", stopMs: 4_000 }]) {
    assert.equal((await shutdown(scenario)).ok, false);
    assert.equal((await shutdown({ ...scenario, stopMs: 1_000 })).ok, true);
  }
  assert.equal((await shutdown({ platform: "darwin", stopMs: 1_000, cleanupMs: 10_000 })).timedOut, true);
  assert.equal((await shutdown({ mode: "user", stopMs: 1_000, cleanupMs: 8_000 })).timedOut, true);
});

test("failed cleanup logs service and verification details, not only survivors=none", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  await shutdown({ listening: true });
  assert.ok(warnings.some(line => line.includes("agent-platform") && line.includes("verify") && line.includes("19001")));
});

test("Windows installer waits longer than a successful slow update cleanup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brand = { id: "test", productName: "Test", appId: "test.desktop", storageNamespace: "test-desktop",
    installer: { shutdownArg: "--desktop-shutdown-for-update" },
    paths: { programDataDirName: "Test", runtimeRootDirName: ".test" } };
  writeInstallerInclude(root, brand);
  const source = fs.readFileSync(path.join(root, "build/brands/test/installer/installer.nsh"), "utf8");
  const loop = source.slice(source.indexOf("waitShutdownAck:"), source.indexOf("shutdownAckFinished:"));
  const polls = Number(loop.match(/\$R1 < (\d+)/)[1]);
  const interval = Number(loop.match(/Sleep (\d+)/)[1]);
  const report = await shutdown({ stopMs: 34_000 });
  assert.equal(report.ok, true);
  assert.ok((polls - 1) * interval > report.elapsedMs + 5_000);
});
