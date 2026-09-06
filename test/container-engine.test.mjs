import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __containerEngineTestInternals,
  buildContainerEngineInvocation,
  clearContainerEngineProbeCache,
  probeContainerEngines
} = require("../dist-electron/main/modules/services/container-engine.js");

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "..");

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createProbeEnv(binDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    DESKTOP_CONTAINER_ENGINE_PATHS: binDir,
    PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter)
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

test("container engine probing contains no synchronous Docker info path", () => {
  const sourcePaths = [
    "src/main/modules/services/container-engine.ts",
    "src/main/modules/services/manager/container-engine.ts"
  ];

  for (const relativePath of sourcePaths) {
    const source = fs.readFileSync(path.join(WORKSPACE_ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, /\bspawnSync\b/u, relativePath);
    assert.doesNotMatch(source, /command -v/u, relativePath);
    assert.doesNotMatch(source, /\[\s*["']info["']\s*\]/u, relativePath);
  }

  const sharedSource = fs.readFileSync(
    path.join(WORKSPACE_ROOT, "src/main/modules/services/container-engine.ts"),
    "utf8"
  );
  assert.match(sharedSource, /\["version", "--format", "\{\{\.Server\.Version\}\}"\]/u);
});

test("Docker readiness uses the bounded version probe", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fake executable fixture");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-docker-version-probe-"));
  const binDir = path.join(tempRoot, "bin");
  const logPath = path.join(tempRoot, "docker.log");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  writeExecutable(path.join(binDir, "docker"), `#!/bin/sh
printf '%s\n' "$*" >> "$ENGINE_LOG"
if [ "$1" = "version" ]; then
  printf '27.0.0\n'
  exit 0
fi
exit 91
`);

  clearContainerEngineProbeCache();
  const result = await probeContainerEngines({
    env: createProbeEnv(binDir, { ENGINE_LOG: logPath }),
    preferredName: "docker",
    timeoutMs: 1_000,
    cache: false
  });

  assert.equal(result.engine, "docker", JSON.stringify(result));
  assert.equal(result.probes[0]?.reachable, true);
  const invocation = fs.readFileSync(logPath, "utf8").trim();
  assert.equal(invocation, "version --format {{.Server.Version}}");
  assert.doesNotMatch(invocation, /\binfo\b/u);
});

test("Podman remains an asynchronous fallback when Docker is unreachable", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fake executable fixture");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-podman-version-probe-"));
  const binDir = path.join(tempRoot, "bin");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  writeExecutable(path.join(binDir, "docker"), "#!/bin/sh\nexit 1\n");
  writeExecutable(path.join(binDir, "podman"), `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '{"Client":{"Version":"5.5.0"},"Server":{"Version":"5.5.0"}}\n'
  exit 0
fi
exit 1
`);

  clearContainerEngineProbeCache();
  const result = await probeContainerEngines({
    env: createProbeEnv(binDir),
    timeoutMs: 1_000,
    cache: false
  });

  assert.equal(result.engine, "podman");
  assert.equal(result.probes.find((probe) => probe.engine === "docker")?.reachable, false);
  assert.equal(result.probes.find((probe) => probe.engine === "podman")?.reachable, true);
});

test("macOS rejects Docker symlinks into mounted DMG volumes before touching the target", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symbolic-link fixture requires POSIX symlink semantics");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-docker-volume-link-"));
  const dockerLink = path.join(tempRoot, "docker");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.symlinkSync("/Volumes/Docker/Docker.app/Contents/Resources/bin/docker", dockerLink);

  const inspection = await __containerEngineTestInternals.inspectEnginePathInWorker(
    "docker",
    { PATH: tempRoot, HOME: tempRoot, DOCKER_CLI_PLUGIN_EXTRA_DIRS: "" },
    "darwin",
    200
  );

  assert.equal(inspection.kind, "unsafe");
  assert.equal(inspection.command, dockerLink);
  assert.match(inspection.message, /mounted volume.*\/Volumes\/Docker/u);
});

