import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function normalizePathForComparison(targetPath) {
  return targetPath.replaceAll("\\", "/");
}

function getExpectedElectronBinaryShape(platform) {
  switch (platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "node_modules/electron/dist/electron";
    case "win32":
      return "node_modules/electron/dist/electron.exe";
    default:
      return "a platform-specific Electron executable";
  }
}

export function validateElectronBinaryPath(platform, electronBinaryPath) {
  const normalizedPath = normalizePathForComparison(electronBinaryPath);

  switch (platform) {
    case "darwin":
      return {
        ok: normalizedPath.includes("/Electron.app/Contents/MacOS/"),
        expectedPathShape: getExpectedElectronBinaryShape(platform)
      };
    case "linux":
      return {
        ok:
          normalizedPath.endsWith("/dist/electron") &&
          !normalizedPath.includes(".app/Contents/MacOS/"),
        expectedPathShape: getExpectedElectronBinaryShape(platform)
      };
    case "win32":
      return {
        ok: normalizedPath.endsWith("/electron.exe"),
        expectedPathShape: getExpectedElectronBinaryShape(platform)
      };
    default:
      return {
        ok: true,
        expectedPathShape: getExpectedElectronBinaryShape(platform)
      };
  }
}

function buildSystemLabel(platform, arch) {
  return `${platform} ${arch}`;
}

function buildFixInstructions() {
  return [
    "Fix:",
    "  1. Delete node_modules",
    "  2. Run npm install on this machine"
  ];
}

export function buildInvalidElectronInstallationMessage({
  platform = process.platform,
  arch = process.arch,
  electronBinaryPath
}) {
  const { expectedPathShape } = validateElectronBinaryPath(platform, electronBinaryPath);

  return [
    "Invalid Electron installation for development startup.",
    `System: ${buildSystemLabel(platform, arch)}`,
    `Resolved Electron binary: ${electronBinaryPath}`,
    `Expected path shape: ${expectedPathShape}`,
    "This local dependency tree likely came from a different operating system.",
    ...buildFixInstructions()
  ].join("\n");
}

export function resolveElectronBinaryPath() {
  return require("electron");
}

export function resolveValidatedElectronBinaryPath({
  platform = process.platform,
  arch = process.arch
} = {}) {
  const electronBinaryPath = resolveElectronBinaryPath();
  const validation = validateElectronBinaryPath(platform, electronBinaryPath);

  if (!validation.ok) {
    throw new Error(
      buildInvalidElectronInstallationMessage({
        platform,
        arch,
        electronBinaryPath
      })
    );
  }

  return electronBinaryPath;
}

export function buildElectronSpawnErrorMessage({
  platform = process.platform,
  arch = process.arch,
  electronBinaryPath,
  error
}) {
  const validation = validateElectronBinaryPath(platform, electronBinaryPath);
  const lines = [
    "Failed to start Electron.",
    `System: ${buildSystemLabel(platform, arch)}`,
    `Resolved Electron binary: ${electronBinaryPath}`,
    `Original error: ${error.message}`
  ];

  if (!validation.ok) {
    lines.push("", buildInvalidElectronInstallationMessage({ platform, arch, electronBinaryPath }));
    return lines.join("\n");
  }

  lines.push(
    "",
    "If this local dependency tree was installed on another operating system or the Electron binary is corrupted, reinstall dependencies on this machine.",
    ...buildFixInstructions()
  );
  return lines.join("\n");
}
