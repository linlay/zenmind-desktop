import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const workspaceRoot = path.resolve(projectRoot, "..");
const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

function run(cmd, args, options = {}) {
  return spawn(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
    ...options
  });
}

function runAndWait(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = run(cmd, args, options);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? -1}`));
    });
    child.once("error", reject);
  });
}

function getElectronBuilderCacheDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "electron-builder");
  }
  if (process.platform === "linux") {
    return process.env.XDG_CACHE_HOME != null
      ? path.join(process.env.XDG_CACHE_HOME, "electron-builder")
      : path.join(os.homedir(), ".cache", "electron-builder");
  }
  return null;
}

async function syncWindowsBuiltinAssets() {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"]);
  await runAndWait(npmCmd, ["run", "sync:plugins", "--", "--os=windows", "--arch=amd64"]);
}

async function buildOnWindowsHost() {
  await syncWindowsBuiltinAssets();
  await runAndWait(npmCmd, ["run", "build"]);
  await runAndWait(npmCmd, ["exec", "electron-builder", "--", "--win", "--x64"]);
}

async function buildWithDocker() {
  await syncWindowsBuiltinAssets();

  const npmCacheDir = path.join(os.homedir(), ".npm");
  const electronBuilderCacheDir = getElectronBuilderCacheDir();

  fs.mkdirSync(npmCacheDir, { recursive: true });
  if (electronBuilderCacheDir != null) {
    fs.mkdirSync(electronBuilderCacheDir, { recursive: true });
  }

  const dockerArgs = [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--volume",
    `${workspaceRoot}:/workspace`,
    "--volume",
    `${npmCacheDir}:/root/.npm`
  ];

  if (electronBuilderCacheDir != null) {
    dockerArgs.push("--volume", `${electronBuilderCacheDir}:/root/.cache/electron-builder`);
  }

  dockerArgs.push(
    "--workdir",
    "/workspace/zenmind-desktop",
    "electronuserland/builder:wine",
    "/bin/bash",
    "-lc",
    [
      "npm install",
      "npm run build",
      "npx electron-builder --win --x64"
    ].join(" && ")
  );

  await runAndWait("docker", dockerArgs, { shell: false });
}

if (isWindows) {
  await buildOnWindowsHost();
} else {
  await buildWithDocker();
}
