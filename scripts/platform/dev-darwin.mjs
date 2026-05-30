import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEV_APP_NAME = "ZenMind";
const DEV_APP_ID = "cc.zenmind.desktop.dev";

function setPlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, "u");
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${value}$3`);
  }
  return plist.replace("</dict>", `<key>${key}</key><string>${value}</string></dict>`);
}

export function prepareDarwinDevElectronBinary(electronBinary, projectRoot) {
  const macOsDir = path.dirname(electronBinary);
  const contentsDir = path.dirname(macOsDir);
  const sourceAppRoot = path.dirname(contentsDir);
  const targetAppRoot = path.join(projectRoot, "build", "dev", `${DEV_APP_NAME}.app`);
  const targetContentsDir = path.join(targetAppRoot, "Contents");
  const targetOriginalBinary = path.join(targetContentsDir, "MacOS", path.basename(electronBinary));
  const targetBinary = path.join(targetContentsDir, "MacOS", DEV_APP_NAME);
  const targetPlistPath = path.join(targetContentsDir, "Info.plist");

  fs.rmSync(targetAppRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetAppRoot), { recursive: true });
  fs.cpSync(sourceAppRoot, targetAppRoot, { recursive: true, verbatimSymlinks: true });
  fs.renameSync(targetOriginalBinary, targetBinary);

  let plist = fs.readFileSync(targetPlistPath, "utf8");
  plist = setPlistString(plist, "CFBundleName", DEV_APP_NAME);
  plist = setPlistString(plist, "CFBundleDisplayName", DEV_APP_NAME);
  plist = setPlistString(plist, "CFBundleIdentifier", DEV_APP_ID);
  plist = setPlistString(plist, "CFBundleExecutable", DEV_APP_NAME);
  fs.writeFileSync(targetPlistPath, plist);

  return targetBinary;
}

export function spawnElectron(electronBinary, projectRoot) {
  return spawn(prepareDarwinDevElectronBinary(electronBinary, projectRoot), ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT: path.join(projectRoot, "build", "resources", "services"),
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
