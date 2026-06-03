import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildServiceEnv
} from "./command-env";
import {
  IS_WINDOWS,
  windowsPowerShellPath
} from "./command-runner";

export type ProcessInstallDirMatch = "matched" | "mismatched" | "unknown";

function readProcessCommand(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return "";
  }

  const env = buildServiceEnv();

  try {
    if (IS_WINDOWS) {
      const query = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($null -ne $process) { @($process.ExecutablePath, $process.CommandLine) -join [Environment]::NewLine }"
      ].join("; ");
      const result = spawnSync(windowsPowerShellPath(), ["-NoProfile", "-Command", query], {
        encoding: "utf8",
        env,
        timeout: 3000
      });
      if (result.status !== 0 || result.error) {
        return "";
      }
      return result.stdout.trim();
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      env,
      timeout: 1500
    });
    if (result.status !== 0 || result.error) {
      return "";
    }
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function readWindowsProcessPath(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return "";
  }

  const env = buildServiceEnv();

  try {
    const query = `(Get-Process -Id ${pid} -ErrorAction Stop).Path`;
    const result = spawnSync(windowsPowerShellPath(), ["-NoProfile", "-Command", query], {
      encoding: "utf8",
      env,
      timeout: 1500
    });
    if (result.status !== 0 || result.error) {
      return "";
    }
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function normalizeProcessPath(value: string) {
  return path.normalize(value).replace(/\\/gu, "/");
}

function processIdentityMatchesInstallDir(identity: string, installDir: string) {
  const normalizedCommand = normalizeProcessPath(identity);
  const normalizedInstallDir = normalizeProcessPath(installDir);
  return IS_WINDOWS
    ? normalizedCommand.toLowerCase().includes(normalizedInstallDir.toLowerCase())
    : normalizedCommand.includes(normalizedInstallDir);
}

export function matchProcessInstallDir(pid: number, installDir: string): ProcessInstallDirMatch {
  if (IS_WINDOWS) {
    const processPath = readWindowsProcessPath(pid);
    if (processPath && processIdentityMatchesInstallDir(processPath, installDir)) {
      return "matched";
    }

    const command = readProcessCommand(pid);
    if (command && processIdentityMatchesInstallDir(command, installDir)) {
      return "matched";
    }

    if (processPath || command) {
      return "mismatched";
    }
    return "unknown";
  }

  const command = readProcessCommand(pid);
  if (!command) {
    return "unknown";
  }
  return processIdentityMatchesInstallDir(command, installDir) ? "matched" : "mismatched";
}

export function pidMatchesInstallDir(pid: number, installDir: string) {
  return matchProcessInstallDir(pid, installDir) === "matched";
}
