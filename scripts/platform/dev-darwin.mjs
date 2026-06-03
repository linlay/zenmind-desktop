import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadBrandConfig, resolveBrandId } from "../lib/brand-config.mjs";

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, "u");
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${value}$3`);
  }
  return plist.replace("</dict>", `<key>${key}</key><string>${value}</string></dict>`);
}

export function prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  const devAppName = brand.productName;
  const devAppId = `${brand.appId}.dev`;
  const macOsDir = path.dirname(electronBinary);
  const contentsDir = path.dirname(macOsDir);
  const sourceAppRoot = path.dirname(contentsDir);
  const targetAppRoot = path.join(projectRoot, "build", "dev", `${devAppName}.app`);
  const targetContentsDir = path.join(targetAppRoot, "Contents");
  const targetOriginalBinary = path.join(targetContentsDir, "MacOS", path.basename(electronBinary));
  const targetBinary = path.join(targetContentsDir, "MacOS", devAppName);
  const targetPlistPath = path.join(targetContentsDir, "Info.plist");

  fs.rmSync(targetAppRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetAppRoot), { recursive: true });
  fs.cpSync(sourceAppRoot, targetAppRoot, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(targetOriginalBinary, targetBinary);

  let plist = fs.readFileSync(targetPlistPath, "utf8");
  plist = setPlistString(plist, "CFBundleName", devAppName);
  plist = setPlistString(plist, "CFBundleDisplayName", devAppName);
  plist = setPlistString(plist, "CFBundleIdentifier", devAppId);
  plist = setPlistString(plist, "CFBundleExecutable", devAppName);
  fs.writeFileSync(targetPlistPath, plist);

  return targetBinary;
}

export function spawnElectron(electronBinary, projectRoot, brand = loadBrandConfig(projectRoot, resolveBrandId())) {
  return spawn(prepareDarwinDevElectronBinary(electronBinary, projectRoot, brand), ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DESKTOP_BUILTIN_ASSETS_ROOT: path.join(projectRoot, "build", "resources", "services"),
      ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT: path.join(projectRoot, "build", "resources", "services"),
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
