const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ELECTRON_LOCALE_ALLOWLIST = new Set([
  "en.lproj",
  "zh_CN.lproj"
]);

const BUILDER_ARCH_NAMES = new Map([
  [0, "ia32"],
  [1, "x64"],
  [2, "armv7l"],
  [3, "arm64"],
  [4, "universal"],
  ["0", "ia32"],
  ["1", "x64"],
  ["2", "armv7l"],
  ["3", "arm64"],
  ["4", "universal"]
]);

function removeDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  const bytes = dirSize(dirPath);
  fs.rmSync(dirPath, { recursive: true, force: true });
  return bytes;
}

function dirSize(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(entryPath);
    } else if (entry.isFile()) {
      total += fs.statSync(entryPath).size;
    }
  }
  return total;
}

function normalizeArch(arch) {
  return BUILDER_ARCH_NAMES.get(arch) ?? String(arch ?? "");
}

function expectedCanvasRuntimePackage(platformName, arch) {
  const key = `${platformName}/${normalizeArch(arch)}`;
  switch (key) {
    case "darwin/arm64":
      return "canvas-darwin-arm64";
    case "darwin/x64":
      return "canvas-darwin-x64";
    case "win32/arm64":
      return "canvas-win32-arm64-msvc";
    case "win32/x64":
      return "canvas-win32-x64-msvc";
    default:
      return "";
  }
}

function getAppPath(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  }
  return context.appOutDir;
}

function getResourcesRoot(context, appPath) {
  if (context.electronPlatformName === "darwin") {
    return path.join(appPath, "Contents", "Resources");
  }
  return path.join(appPath, "resources");
}

function pruneUnusedCanvasRuntimes(context, resourcesRoot) {
  const expectedRuntime = expectedCanvasRuntimePackage(context.electronPlatformName, context.arch);
  if (!expectedRuntime) {
    return;
  }

  const napiRoot = path.join(
    resourcesRoot,
    "app.asar.unpacked",
    "node_modules",
    "@napi-rs"
  );
  if (!fs.existsSync(napiRoot)) {
    return;
  }

  const removed = [];
  for (const entry of fs.readdirSync(napiRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("canvas-") || entry.name === expectedRuntime) {
      continue;
    }
    const bytes = removeDir(path.join(napiRoot, entry.name));
    removed.push(`${entry.name} (${formatBytes(bytes)})`);
  }

  if (removed.length > 0) {
    console.log(`[after-pack-cleanup] Removed unused canvas runtimes: ${removed.join(", ")}`);
  }
}

function pruneUnusedElectronLocales(appPath) {
  const resourcesRoot = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources"
  );
  if (!fs.existsSync(resourcesRoot)) {
    return;
  }

  let removedCount = 0;
  let removedBytes = 0;
  for (const entry of fs.readdirSync(resourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj") || ELECTRON_LOCALE_ALLOWLIST.has(entry.name)) {
      continue;
    }
    removedBytes += removeDir(path.join(resourcesRoot, entry.name));
    removedCount += 1;
  }

  if (removedCount > 0) {
    console.log(`[after-pack-cleanup] Removed ${removedCount} unused Electron locale directories (${formatBytes(removedBytes)})`);
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

exports.default = async function (context) {
  const appPath = getAppPath(context);
  pruneUnusedCanvasRuntimes(context, getResourcesRoot(context, appPath));

  if (context.electronPlatformName !== "darwin") return;

  pruneUnusedElectronLocales(appPath);
  console.log(`[fix-mac-sign] Re-signing ${appPath} with ad-hoc identity...`);

  // Deep sign all nested frameworks/helpers first, then the app itself
  execSync(
    `codesign --force --deep --sign - "${appPath}"`,
    { stdio: "inherit" }
  );
};
