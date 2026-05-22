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
      ...(localAppData ? [path.join(localAppData, "Programs", "Docker", "Docker", "resources", "bin")] : [])
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
  const env = { ...baseEnv };
  const pathEntries = [
    ...splitPathList(baseEnv.ZENMIND_CONTAINER_ENGINE_PATHS),
    ...splitPathList(baseEnv.PATH),
    ...getDefaultContainerEnginePathEntries(options)
  ];
  env.PATH = [...new Set(pathEntries)].join(path.delimiter);
  return env;
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
    return "";
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean) ?? "";
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
