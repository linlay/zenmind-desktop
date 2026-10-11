import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import plistPackage from "plist";
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
import { macDocumentTypes } from "../lib/document-file-associations.mjs";

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
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
  };
}

function prepareDarwinDevHelper(contentsDir) {
  const frameworks = path.join(contentsDir, "Frameworks");
  const helpers = fs.readdirSync(frameworks, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith(" Helper.app"));
  if (helpers.length !== 1) throw new Error("macOS dev app requires one generic Electron Helper");
  const helperContents = path.join(frameworks, helpers[0].name, "Contents");
  const plistPath = path.join(helperContents, "Info.plist");
  const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8", timeout: 10000
  }));
  if (info.LSUIElement !== true) throw new Error(`macOS dev Helper requires LSUIElement=true: ${plistPath}`);
  // Stock Electron can omit CFBundleExecutable. Declare the existing binary in
  // the copied dev bundle so the runtime can keep its strict background-Helper contract.
  const name = info.CFBundleExecutable === undefined
    ? helpers[0].name.slice(0, -".app".length)
    : info.CFBundleExecutable;
  if (typeof name !== "string" || !name || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error(`invalid macOS dev Helper CFBundleExecutable: ${plistPath}`);
  }
  const executable = path.join(helperContents, "MacOS", name);
  if (!fs.statSync(executable).isFile()) throw new Error(`macOS dev Helper executable is not a file: ${executable}`);
  fs.accessSync(executable, fs.constants.X_OK);
  if (info.CFBundleExecutable === undefined) {
    execFileSync("/usr/bin/plutil", ["-insert", "CFBundleExecutable", "-string", name, plistPath], {
      timeout: 10000
    });
  }
}

export function signDarwinDevElectronApp(appRoot) {
  // Re-seal the copied bundle after changing its identity, Helper metadata and
  // icons so macOS can validate the development app's privacy-permission identity.
  execFileSync("/usr/bin/codesign", [
    "--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", appRoot
  ], { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot], {
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function prepareDarwinDevElectronApp(
  electronBinary,
  projectRoot,
  brand = loadBrandConfig(projectRoot, resolveBrandId()),
  signApp = signDarwinDevElectronApp
) {
  const devAppName = brand.productName;
  const devAppId = `${brand.appId}.dev`;
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
  prepareDarwinDevHelper(targetContentsDir);
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
  const plistInfo = plistPackage.parse(plist);
  plistInfo.CFBundleDocumentTypes = macDocumentTypes(targetIconFileName);
  plist = plistPackage.build(plistInfo);
  // Runtime paths and PATH can change between launches. Keep them outside the
  // signed bundle so a new terminal/session does not invalidate saved TCC grants.
  plist = plist.replace(/<key>LSEnvironment<\/key>\s*<dict>[\s\S]*?<\/dict>/u, "");
  fs.writeFileSync(targetPlistPath, plist);
  // Finder cold launches have no --args <projectRoot>. Keep a stable dev entry
  // in the app, with changing launch environment stored outside the signed bundle.
  const launchEnvironmentPath = path.join(path.dirname(targetAppRoot), "launch-environment.json");
  fs.writeFileSync(launchEnvironmentPath, JSON.stringify(
    buildDarwinDevLaunchEnvironment(projectRoot, brand, desktopBuiltinServicesDir(projectRoot))
  ));
  const devEntryRoot = path.join(targetResourcesDir, "app");
  fs.mkdirSync(devEntryRoot, { recursive: true });
  fs.writeFileSync(path.join(devEntryRoot, "package.json"), JSON.stringify({
    name: brand.packageName || "desktop", version: plistVersion, main: "index.cjs"
  }));
  fs.writeFileSync(path.join(devEntryRoot, "index.cjs"), [
    `Object.assign(process.env, require(${JSON.stringify(launchEnvironmentPath)}));`,
    `process.chdir(${JSON.stringify(projectRoot)});`,
    `if (process.argv[1] !== ${JSON.stringify(projectRoot)}) process.argv.splice(1, 0, ${JSON.stringify(projectRoot)});`,
    `require('electron').app.setAppPath(${JSON.stringify(projectRoot)});`,
    `require(${JSON.stringify(path.join(projectRoot, "dist-electron", "main", "index.js"))});`,
    ""
  ].join("\n"));
  signApp(targetAppRoot);

  return {
    appRoot: targetAppRoot,
    binaryPath: targetBinary,
    bundleId: devAppId
  };
}

export function prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  return prepareDarwinDevElectronApp(electronBinary, projectRoot, brand).binaryPath;
}

export function buildDarwinDevOpenArgs(preparedApp, projectRoot, brand) {
  const launchEnvironment = buildDarwinDevLaunchEnvironment(projectRoot, brand, desktopBuiltinServicesDir(projectRoot));
  const environmentArgs = Object.entries(launchEnvironment)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return ["-n", "-W", ...environmentArgs, preparedApp.appRoot, "--args", projectRoot];
}

export function spawnElectron(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  const preparedApp = prepareDarwinDevElectronApp(electronBinary, projectRoot, brand);
  // LaunchServices is required for macOS to treat dev builds as foreground apps with Dock/menu identity.
  return spawn("open", buildDarwinDevOpenArgs(preparedApp, projectRoot, brand), {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      BRAND: brand.id
    }
  });
}
