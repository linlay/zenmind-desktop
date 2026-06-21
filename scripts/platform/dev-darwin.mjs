import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { brandBuildRoot, brandIconDir, loadBrandConfig, resolveBrandId } from "../lib/brand-config.mjs";
import { createDesktopBuildMetadata, readDesktopVersion } from "../lib/build-metadata.mjs";
import { desktopBuiltinServicesDir } from "../lib/desktop-resources.mjs";

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, "u");
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${value}$3`);
  }
  return plist.replace("</dict>", `<key>${key}</key><string>${value}</string></dict>`);
}

function fileHashPrefix(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 12);
}

export function prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
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
  fs.writeFileSync(targetPlistPath, plist);

  return targetBinary;
}

export function spawnElectron(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  const serviceAssetsRoot = desktopBuiltinServicesDir(projectRoot);
  return spawn(prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand), ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
