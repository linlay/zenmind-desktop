import { execFileSync } from "node:child_process";
import process from "node:process";

export function isWindows() {
  return process.platform === "win32";
}

export function hostPlatform() {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "darwin";
  }
  return "linux";
}

export function hostArch() {
  if (process.platform !== "darwin") {
    return normalizeArch(process.arch);
  }

  try {
    const translated = execFileSync("sysctl", ["-in", "sysctl.proc_translated"], { encoding: "utf8" }).trim();
    if (translated === "1") {
      return "arm64";
    }
  } catch {
    // Continue with other host-architecture probes.
  }

  try {
    const arm64Capable = execFileSync("sysctl", ["-in", "hw.optional.arm64"], { encoding: "utf8" }).trim();
    if (arm64Capable === "1") {
      return "arm64";
    }
  } catch {
    // Continue with uname fallback when sysctl keys are unavailable.
  }

  try {
    const machine = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
    if (machine === "arm64" || machine === "aarch64") {
      return "arm64";
    }
    if (machine === "x86_64" || machine === "amd64") {
      return "amd64";
    }
  } catch {
    // Fall back to the Node architecture when uname is unavailable.
  }

  return normalizeArch(process.arch);
}

export function syncOsLabel() {
  return hostPlatform();
}

function normalizeArch(arch) {
  return arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
}
