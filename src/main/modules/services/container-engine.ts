import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort
} from "node:worker_threads";

export const CONTAINER_ENGINES = ["docker", "podman"] as const;

export const CONTAINER_ENGINE_PROBE_TIMEOUT_MS = 3_000;
const CONTAINER_ENGINE_PATH_TIMEOUT_MS = 1_500;
const CONTAINER_ENGINE_CACHE_SUCCESS_MS = 30_000;
const CONTAINER_ENGINE_CACHE_MISS_MS = 10_000;
const CONTAINER_ENGINE_MAX_OUTPUT_BYTES = 64 * 1024;
const CONTAINER_ENGINE_OUTPUT_DRAIN_MS = 50;
const CONTAINER_ENGINE_MAX_PATH_CANDIDATES = 128;
const CONTAINER_ENGINE_MAX_SYMLINK_DEPTH = 8;
const CONTAINER_ENGINE_MAX_PLUGIN_CANDIDATES = 128;

export type ContainerEngineName = typeof CONTAINER_ENGINES[number];

export type ContainerEngineResolution = {
  name: ContainerEngineName;
  command: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

export type ContainerEngineCommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

export type ContainerEngineProbeFailure =
  | "not-installed"
  | "path-timeout"
  | "unsafe-location"
  | "spawn-error"
  | "timeout"
  | "unreachable";

export type ContainerEngineProbe = {
  engine: ContainerEngineName;
  command: string;
  installed: boolean;
  reachable: boolean;
  message: string;
  failure: ContainerEngineProbeFailure | null;
  elapsedMs: number;
};

export type ContainerEngineProbeResult = {
  engine: ContainerEngineName | "";
  resolution: ContainerEngineResolution | null;
  probes: ContainerEngineProbe[];
};

export type ContainerEngineCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string;
  timedOut: boolean;
  elapsedMs: number;
};

type ContainerEnginePathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export type ContainerEngineResolveOptions = ContainerEnginePathOptions & {
  timeoutMs?: number;
  pathTimeoutMs?: number;
  preferredName?: ContainerEngineName;
  cache?: boolean;
};

type ContainerEngineCommandOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  windowsVerbatimArguments?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type CandidateInspection = {
  kind: "found" | "missing" | "unsafe" | "timeout";
  command: string;
  message: string;
};

type ContainerEngineProbeOverride = (
  options: ContainerEngineResolveOptions
) => ContainerEngineProbeResult | Promise<ContainerEngineProbeResult>;

const probeCache = new Map<string, { expiresAt: number; result: ContainerEngineProbeResult }>();
const inFlightProbes = new Map<string, Promise<ContainerEngineProbeResult>>();
let probeCacheGeneration = 0;
let probeOverrideForTests: ContainerEngineProbeOverride | null = null;

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathDelimiter(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":";
}

function splitPathList(value: string | undefined, platform: NodeJS.Platform) {
  return (value ?? "")
    .split(pathDelimiter(platform))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getDefaultContainerEnginePathEntries(options: ContainerEnginePathOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA ?? "";
    return [
      paths.join(programFiles, "Docker", "Docker", "resources", "bin"),
      paths.join(programFiles, "RedHat", "Podman"),
      paths.join(programFiles, "Podman"),
      ...(localAppData ? [
        paths.join(localAppData, "Programs", "Docker", "Docker", "resources", "bin"),
        paths.join(localAppData, "Programs", "Podman"),
        paths.join(localAppData, "Programs", "RedHat", "Podman")
      ] : [])
    ];
  }

  if (platform === "darwin") {
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/opt/podman/bin",
      "/Applications/Docker.app/Contents/Resources/bin",
      "/Applications/OrbStack.app/Contents/MacOS/bin"
    ];
  }

  return [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/snap/bin"
  ];
}

