import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  brandBuildRoot,
  brandIconDir,
  brandResourcesDir,
  DARWIN_BUNDLE_DEVELOPMENT_REGION,
  DARWIN_BUNDLE_LOCALIZATIONS,
  loadBrandConfig,
  resolveBrandId
} from "../lib/brand-config.mjs";
import { createDesktopBuildMetadata, readDesktopVersion } from "../lib/build-metadata.mjs";
import { desktopBuiltinServicesDir } from "../lib/desktop-resources.mjs";

function escapePlistText(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function insertPlistRootEntry(plist, entry) {
  const rootClosingIndex = plist.lastIndexOf("</dict>");
  if (rootClosingIndex < 0) {
    throw new Error("invalid macOS Info.plist: missing root dictionary");
  }
  return `${plist.slice(0, rootClosingIndex)}${entry}\n${plist.slice(rootClosingIndex)}`;
}

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, "u");
  const escapedValue = escapePlistText(value);
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${escapedValue}$3`);
  }
  return insertPlistRootEntry(
    plist,
    `\t<key>${key}</key>\n\t<string>${escapedValue}</string>`
  );
}

function setPlistStringArray(plist, key, values) {
  const replacement = [
    `<key>${key}</key>`,
    "\t<array>",
    ...values.map((value) => `\t\t<string>${escapePlistText(value)}</string>`),
    "\t</array>"
  ].join("\n");
  const pattern = new RegExp(`<key>${key}</key>\\s*<array>[\\s\\S]*?</array>`, "u");
  if (pattern.test(plist)) {
    return plist.replace(pattern, replacement);
  }
  return insertPlistRootEntry(plist, `\t${replacement}`);
}

export function applyDarwinBundleLocalizationInfo(plist) {
  const withDevelopmentRegion = setPlistString(
    plist,
    "CFBundleDevelopmentRegion",
    DARWIN_BUNDLE_DEVELOPMENT_REGION
  );
  return setPlistStringArray(
    withDevelopmentRegion,
    "CFBundleLocalizations",
    DARWIN_BUNDLE_LOCALIZATIONS
  );
}

function plistEnvironmentEntry([key, value]) {
  return `    <key>${escapePlistText(key)}</key>\n    <string>${escapePlistText(value)}</string>`;
}

function setPlistEnvironment(plist, env) {
  const entries = Object.entries(env)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(plistEnvironmentEntry)
    .join("\n");
  const replacement = `<key>LSEnvironment</key>\n  <dict>\n${entries}\n  </dict>`;
  const pattern = /<key>LSEnvironment<\/key>\s*<dict>[\s\S]*?<\/dict>/u;
  if (pattern.test(plist)) {
    return plist.replace(pattern, replacement);
  }
  return insertPlistRootEntry(plist, `\t${replacement}`);
}

function fileHashPrefix(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 12);
}

function buildDarwinDevLaunchEnvironment(projectRoot, brand, serviceAssetsRoot) {
  return {
    MallocNanoZone: process.env.MallocNanoZone || "0",
    PATH: process.env.PATH || "",
    BRAND: brand.id,
    DESKTOP_BRAND_JSON: path.join(projectRoot, "build", "brands", brand.id, "generated", "brand.json"),
    DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
    DESKTOP_DEV_RESOURCES_ROOT: brandResourcesDir(projectRoot, brand),
    DESKTOP_NODE_BIN: process.env.DESKTOP_NODE_BIN || process.execPath,
    DESKTOP_CONVERSATION_SHARE_RELAY_URL:
      process.env.DESKTOP_CONVERSATION_SHARE_RELAY_URL || "",
    DESKTOP_CONVERSATION_SHARE_TOKEN_FILE:
      process.env.DESKTOP_CONVERSATION_SHARE_TOKEN_FILE || "",
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  };
}

export function prepareDarwinDevElectronApp(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  const devAppName = brand.productName;
  const devAppId = `${brand.appId}.dev`;
  const serviceAssetsRoot = desktopBuiltinServicesDir(projectRoot);
  const metadata = createDesktopBuildMetadata({
    productName: devAppName,
    version: readDesktopVersion(projectRoot)
  });
  const plistVersion = metadata.version.replace(/^v/iu, "");
  const macOsDir = path.dirname(electronBinary);
  const contentsDir = path.dirname(macOsDir);
  const sourceAppRoot = path.dirname(contentsDir);
  const targetAppRoot = path.join(brandBuildRoot(projectRoot, brand), "dev", `${devAppName}.app`);
  const targetContentsDir = path.join(targetAppRoot, "Contents");
  const targetResourcesDir = path.join(targetContentsDir, "Resources");
  const targetOriginalBinary = path.join(targetContentsDir, "MacOS", path.basename(electronBinary));
  const targetBinary = path.join(targetContentsDir, "MacOS", devAppName);
  const targetPlistPath = path.join(targetContentsDir, "Info.plist");
  const iconRoot = brandIconDir(projectRoot, brand);
  const sourceIconPath = path.join(iconRoot, "icon.icns");
  const sourceDockIconPath = path.join(iconRoot, "icon.png");

  fs.rmSync(targetAppRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetAppRoot), { recursive: true });
  fs.cpSync(sourceAppRoot, targetAppRoot, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(targetOriginalBinary, targetBinary);
  if (!fs.existsSync(sourceIconPath)) {
    throw new Error(`missing macOS app icon: ${sourceIconPath}`);
  }
  if (!fs.existsSync(sourceDockIconPath)) {
    throw new Error(`missing macOS dock icon: ${sourceDockIconPath}`);
  }
  const targetIconFileName = `icon-${fileHashPrefix(sourceIconPath)}.icns`;
  fs.mkdirSync(targetResourcesDir, { recursive: true });
  fs.copyFileSync(sourceIconPath, path.join(targetResourcesDir, targetIconFileName));
  fs.copyFileSync(sourceDockIconPath, path.join(targetResourcesDir, "icon.png"));

  let plist = fs.readFileSync(targetPlistPath, "utf8");
  plist = setPlistString(plist, "CFBundleName", devAppName);
  plist = setPlistString(plist, "CFBundleDisplayName", devAppName);
  plist = setPlistString(plist, "CFBundleIdentifier", devAppId);
  plist = setPlistString(plist, "CFBundleExecutable", devAppName);
  plist = setPlistString(plist, "CFBundleIconFile", targetIconFileName);
  plist = setPlistString(plist, "CFBundleShortVersionString", plistVersion);
  plist = setPlistString(plist, "CFBundleVersion", plistVersion);
  plist = applyDarwinBundleLocalizationInfo(plist);
  plist = setPlistEnvironment(plist, buildDarwinDevLaunchEnvironment(projectRoot, brand, serviceAssetsRoot));
  fs.writeFileSync(targetPlistPath, plist);

  return {
    appRoot: targetAppRoot,
    binaryPath: targetBinary,
    bundleId: devAppId
  };
}

export function prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  return prepareDarwinDevElectronApp(electronBinary, projectRoot, brand).binaryPath;
}

export function spawnElectron(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  const preparedApp = prepareDarwinDevElectronApp(electronBinary, projectRoot, brand);
  // LaunchServices is required for macOS to treat dev builds as foreground apps with Dock/menu identity.
  return spawn("open", ["-n", "-W", preparedApp.appRoot, "--args", projectRoot], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      BRAND: brand.id
    }
  });
}
