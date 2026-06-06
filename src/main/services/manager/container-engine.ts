import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beginStartupTiming } from "../../startup-timing";
import { buildServiceEnv } from "./command-env";
import { IS_WINDOWS } from "./command-runner";

let containerEngineDiagOnce = false;

type ContainerEngineProbe = {
  engine: string;
  command: string;
  installed: boolean;
  reachable: boolean;
  message: string;
};

type ContainerEngineProbeResult = {
  engine: string;
  probes: ContainerEngineProbe[];
};

type ContainerEngineProbeOptions = {
  cache?: boolean;
};

let cachedContainerEngineProbe: {
  key: string;
  result: ContainerEngineProbeResult;
} | null = null;

function getContainerEngineProbeCacheKey(env: NodeJS.ProcessEnv) {
  return [
    process.platform,
    env.PATH ?? "",
    env.Path ?? "",
    env.LOCALAPPDATA ?? "",
    env.HOME ?? ""
  ].join("\0");
}

export function clearContainerEngineProbeCache() {
  cachedContainerEngineProbe = null;
}

function getContainerEngineExecutableNames(name: string) {
  if (!IS_WINDOWS) {
    return [name];
  }
  return name.toLowerCase().endsWith(".exe") ? [name] : [`${name}.exe`, name];
}

function findCommandInServicePath(name: string, env: NodeJS.ProcessEnv) {
  for (const dirPath of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const executableName of getContainerEngineExecutableNames(name)) {
      const candidate = path.join(dirPath, executableName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore unreadable PATH entries and continue probing.
      }
    }
  }
  return "";
}

function resolveContainerEngineCommand(name: string, env: NodeJS.ProcessEnv, diagOnce: boolean) {
  const opts = { encoding: "utf8" as const, env };
  const r = IS_WINDOWS
    ? spawnSync("where.exe", [name], opts)
    : spawnSync("sh", ["-lc", `command -v ${name}`], opts);
  const located = r.status === 0 && !r.error
    ? r.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean) ?? name
    : "";
  const fallback = located ? "" : findCommandInServicePath(name, env);
  if (diagOnce) {
    console.log(`[container-engine] ${IS_WINDOWS ? "where.exe" : "command -v"} ${name} -> status=${r.status} stdout=${located} fallback=${fallback}`);
  }
  return located || fallback;
}

export function probeContainerEngines(options: ContainerEngineProbeOptions = {}) {
  const timing = beginStartupTiming("containerEngineAvailable", {}, { log: false });
  const env = buildServiceEnv();
  const cacheKey = options.cache ? getContainerEngineProbeCacheKey(env) : "";
  if (cacheKey && cachedContainerEngineProbe?.key === cacheKey) {
    timing.end({ engine: cachedContainerEngineProbe.result.engine || "none" });
    return cachedContainerEngineProbe.result;
  }

  const diagOnce = !containerEngineDiagOnce;
  containerEngineDiagOnce = true;
  if (diagOnce) {
    const pathPreview = (env.PATH ?? "").split(path.delimiter).slice(0, 8).join(" | ");
    console.log(`[container-engine] PATH(top 8): ${pathPreview}`);
  }

  let selectedEngine = "";
  const probes: ContainerEngineProbe[] = [];
  try {
    const reachable = (name: string, command: string) => {
      const start = Date.now();
      const r = spawnSync(command, ["info"], {
        encoding: "utf8",
        env,
        timeout: 15000,
        stdio: "pipe"
      });
      const ms = Date.now() - start;
      const message = String(r.stderr || r.stdout || r.error?.message || "").trim();
      if (diagOnce) {
        console.log(`[container-engine] ${name} info -> command=${command} status=${r.status} signal=${r.signal} elapsed=${ms}ms error=${r.error?.message ?? ""} detail=${message.split(/\r?\n/u)[0] ?? ""}`);
      }
      return {
        ok: r.status === 0,
        message
      };
    };

    for (const engine of ["docker", "podman"]) {
      const command = resolveContainerEngineCommand(engine, env, diagOnce);
      if (!command) {
        probes.push({
          engine,
          command: "",
          installed: false,
          reachable: false,
          message: ""
        });
        continue;
      }
      const result = reachable(engine, command);
      probes.push({
        engine,
        command,
        installed: true,
        reachable: result.ok,
        message: result.message
      });
      if (result.ok) {
        selectedEngine = engine;
        const result = { engine, probes };
        if (cacheKey) {
          cachedContainerEngineProbe = { key: cacheKey, result };
        }
        return result;
      }
    }

    const result = { engine: "", probes };
    if (cacheKey) {
      cachedContainerEngineProbe = { key: cacheKey, result };
    }
    return result;
  } finally {
    timing.end({ engine: selectedEngine || "none" });
  }
}

export function containerEngineAvailable(options: ContainerEngineProbeOptions = {}) {
  return probeContainerEngines(options).engine;
}
