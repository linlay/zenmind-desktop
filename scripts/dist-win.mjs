import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = process.cwd();
const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_DOCKER_BUN_PATH = "/tmp/zenmind-bundled-bun.exe";
const DOCKER_PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "all_proxy",
  "ALL_PROXY"
];
const DOCKER_HOST_PROXY_HOSTNAME = "host.docker.internal";

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

function getDockerProxyArgs(env = process.env) {
  const dockerProxyArgs = [];
  for (const key of DOCKER_PROXY_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) {
      continue;
    }
    dockerProxyArgs.push("--env", `${key}=${normalizeDockerProxyValue(value)}`);
  }
  return dockerProxyArgs;
}

function normalizeDockerProxyValue(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      url.hostname = DOCKER_HOST_PROXY_HOSTNAME;
      return url.toString();
    }
  } catch {
    // Leave non-URL proxy values unchanged.
  }
  return value;
}

export function resolveBundledWindowsBunPath(env = process.env) {
  const configuredPath = env.ZENMIND_DESKTOP_BUNDLED_BUN_PATH?.trim() ?? "";
  if (!configuredPath) {
    return null;
  }

  const absolutePath = path.resolve(configuredPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `未找到 Windows 版 bun.exe：${absolutePath}。请将 ZENMIND_DESKTOP_BUNDLED_BUN_PATH 指向可读取的 bun.exe。`
    );
  }
  if (!fs.statSync(absolutePath).isFile()) {
    throw new Error(
      `ZENMIND_DESKTOP_BUNDLED_BUN_PATH 必须指向单个 bun.exe 文件，当前得到的是：${absolutePath}`
    );
  }
  if (path.basename(absolutePath).toLowerCase() !== "bun.exe") {
    throw new Error(
      `ZENMIND_DESKTOP_BUNDLED_BUN_PATH 必须指向 Windows 版 bun.exe，当前文件名为：${path.basename(absolutePath)}`
    );
  }
  return absolutePath;
}

function ensureNonWindowsBundledBun() {
  const bundledBunPath = resolveBundledWindowsBunPath();
  if (bundledBunPath) {
    return bundledBunPath;
  }

  throw new Error(
    "非 Windows 主机构建 Windows 安装包时，必须先提供 Windows 版 bun.exe。请设置 " +
      "ZENMIND_DESKTOP_BUNDLED_BUN_PATH=/绝对路径/bun.exe 后再执行 npm run dist:win。"
  );
}

async function buildOnWindowsHost() {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"]);
  await runAndWait(npmCmd, ["run", "build"]);
  await runAndWait(npmCmd, ["exec", "electron-builder", "--", "--win", "--x64"]);
}

async function buildWithDocker() {
  const npmCacheDir = path.join(os.homedir(), ".npm");
  const electronBuilderCacheDir = getElectronBuilderCacheDir();
  const bundledBunPath = ensureNonWindowsBundledBun();

  fs.mkdirSync(npmCacheDir, { recursive: true });
  if (electronBuilderCacheDir != null) {
    fs.mkdirSync(electronBuilderCacheDir, { recursive: true });
  }

  const dockerArgs = [
    "run",
    "--rm",
    "--add-host",
    `${DOCKER_HOST_PROXY_HOSTNAME}:host-gateway`,
    "--volume",
    `${projectRoot}:/project`,
    "--volume",
    `${npmCacheDir}:/root/.npm`,
    "--volume",
    `${bundledBunPath}:${DEFAULT_DOCKER_BUN_PATH}:ro`,
    "--env",
    `ZENMIND_DESKTOP_BUNDLED_BUN_PATH=${DEFAULT_DOCKER_BUN_PATH}`
  ];
  dockerArgs.push(...getDockerProxyArgs());

  if (electronBuilderCacheDir != null) {
    dockerArgs.push("--volume", `${electronBuilderCacheDir}:/root/.cache/electron-builder`);
  }

  dockerArgs.push(
    "--workdir",
    "/project",
    "electronuserland/builder:wine",
    "/bin/bash",
    "-lc",
    [
      "npm install --force",
      "node ./scripts/sync-builtin-assets.mjs --os=windows --arch=amd64",
      "npm run build",
      "npx electron-builder --win --x64"
    ].join(" && ")
  );

  await runAndWait("docker", dockerArgs, { shell: false });
}

export async function main() {
  if (isWindows) {
    await buildOnWindowsHost();
    return;
  }
  await buildWithDocker();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  await main();
}
