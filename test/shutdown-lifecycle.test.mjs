import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();

function readSource(...segments) {
  const sourcePath = path.join(projectRoot, ...segments);
  const source = fs.readFileSync(sourcePath, "utf8");
  if (!sourcePath.includes(`${path.sep}src${path.sep}main${path.sep}`) || path.extname(sourcePath) !== ".ts") {
    return source;
  }
  const sourceDirectory = path.dirname(sourcePath);
  const sourceStem = path.basename(sourcePath, ".ts");
  const splitSources = fs.readdirSync(sourceDirectory)
    .filter((name) => name.startsWith(`${sourceStem}.`) && name.endsWith(".ts"))
    .sort()
    .map((name) => fs.readFileSync(path.join(sourceDirectory, name), "utf8"));
  return [source, ...splitSources].join("\n");
}

test("installer shutdown acknowledgement validates branded temp paths and writes atomically", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-ack-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const {
    createNoPrimaryShutdownReport,
    parseInstallerShutdownRequest,
    validateShutdownAckPath,
    writeShutdownAck
  } = require("../dist-electron/main/app/lifecycle/shutdown-ack.js");
  const ackPath = path.join(tempRoot, "zenmind-desktop-shutdown-42.status");

  assert.equal(
    validateShutdownAckPath(ackPath, "zenmind-desktop", { tempDir: tempRoot }),
    ackPath
  );
  assert.equal(
    validateShutdownAckPath(path.join(tempRoot, "other-shutdown-42.status"), "zenmind-desktop", { tempDir: tempRoot }),
    null
  );
  assert.equal(
    validateShutdownAckPath(path.join(path.dirname(tempRoot), "zenmind-desktop-shutdown-42.status"), "zenmind-desktop", { tempDir: tempRoot }),
    null
  );

  const request = parseInstallerShutdownRequest(
    ["desktop", "--desktop-shutdown-for-update", `--desktop-shutdown-ack=${ackPath}`],
    new Set(["--desktop-shutdown-for-update"]),
    "zenmind-desktop",
    { tempDir: tempRoot }
  );
  assert.deepEqual(request, { requested: true, ackPath });

  const report = createNoPrimaryShutdownReport();
  writeShutdownAck(ackPath, "NO_PRIMARY", report);
  const lines = fs.readFileSync(ackPath, "utf8").trim().split("\n");
  assert.equal(lines[0], "NO_PRIMARY");
  assert.deepEqual(JSON.parse(lines[1]), report);
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("Windows taskkill success is not trusted until every captured descendant is verified", () => {
  const { terminateProcessTree } = require("../dist-electron/main/modules/services/manager/process-cleanup.js");
  const running = new Set([4321, 4322]);
  const fallbackCalls = [];
  const terminated = terminateProcessTree(4321, {
    platform: "win32",
    isProcessRunningImpl: (pid) => running.has(pid),
    listProcessTreePidsImpl: () => [4322, 4321],
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] }),
    terminateProcessListImpl: (pids) => {
      fallbackCalls.push([...pids]);
      pids.forEach((pid) => running.delete(pid));
      return true;
    }
  });

  assert.equal(terminated, true);
  assert.deepEqual(fallbackCalls, [[4322, 4321]]);
  assert.deepEqual([...running], []);
});