test("macOS rejects stale Docker CLI plugin symlinks before starting Docker", async (t) => {
  if (process.platform === "win32") {
    t.skip("Symbolic-link fixture requires POSIX symlink semantics");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-docker-plugin-volume-link-"));
  const binDir = path.join(tempRoot, "bin");
  const dockerConfigDir = path.join(tempRoot, "docker-config");
  const pluginDir = path.join(dockerConfigDir, "cli-plugins");
  const spawnLogPath = path.join(tempRoot, "docker-started.log");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  writeExecutable(path.join(binDir, "docker"), `#!/bin/sh
printf started > "$SPAWN_LOG"
exit 0
`);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.symlinkSync(
    "/Volumes/Docker/Docker.app/Contents/Resources/cli-plugins/docker-buildx",
    path.join(pluginDir, "docker-buildx")
  );

  clearContainerEngineProbeCache();
  const result = await probeContainerEngines({
    env: createProbeEnv(binDir, {
      DOCKER_CONFIG: dockerConfigDir,
      DOCKER_CLI_PLUGIN_EXTRA_DIRS: "",
      SPAWN_LOG: spawnLogPath
    }),
    platform: "darwin",
    preferredName: "docker",
    cache: false
  });

  assert.equal(result.engine, "");
  assert.equal(result.probes[0]?.failure, "unsafe-location");
  assert.match(result.probes[0]?.command ?? "", /docker-buildx$/u);
  assert.equal(fs.existsSync(spawnLogPath), false);
});

test("a hung Docker probe times out without blocking the event loop and kills its process tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group regression; Windows uses taskkill /T /F");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-docker-probe-timeout-"));
  const binDir = path.join(tempRoot, "bin");
  const parentPidPath = path.join(tempRoot, "parent.pid");
  const childPidPath = path.join(tempRoot, "child.pid");
  let parentPid = 0;
  let childPid = 0;
  t.after(() => {
    for (const pid of [childPid, parentPid]) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  writeExecutable(path.join(binDir, "docker"), `#!/bin/sh
sleep 30 &
child_pid=$!
printf '%s\n' "$$" > "$PARENT_PID_FILE"
printf '%s\n' "$child_pid" > "$CHILD_PID_FILE"
wait "$child_pid"
`);

  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 10);
  const startedAt = Date.now();
  clearContainerEngineProbeCache();
  const result = await probeContainerEngines({
    env: createProbeEnv(binDir, {
      PARENT_PID_FILE: parentPidPath,
      CHILD_PID_FILE: childPidPath
    }),
    preferredName: "docker",
    // Process startup can be delayed by endpoint security and CI sandbox
    // wrappers. Keep this comfortably below the production 3s bound while
    // still giving the fixture time to create its descendant process.
    timeoutMs: 1_000,
    cache: false
  });
  const elapsedMs = Date.now() - startedAt;
  clearInterval(heartbeat);

  assert.equal(fs.existsSync(parentPidPath), true, JSON.stringify(result));
  assert.equal(fs.existsSync(childPidPath), true, JSON.stringify(result));
  parentPid = Number(fs.readFileSync(parentPidPath, "utf8").trim());
  childPid = Number(fs.readFileSync(childPidPath, "utf8").trim());
  assert.equal(result.engine, "");
  assert.equal(result.probes[0]?.failure, "timeout");
  assert.ok(elapsedMs < 2_500, `probe took ${elapsedMs}ms`);
  assert.ok(heartbeats >= 5, `event-loop heartbeat only advanced ${heartbeats} times`);
  assert.equal(await waitForProcessExit(parentPid), true, `probe parent ${parentPid} survived`);
  assert.equal(await waitForProcessExit(childPid), true, `probe child ${childPid} survived`);
});

test("concurrent callers share one in-flight container engine probe and reuse its short cache", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fake executable fixture");
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-docker-probe-cache-"));
  const binDir = path.join(tempRoot, "bin");
  const logPath = path.join(tempRoot, "docker.log");
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  writeExecutable(path.join(binDir, "docker"), `#!/bin/sh
printf '%s\n' "$*" >> "$ENGINE_LOG"
sleep 0.1
exit 1
`);
  const options = {
    env: createProbeEnv(binDir, { ENGINE_LOG: logPath }),
    preferredName: "docker",
    timeoutMs: 1_000,
    cache: true
  };

  clearContainerEngineProbeCache();
  await Promise.all([
    probeContainerEngines(options),
    probeContainerEngines(options),
    probeContainerEngines(options)
  ]);
  await probeContainerEngines(options);

  const invocations = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0], "version --format {{.Server.Version}}");
});

test("Windows command wrappers preserve cmd files", () => {
  const invocation = buildContainerEngineInvocation(
    {
      name: "docker",
      command: "C:\\Program Files\\Docker\\docker.cmd",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32"
    },
    ["version", "--format", "{{.Server.Version}}"]
  );

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^call "C:\\Program Files\\Docker\\docker\.cmd"/u);
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test("Windows probe cleanup requests taskkill tree mode before direct-child fallback", () => {
  const calls = [];
  let directKills = 0;
  let killerUnref = false;
  const fakeChild = {
    pid: 4321,
    kill() {
      directKills += 1;
      return true;
    }
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      once(event) {
        assert.equal(event, "error");
        return this;
      },
      unref() {
        killerUnref = true;
      }
    };
  };

  __containerEngineTestInternals.terminateSpawnedProcessTree(fakeChild, "win32", spawnImpl);

  assert.deepEqual(calls, [{
    command: "taskkill.exe",
    args: ["/PID", "4321", "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true }
  }]);
  assert.equal(killerUnref, true);
  assert.equal(directKills, 0);
});