export function buildContainerEngineEnv(options: ContainerEnginePathOptions = {}) {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const env = { ...baseEnv };
  const currentPath = baseEnv.PATH ?? baseEnv.Path;
  const pathEntries = [
    ...splitPathList(baseEnv.DESKTOP_CONTAINER_ENGINE_PATHS, platform),
    ...getDefaultContainerEnginePathEntries({ ...options, platform }),
    ...splitPathList(currentPath, platform)
  ];
  env.PATH = [...new Set(pathEntries)].join(pathDelimiter(platform));
  if (platform === "win32") {
    env.Path = env.PATH;
  }
  return env;
}

function commandBasenames(command: string, platform: NodeJS.Platform) {
  if (platform !== "win32") {
    return [command];
  }
  return /\.[a-z0-9]+$/iu.test(command)
    ? [command]
    : [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function getMacDockerPluginPathEntries(env: NodeJS.ProcessEnv) {
  const dockerConfigDir = env.DOCKER_CONFIG?.trim()
    || (env.HOME ? path.posix.join(env.HOME, ".docker") : "");
  return [...new Set([
    ...splitPathList(env.DOCKER_CLI_PLUGIN_EXTRA_DIRS, "darwin"),
    ...(dockerConfigDir ? [path.posix.join(dockerConfigDir, "cli-plugins")] : []),
    "/usr/local/lib/docker/cli-plugins",
    "/usr/local/libexec/docker/cli-plugins",
    "/usr/lib/docker/cli-plugins",
    "/usr/libexec/docker/cli-plugins"
  ])];
}

const CONTAINER_ENGINE_PATH_WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { workerData } = require("node:worker_threads");

const port = workerData.port;
const platform = workerData.platform;
const paths = platform === "win32" ? path.win32 : path.posix;

function unsafeMacLocation(candidate) {
  if (platform !== "darwin") return "";
  const normalized = path.posix.resolve(candidate);
  if (normalized === "/Volumes" || normalized.startsWith("/Volumes/")) {
    return "container engine command points to a mounted volume: " + normalized;
  }
  if (normalized.includes("/AppTranslocation/")) {
    return "container engine command points to an AppTranslocation path: " + normalized;
  }
  return "";
}

function inspectPath(candidate, allowDirectory) {
  const original = candidate;
  let current = candidate;
  for (let depth = 0; depth < workerData.maxSymlinkDepth; depth += 1) {
    const unsafeMessage = unsafeMacLocation(current);
    if (unsafeMessage) {
      return { kind: "unsafe", command: original, message: unsafeMessage };
    }
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { kind: "missing", command: original, message: "" };
    }
    if (!stat.isSymbolicLink()) {
      const usable = stat.isFile() || (allowDirectory && stat.isDirectory());
      return { kind: usable ? "found" : "missing", command: original, message: "" };
    }
    let link;
    try {
      link = fs.readlinkSync(current);
    } catch {
      return { kind: "missing", command: original, message: "" };
    }
    current = paths.isAbsolute(link)
      ? link
      : paths.resolve(paths.dirname(current), link);
  }
  return {
    kind: "missing",
    command: original,
    message: "container engine symlink chain is too deep: " + original
  };
}

function inspectDockerPlugins() {
  if (platform !== "darwin") return null;
  for (const pluginDir of workerData.pluginDirs) {
    const directoryInspection = inspectPath(pluginDir, true);
    if (directoryInspection.kind === "unsafe") return directoryInspection;
    if (directoryInspection.kind !== "found") continue;
    let entries;
    try {
      entries = fs.readdirSync(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .filter((candidate) => candidate.name.startsWith("docker-"))
      .slice(0, workerData.maxPluginCandidates)) {
      const inspection = inspectPath(path.posix.join(pluginDir, entry.name), false);
      if (inspection.kind === "unsafe") return inspection;
    }
  }
  return null;
}

let firstUnsafe = null;
let result = null;
for (const candidate of workerData.candidates) {
  const inspection = inspectPath(candidate, false);
  if (inspection.kind === "found") {
    result = workerData.engine === "docker"
      ? (inspectDockerPlugins() || inspection)
      : inspection;
    break;
  }
  if (!firstUnsafe && inspection.kind === "unsafe") firstUnsafe = inspection;
}
port.postMessage(result || firstUnsafe || { kind: "missing", command: "", message: "" });
port.close();
`;

function inspectEnginePathInWorker(
  engine: ContainerEngineName,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs: number
): Promise<CandidateInspection> {
  const paths = pathApi(platform);
  const candidates = [...new Set(
    splitPathList(env.PATH ?? env.Path, platform).flatMap((dirPath) =>
      commandBasenames(engine, platform).map((basename) => paths.join(dirPath, basename))
    )
  )].slice(0, CONTAINER_ENGINE_MAX_PATH_CANDIDATES);
  const fallbackCommand = candidates[0] ?? engine;

  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const worker = new Worker(CONTAINER_ENGINE_PATH_WORKER_SOURCE, {
      eval: true,
      workerData: {
        port: port2,
        engine,
        platform,
        candidates,
        pluginDirs: engine === "docker" ? getMacDockerPluginPathEntries(env) : [],
        maxPluginCandidates: CONTAINER_ENGINE_MAX_PLUGIN_CANDIDATES,
        maxSymlinkDepth: CONTAINER_ENGINE_MAX_SYMLINK_DEPTH
      },
      transferList: [port2]
    });
    const finish = (inspection: CandidateInspection) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      port1.close();
      worker.unref();
      resolve(inspection);
    };
    port1.once("message", (inspection: CandidateInspection) => finish(inspection));
    worker.once("error", (error) => finish({
      kind: "timeout",
      command: fallbackCommand,
      message: `container engine path worker failed: ${error.message}`
    }));
    worker.once("exit", (code) => {
      if (settled) {
        return;
      }
      const queued = receiveMessageOnPort(port1);
      finish(queued?.message as CandidateInspection | undefined ?? {
        kind: "timeout",
        command: fallbackCommand,
        message: `container engine path worker exited before reporting a result (code ${code})`
      });
    });
    timer = setTimeout(() => {
      // When Electron's event loop was busy, the worker may already have
      // completed even though its message callback could not run. Read the
      // queued result synchronously before treating the worker as timed out.
      const queued = receiveMessageOnPort(port1);
      if (queued) {
        finish(queued.message as CandidateInspection);
        return;
      }
      void worker.terminate();
      finish({
        kind: "timeout",
        command: fallbackCommand,
        message: `timed out while locating ${engine} or inspecting its CLI plugins`
      });
    }, Math.max(1, timeoutMs));
  });
}

function quoteWindowsCommandLineArg(value: string) {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

export function buildContainerEngineInvocation(
  engine: ContainerEngineResolution,
  args: string[],
  platform: NodeJS.Platform = engine.platform ?? process.platform
): ContainerEngineCommandInvocation {
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(engine.command)) {
    return {
      command: engine.env.ComSpec || process.env.ComSpec || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        ["call", quoteWindowsCommandLineArg(engine.command), ...args.map(quoteWindowsCommandLineArg)].join(" ")
      ],
      windowsVerbatimArguments: true
    };
  }
  return {
    command: engine.command,
    args
  };
}

function appendBounded(current: string, chunk: string, maxBytes: number) {
  if (Buffer.byteLength(current) >= maxBytes) {
    return current;
  }
  const remainingBytes = maxBytes - Buffer.byteLength(current);
  const buffer = Buffer.from(chunk);
  return current + buffer.subarray(0, remainingBytes).toString("utf8");
}

function terminateSpawnedProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn = spawn
) {
  const pid = child.pid;
  if (platform === "win32") {
    if (pid) {
      try {
        const killer = spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.once("error", () => {
          try {
            child.kill();
          } catch {
            // The direct process may already have exited.
          }
        });
        killer.unref();
        return;
      } catch {
        // Fall through to the direct child signal below.
      }
    }
    try {
      child.kill();
    } catch {
      // The direct process may already have exited.
    }
    return;
  }

  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct process when the process group is already gone.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The direct process may already have exited.
  }
}

async function runBoundedCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: ContainerEngineCommandOptions = {}
): Promise<ContainerEngineCommandResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? CONTAINER_ENGINE_PROBE_TIMEOUT_MS));
  const maxOutputBytes = Math.max(1024, Math.floor(options.maxOutputBytes ?? CONTAINER_ENGINE_MAX_OUTPUT_BYTES));

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        detached: platform !== "win32"
      });
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        elapsedMs: Date.now() - startedAt
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let outputDrainTimeout: NodeJS.Timeout | undefined;
    let exitResult: Omit<ContainerEngineCommandResult, "stdout" | "stderr" | "elapsedMs"> | null = null;
    const finish = (result: Omit<ContainerEngineCommandResult, "stdout" | "stderr" | "elapsedMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (outputDrainTimeout) {
        clearTimeout(outputDrainTimeout);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        ...result,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      finish({
        status: null,
        signal: null,
        error: error.message,
        timedOut: false
      });
    });
    child.once("exit", (status, signal) => {
      if (settled) {
        return;
      }
      exitResult = {
        status,
        signal,
        error: "",
        timedOut: false
      };
      outputDrainTimeout = setTimeout(() => {
        // A descendant can keep inherited stdout/stderr handles open after the
        // CLI exits. Bound that drain period and remove the leftover group.
        terminateSpawnedProcessTree(child, platform);
        finish(exitResult!);
      }, CONTAINER_ENGINE_OUTPUT_DRAIN_MS);
    });
    child.once("close", (status, signal) => {
      if (settled) {
        return;
      }
      finish(exitResult ?? {
        status,
        signal,
        error: "",
        timedOut: false
      });
    });

    timeout = setTimeout(() => {
      terminateSpawnedProcessTree(child, platform);
      child.unref();
      finish({
        status: null,
        signal: "SIGKILL",
        error: `container engine command timed out after ${timeoutMs}ms`,
        timedOut: true
      });
    }, timeoutMs);
  });
}

export function runContainerEngineCommand(
  engine: ContainerEngineResolution,
  args: string[],
  options: ContainerEngineCommandOptions = {}
) {
  const invocation = buildContainerEngineInvocation(engine, args, engine.platform);
  return runBoundedCommand(
    invocation.command,
    invocation.args,
    engine.env,
    engine.platform,
    {
      ...options,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    }
  );
}

function containerEngineProbeArgs(engine: ContainerEngineName) {
  return engine === "docker"
    ? ["version", "--format", "{{.Server.Version}}"]
    : ["version", "--format", "json"];
}

function probeCacheKey(options: ContainerEngineResolveOptions, env: NodeJS.ProcessEnv) {
  return [
    options.platform ?? process.platform,
    options.preferredName ?? "any",
    options.timeoutMs ?? CONTAINER_ENGINE_PROBE_TIMEOUT_MS,
    options.pathTimeoutMs ?? CONTAINER_ENGINE_PATH_TIMEOUT_MS,
    env.PATH ?? "",
    env.Path ?? "",
    env.DESKTOP_CONTAINER_ENGINE_PATHS ?? "",
    env.DOCKER_CLI_PLUGIN_EXTRA_DIRS ?? "",
    env.DOCKER_CONFIG ?? "",
    env.DOCKER_HOST ?? "",
    env.DOCKER_CONTEXT ?? "",
    env.CONTAINER_HOST ?? "",
    env.CONTAINER_CONNECTION ?? "",
    env.HOME ?? "",
    env.USERPROFILE ?? ""
  ].join("\0");
}

async function performContainerEngineProbe(
  options: ContainerEngineResolveOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<ContainerEngineProbeResult> {
  const timeoutMs = options.timeoutMs ?? CONTAINER_ENGINE_PROBE_TIMEOUT_MS;
  const pathTimeoutMs = options.pathTimeoutMs ?? CONTAINER_ENGINE_PATH_TIMEOUT_MS;
  const engineNames = options.preferredName
    ? [options.preferredName]
    : [...CONTAINER_ENGINES];
  const commandInspections = await Promise.all(
    engineNames.map((engine) =>
      inspectEnginePathInWorker(engine, env, platform, pathTimeoutMs)
    )
  );
  const resolutions = commandInspections.map((inspection, index) => {
    if (inspection.kind !== "found") {
      return null;
    }
    return {
      name: engineNames[index],
      command: inspection.command,
      env,
      platform
    } satisfies ContainerEngineResolution;
  });
  const commandResults = await Promise.all(
    resolutions.map((resolution) =>
      resolution
        ? runContainerEngineCommand(resolution, containerEngineProbeArgs(resolution.name), { timeoutMs })
        : Promise.resolve(null)
    )
  );
  const probes = engineNames.map((engine, index): ContainerEngineProbe => {
    const inspection = commandInspections[index];
    const commandResult = commandResults[index];
    if (!commandResult) {
      const failure = inspection.kind === "unsafe"
        ? "unsafe-location"
        : inspection.kind === "timeout" ? "path-timeout" : "not-installed";
      return {
        engine,
        command: inspection.command,
        installed: inspection.kind === "unsafe",
        reachable: false,
        message: inspection.message,
        failure,
        elapsedMs: 0
      };
    }

    const output = String(commandResult.stderr || commandResult.stdout || commandResult.error).trim();
    const reachable = commandResult.status === 0;
    return {
      engine,
      command: resolutions[index]?.command ?? "",
      installed: true,
      reachable,
      message: output,
      failure: reachable
        ? null
        : commandResult.timedOut
          ? "timeout"
          : commandResult.error ? "spawn-error" : "unreachable",
      elapsedMs: commandResult.elapsedMs
    };
  });
  const selectedIndex = probes.findIndex((probe) => probe.reachable);
  const resolution = selectedIndex >= 0 ? resolutions[selectedIndex] : null;
  return {
    engine: resolution?.name ?? "",
    resolution,
    probes
  };
}

export function clearContainerEngineProbeCache() {
  probeCacheGeneration += 1;
  probeCache.clear();
  inFlightProbes.clear();
}

export async function probeContainerEngines(
  options: ContainerEngineResolveOptions = {}
): Promise<ContainerEngineProbeResult> {
  if (probeOverrideForTests) {
    return probeOverrideForTests(options);
  }

  const platform = options.platform ?? process.platform;
  const env = buildContainerEngineEnv({ ...options, platform });
  const useCache = options.cache !== false;
  const key = probeCacheKey(options, env);
  const now = Date.now();
  if (useCache) {
    const cached = probeCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }
    const inFlight = inFlightProbes.get(key);
    if (inFlight) {
      return inFlight;
    }
  }

  const generation = probeCacheGeneration;
  const probe = performContainerEngineProbe(options, env, platform);
  if (!useCache) {
    return probe;
  }
  inFlightProbes.set(key, probe);
  try {
    const result = await probe;
    if (generation === probeCacheGeneration) {
      probeCache.set(key, {
        expiresAt: Date.now() + (result.engine
          ? CONTAINER_ENGINE_CACHE_SUCCESS_MS
          : CONTAINER_ENGINE_CACHE_MISS_MS),
        result
      });
    }
    return result;
  } finally {
    if (inFlightProbes.get(key) === probe) {
      inFlightProbes.delete(key);
    }
  }
}

export async function resolveContainerEngine(
  options: ContainerEngineResolveOptions = {}
): Promise<ContainerEngineResolution | null> {
  return (await probeContainerEngines(options)).resolution;
}

export const __containerEngineTestInternals = {
  inspectEnginePathInWorker,
  runBoundedCommand,
  terminateSpawnedProcessTree,
  setProbeOverrideForTests(override: ContainerEngineProbeOverride | null) {
    probeOverrideForTests = override;
    clearContainerEngineProbeCache();
  }
};