test("Windows WebApp process trees receive a graceful request before force cleanup", async () => {
  const {
    requestWindowsProcessTreeExitAsync
  } = require("../dist-electron/main/modules/services/manager/process-cleanup.js");
  const running = new Set([5101, 5102]);
  const commands = [];
  const exited = await requestWindowsProcessTreeExitAsync(5101, [5101, 5102], {
    platform: "win32",
    isProcessRunningImpl: (pid) => running.has(pid),
    runCommandImpl: async (command, args) => {
      commands.push([command, ...args]);
      running.clear();
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(exited, true);
  assert.deepEqual(commands, [["taskkill.exe", "/PID", "5101", "/T"]]);
  assert.equal(commands[0].includes("/F"), false);
  assert.match(
    readSource("src", "main", "modules", "webs", "webapps", "runtime.ts"),
    /if \(process\.platform === "win32"\) \{[\s\S]*?requestWindowsProcessTreeExitAsync\([\s\S]*?if \(exitedGracefully\) \{[\s\S]*?return true;[\s\S]*?terminateCapturedProcessTreeAsync/u
  );
});

test("shutdown coordinator is staged, report-driven, and does not leave a total deadline race", () => {
  const source = readSource("src", "main", "app", "lifecycle", "shutdown.ts");
  const markCompleteIndex = source.indexOf("options.markComplete(report)");
  const reportIndex = source.indexOf("const report: ShutdownReport");

  assert.match(source, /Promise\.allSettled/u);
  assert.match(source, /webappWindowManager\.closeAll\(\)/u);
  assert.match(source, /captureManagedProcessCleanupSnapshotAsync/u);
  assert.match(source, /terminateCapturedProcessTreeAsync/u);
  assert.doesNotMatch(source, /Promise\.race/u);
  assert.ok(reportIndex >= 0 && markCompleteIndex > reportIndex);
});

test("shutdown coordinator starts graceful resources in parallel and marks complete only after its report", async () => {
  const { createShutdownCleanupRunner } = require("../dist-electron/main/app/lifecycle/shutdown.js");
  const starts = [];
  const phases = [];
  let releaseStops;
  const stopBarrier = new Promise((resolve) => {
    releaseStops = resolve;
  });
  let cleanupPromise = null;
  let completedReport = null;
  const stop = (name, result) => async () => {
    starts.push(name);
    await stopBarrier;
    return result;
  };
  const runner = createShutdownCleanupRunner({
    app: {},
    getMode: () => "user",
    getExistingPromise: () => cleanupPromise,
    setPromise: (promise) => {
      cleanupPromise = promise;
    },
    markComplete: (report) => {
      completedReport = report;
    },
    emitProgress: (progress) => {
      phases.push(progress.phase);
    },
    dependencies: {
      closeWebappWindows: () => [],
      listOpenWebappWindowIds: () => [],
      listInitialPortTargets: () => [],
      captureManagedProcessSnapshot: async () => [],
      stopStaticSites: stop("static", []),
      stopWebapps: stop("webapps", []),
      stopServices: stop("services", { failures: [] }),
      stopTunnel: stop("tunnel", { ok: true, message: "" }),
      forceCleanup: async () => ({
        ok: true,
        failures: [],
        survivors: []
      }),
      isProcessRunning: () => false,
      isPortListening: async () => false
    }
  });

  const resultPromise = runner();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["static", "webapps", "services", "tunnel"]);
  assert.equal(completedReport, null);
  releaseStops();

  const report = await resultPromise;
  assert.equal(report.ok, true);
  assert.equal(completedReport, report);
  assert.deepEqual(phases, [
    "preparing",
    "stopping",
    "forcing",
    "verifying",
    "complete"
  ]);
  assert.equal(runner(), resultPromise);
});

test("shutdown coordinator reports a real budget overrun instead of abandoning cleanup", async () => {
  const { createShutdownCleanupRunner } = require("../dist-electron/main/app/lifecycle/shutdown.js");
  let clock = 0;
  const phases = [];
  const runner = createShutdownCleanupRunner({
    app: {},
    getMode: () => "user",
    getExistingPromise: () => null,
    setPromise: () => undefined,
    markComplete: () => undefined,
    emitProgress: (progress) => phases.push(progress.phase),
    now: () => clock,
    dependencies: {
      closeWebappWindows: () => [],
      listOpenWebappWindowIds: () => [],
      listInitialPortTargets: () => [],
      captureManagedProcessSnapshot: async () => [],
      stopStaticSites: async () => [],
      stopWebapps: async () => [],
      stopServices: async () => ({ failures: [] }),
      stopTunnel: async () => ({ ok: true, message: "" }),
      forceCleanup: async () => {
        clock = 8_001;
        return { ok: true, failures: [], survivors: [] };
      },
      isProcessRunning: () => false,
      isPortListening: async () => false
    }
  });

  const report = await runner();
  assert.equal(report.ok, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.elapsedMs, 8_001);
  assert.equal(phases.at(-1), "failed");
});

test("shutdown coordinator converts unexpected failures into an installer report", async () => {
  const { createShutdownCleanupRunner } = require("../dist-electron/main/app/lifecycle/shutdown.js");
  let mode = "user";
  let completedReport = null;
  const phases = [];
  const runner = createShutdownCleanupRunner({
    app: {},
    getMode: () => mode,
    getExistingPromise: () => null,
    setPromise: () => undefined,
    markComplete: (report) => {
      completedReport = report;
    },
    emitProgress: (progress) => phases.push(progress.phase),
    dependencies: {
      closeWebappWindows: () => [],
      listOpenWebappWindowIds: () => {
        throw new Error("window verification unavailable");
      },
      listInitialPortTargets: () => [],
      captureManagedProcessSnapshot: async () => [],
      stopStaticSites: async () => [],
      stopWebapps: async () => [],
      stopServices: async () => ({ failures: [] }),
      stopTunnel: async () => ({ ok: true, message: "" }),
      forceCleanup: async () => {
        mode = "installer";
        return { ok: true, failures: [], survivors: [] };
      },
      isProcessRunning: () => false,
      isPortListening: async () => false
    }
  });

  const report = await runner();
  assert.equal(report.mode, "installer");
  assert.equal(report.ok, false);
  assert.equal(completedReport, report);
  assert.deepEqual(report.failures.map((failure) => ({
    id: failure.id,
    phase: failure.phase,
    message: failure.message
  })), [{
    id: "shutdown-coordinator",
    phase: "verify",
    message: "window verification unavailable"
  }]);
  assert.equal(phases.at(-1), "failed");
});

test("shutdown coordinator fails verification while a captured gateway port is still listening", async () => {
  const { createShutdownCleanupRunner } = require("../dist-electron/main/app/lifecycle/shutdown.js");
  let cleanupPromise = null;
  const runner = createShutdownCleanupRunner({
    app: {},
    getMode: () => "installer",
    getExistingPromise: () => cleanupPromise,
    setPromise: (promise) => {
      cleanupPromise = promise;
    },
    markComplete: () => undefined,
    emitProgress: () => undefined,
    dependencies: {
      closeWebappWindows: () => [],
      listOpenWebappWindowIds: () => [],
      listInitialPortTargets: () => [{
        kind: "gateway",
        id: "webapp:demo:gateway",
        port: 18765
      }],
      captureManagedProcessSnapshot: async () => [],
      stopStaticSites: async () => [],
      stopWebapps: async () => [],
      stopServices: async () => ({ failures: [], runningServicePorts: [] }),
      stopTunnel: async () => ({ ok: true, message: "" }),
      forceCleanup: async () => ({
        ok: true,
        failures: [],
        survivors: []
      }),
      isProcessRunning: () => false,
      isPortListening: async (port) => port === 18765
    }
  });

  const report = await runner();
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((failure) => ({
    kind: failure.kind,
    id: failure.id,
    phase: failure.phase
  })), [{
    kind: "gateway",
    id: "webapp:demo:gateway",
    phase: "verify"
  }]);
});

test("managed force cleanup uses bounded concurrency and waits for every root", async () => {
  const { forceCleanupManagedProcesses } =
    require("../dist-electron/main/modules/services/manager/managed-cleanup.js");
  const running = new Set([7101, 7102, 7103]);
  let active = 0;
  let peak = 0;
  const result = await forceCleanupManagedProcesses(
    {},
    [7101, 7102, 7103].map((pid) => ({
      pid,
      serviceId: `service-${pid}`,
      installDir: "/managed",
      pidFilePaths: [],
      treePids: [pid]
    })),
    {
      maxConcurrency: 2,
      collectManagedProcessCleanupTargetsImpl: () => ({
        roots: [],
        stalePidFilePaths: []
      }),
      listProcessTreePidsImpl: () => [],
      isProcessRunningImpl: (pid) => running.has(pid),
      pidMatchesInstallDirImpl: () => true,
      terminateCapturedProcessTreeImpl: async (_rootPid, pids) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        pids.forEach((pid) => running.delete(pid));
        active -= 1;
        return true;
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(peak, 2);
  assert.deepEqual([...running], []);
});

test("renderer shows shutdown progress from the main-process stage event", () => {
  const preload = readSource("src", "preload", "index.ts");
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const overlay = readSource("src", "renderer", "app-shell", "DesktopShutdownOverlay.tsx");
  const styles = readSource("src", "renderer", "styles", "shutdown.css");

  assert.match(preload, /desktopShell\.shutdownProgress/u);
  assert.match(appShell, /onShutdownProgress/u);
  assert.match(appShell, /progress\.phase === "preparing"[\s\S]*?!entryKey\.startsWith\("webapp:"\)/u);
  assert.match(appShell, /DesktopShutdownOverlay progress=\{shutdownProgress\}/u);
  assert.match(overlay, /role="progressbar"/u);
  assert.match(styles, /\.desktop-shutdown-overlay/u);
});

test("WebApp removal closes its UI and refuses file deletion after a failed runtime stop", () => {
  const actions = readSource("src", "main", "modules", "webs", "webapps", "actions.ts");
  const pluginResources = readSource("src", "main", "modules", "plugins", "resources.ts");
  const websiteAppMarket = readSource("src", "main", "modules", "marketplace", "website-app-market.ts");
  const webappRuntime = readSource("src", "main", "modules", "webs", "webapps", "runtime.ts");
  const windowManager = readSource("src", "main", "modules", "webs", "webapps", "window-manager.ts");
  const mainRuntime = readSource("src", "main", "app", "runtime.ts");
  const appShell = readSource("src", "renderer", "app-shell", "AppShell.tsx");
  const disposalIndex = actions.indexOf("dependencies.windowManager.beginDisposal");
  const stopIndex = actions.indexOf("await dependencies.runtime.stop");
  const stopGuardIndex = actions.indexOf("if (!stopped.ok)");
  const deleteIndex = actions.indexOf("fs.rmSync(target.installPath");

  assert.ok(disposalIndex >= 0 && disposalIndex < stopIndex);
  assert.ok(stopIndex < stopGuardIndex && stopGuardIndex < deleteIndex);
  assert.doesNotMatch(actions, /dependencies\.runtime\.stop\([^;]+\.catch\(\(\) => undefined\)/u);
  assert.match(windowManager, /this\.disposalListener\?\.\(normalizedId\)/u);
  assert.match(mainRuntime, /phase: "disposing"/u);
  assert.match(appShell, /event\.phase === "disposing"/u);
  assert.match(pluginResources, /manager\.dispose/u);
  assert.match(websiteAppMarket, /disposeWebappInstallation/u);
  assert.match(webappRuntime, /identityMatch === "unknown"/u);
});
