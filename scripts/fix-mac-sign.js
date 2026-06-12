const { execFileSync, execSync } = require("child_process");
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

function getProjectRoot(context) {
  return context.packager?.projectDir || process.cwd();
}

function findFileRecursive(rootDir, fileName) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return "";
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const result = findFileRecursive(entryPath, fileName);
      if (result) {
        return result;
      }
    }
  }
  return "";
}

function getRceditExecutable() {
  const explicitPath = process.env.RCEDIT_EXE;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const fileName = process.arch === "ia32" ? "rcedit-ia32.exe" : "rcedit-x64.exe";
  const cacheRoots = [
    process.env.ELECTRON_BUILDER_CACHE,
    process.env.ELECTRON_BUILDER_CACHE ? path.join(process.env.ELECTRON_BUILDER_CACHE, "winCodeSign") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "winCodeSign") : "",
    process.env.HOME ? path.join(process.env.HOME, ".cache", "electron-builder", "winCodeSign") : ""
  ];

  for (const cacheRoot of cacheRoots) {
    const result = findFileRecursive(cacheRoot, fileName);
    if (result) {
      return result;
    }
  }
  return "";
}

function patchWindowsExecutableIcon(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(getProjectRoot(context), "build", "icons", "icon.ico");
  if (!fs.existsSync(exePath)) {
    throw new Error(`Windows executable not found for icon patch: ${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Windows app icon not found for icon patch: ${iconPath}`);
  }

  const rceditPath = getRceditExecutable();
  if (!rceditPath) {
    throw new Error("Unable to find cached rcedit executable. Build once with a populated electron-builder winCodeSign cache or set RCEDIT_EXE.");
  }

  if (process.platform === "win32") {
    execFileSync(rceditPath, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
  } else {
    // rcedit 是 Windows 程序，非 Windows 主机（如 wine 打包容器）需通过 wine 执行
    execFileSync("wine", [rceditPath, exePath, "--set-icon", iconPath], { stdio: "inherit" });
  }
  console.log(`[after-pack-cleanup] Applied Windows app icon to ${exePath}`);
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
  patchWindowsExecutableIcon(context);

  if (context.electronPlatformName !== "darwin") return;

  pruneUnusedElectronLocales(appPath);
  console.log(`[fix-mac-sign] Re-signing ${appPath} with ad-hoc identity...`);

  // Deep sign all nested frameworks/helpers first, then the app itself
  execSync(
    `codesign --force --deep --sign - "${appPath}"`,
    { stdio: "inherit" }
  );
};
