import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CONTAINER_ENGINES = ["docker", "podman"] as const;

export type ContainerEngineName = typeof CONTAINER_ENGINES[number];

export type ContainerEngineResolution = {
  name: ContainerEngineName;
  command: string;
  env: NodeJS.ProcessEnv;
};

type ContainerEnginePathOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type ContainerEngineResolveOptions = ContainerEnginePathOptions & {
  timeoutMs?: number;
};

function splitPathList(value: string | undefined) {
  return (value ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export function getDefaultContainerEnginePathEntries(options: ContainerEnginePathOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const localAppData = env.LOCALAPPDATA ?? "";
    return [
      path.join(programFiles, "Docker", "Docker", "resources", "bin"),
      path.join(programFiles, "RedHat", "Podman"),
      path.join(programFiles, "Podman"),
      ...(localAppData ? [
        path.join(localAppData, "Programs", "Docker", "Docker", "resources", "bin"),
        path.join(localAppData, "Programs", "Podman"),
        path.join(localAppData, "Programs", "RedHat", "Podman")
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
    ...splitPathList(baseEnv.ZENMIND_CONTAINER_ENGINE_PATHS),
    ...splitPathList(currentPath),
    ...getDefaultContainerEnginePathEntries({ ...options, platform })
  ];
  env.PATH = [...new Set(pathEntries)].join(path.delimiter);
  if (platform === "win32") {
    env.Path = env.PATH;
  }
  return env;
}

function commandBasenames(command: string, platform: NodeJS.Platform) {
  if (platform !== "win32") {
    return [command];
  }
  return command.toLowerCase().endsWith(".exe") ? [command] : [`${command}.exe`, command];
}

function findCommandInPathEntries(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const pathEntries = splitPathList(env.PATH);
  for (const dirPath of pathEntries) {
    for (const basename of commandBasenames(command, platform)) {
      const candidate = path.join(dirPath, basename);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Keep scanning other candidates when a PATH entry is unreadable.
      }
    }
  }
  return "";
}

function resolveCommandPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const locator = platform === "win32" ? "where.exe" : "/bin/sh";
  const args = platform === "win32" ? [command] : ["-c", `command -v ${command}`];
  const result = spawnSync(locator, args, {
    encoding: "utf8",
    env,
    timeout: 1_500
  });
  if (result.status !== 0 || result.error) {
    return findCommandInPathEntries(command, env, platform);
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean) ?? findCommandInPathEntries(command, env, platform);
}

export function resolveContainerEngine(options: ContainerEngineResolveOptions = {}): ContainerEngineResolution | null {
  const platform = options.platform ?? process.platform;
  const env = buildContainerEngineEnv(options);
  const timeoutMs = options.timeoutMs ?? 5_000;

  for (const name of CONTAINER_ENGINES) {
    const command = resolveCommandPath(name, env, platform);
    if (!command) {
      continue;
    }
    const result = spawnSync(command, ["info"], {
      encoding: "utf8",
      env,
      stdio: "ignore",
      timeout: timeoutMs
    });
    if (result.status === 0) {
      return {
        name,
        command,
        env
      };
    }
  }

  return null;
}
