import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_SOURCE_ROOT = path.resolve(process.cwd(), "..", "claude-code-guotai");

function normalizeTargetOs(value = process.platform) {
  switch (value) {
    case "win32":
    case "windows":
      return "windows";
    case "darwin":
    case "mac":
    case "macos":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return value;
  }
}

function normalizeTargetArch(value = process.arch) {
  switch (value) {
    case "x64":
    case "x86_64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return value;
  }
}

function commandOutput(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    ...options
  }).trim();
}

function getBunBinaryName(targetOs) {
  return targetOs === "windows" ? "bun.exe" : "bun";
}

function detectHostTargetArch() {
  if (process.platform !== "darwin") {
    return normalizeTargetArch(os.arch());
  }

  try {
    const arm64Host = commandOutput("arch", ["-arm64", "uname", "-m"]);
    if (arm64Host === "arm64" || arm64Host === "aarch64") {
      return "arm64";
    }
  } catch {
    // Fall through to the next probe.
  }

  try {
    const translated = commandOutput("sysctl", ["-in", "sysctl.proc_translated"]);
    if (translated === "1") {
      return "arm64";
    }
  } catch {
    // Fall through to the next probe.
  }

  try {
    const arm64Capable = commandOutput("sysctl", ["-in", "hw.optional.arm64"]);
    if (arm64Capable === "1") {
      return "arm64";
    }
  } catch {
    // Fall through to uname when sysctl is unavailable.
  }

  try {
    const machine = commandOutput("uname", ["-m"]);
    if (machine === "arm64" || machine === "aarch64") {
      return "arm64";
    }
    if (machine === "x86_64" || machine === "amd64") {
      return "amd64";
    }
  } catch {
    // Fall back to the Node architecture below.
  }

  return normalizeTargetArch(os.arch());
}

function resolveHostBuildBunPath() {
  const explicitPath = process.env.ZENMIND_DESKTOP_BUILD_BUN_PATH;
  if (explicitPath) {
    return explicitPath;
  }

  if (process.platform === "win32") {
    const resolved = commandOutput("where.exe", ["bun"]);
    if (resolved) {
      return resolved.split(/\r?\n/u)[0];
    }
  } else {
    const resolved = commandOutput("sh", ["-lc", "command -v bun"]);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("未检测到可用于构建代码助手运行时的 Bun。");
}

function resolveBundledBunPath({ targetOs, targetArch, explicitPath }) {
  if (explicitPath) {
    return explicitPath;
  }

  const hostOs = normalizeTargetOs(os.platform());
  const hostArch = detectHostTargetArch();
  if (hostOs !== targetOs || hostArch !== targetArch) {
    throw new Error(
      `无法为 ${targetOs}/${targetArch} 自动定位 Bun，请通过 --bun 或 ZENMIND_DESKTOP_BUNDLED_BUN_PATH 显式指定。`
    );
  }

  if (process.platform === "win32") {
    const resolved = commandOutput("where.exe", ["bun"]);
    if (resolved) {
      return resolved.split(/\r?\n/u)[0];
    }
  } else {
    const resolved = commandOutput("sh", ["-lc", "command -v bun"]);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("未检测到 Bun，可通过 --bun 指定要打包的 Bun 二进制路径。");
}

function findRelayChunkFile(distRoot) {
  for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const filePath = path.join(distRoot, entry.name);
    const content = fs.readFileSync(filePath, "utf8");
    if (/export\s*\{[\s\S]*\bstartRelayServer\b[\s\S]*\}/u.test(content)) {
      return entry.name;
    }
  }
  throw new Error(`未在 ${distRoot} 中找到可导出 startRelayServer 的构建产物。`);
}

function latestMtimeMs(filePaths) {
  return filePaths.reduce((max, filePath) => {
    if (!fs.existsSync(filePath)) {
      return max;
    }
    const stats = fs.statSync(filePath);
    let nextMax = Math.max(max, stats.mtimeMs);
    if (!stats.isDirectory()) {
      return nextMax;
    }
    for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
      nextMax = Math.max(nextMax, latestMtimeMs([path.join(filePath, entry.name)]));
    }
    return nextMax;
  }, 0);
}

function ensureRuntimeBuildUpToDate(sourceRoot) {
  const distCliPath = path.join(sourceRoot, "dist", "cli.js");
  const buildInputs = [
    path.join(sourceRoot, "package.json"),
    path.join(sourceRoot, "build.ts"),
    path.join(sourceRoot, "src")
  ];
  const distMtimeMs = fs.existsSync(distCliPath) ? fs.statSync(distCliPath).mtimeMs : 0;
  const sourceMtimeMs = latestMtimeMs(buildInputs);
  if (distMtimeMs >= sourceMtimeMs) {
    return;
  }

  execFileSync(resolveHostBuildBunPath(), ["run", "build"], {
    cwd: sourceRoot,
    stdio: "inherit",
    env: process.env
  });
}

export function syncCodeAssistantRuntime(
  projectRoot = process.cwd(),
  {
    os: targetOs = normalizeTargetOs(),
    arch: targetArch = normalizeTargetArch(),
    sourceRoot = process.env.ZENMIND_DESKTOP_CODE_ASSISTANT_SOURCE_ROOT ?? DEFAULT_SOURCE_ROOT,
    bunPath = process.env.ZENMIND_DESKTOP_BUNDLED_BUN_PATH
  } = {}
) {
  const normalizedOs = normalizeTargetOs(targetOs);
  const normalizedArch = normalizeTargetArch(targetArch);
  const runtimeSourceRoot = path.resolve(sourceRoot);

  const outputRoot = path.join(projectRoot, "build", "resources", "code-assistant-runtime");
  const existingManifestPath = path.join(outputRoot, "manifest.json");
  const existingBundledCli = path.join(outputRoot, "claude-code-guotai", "dist", "cli.js");
  const existingBundledBun = path.join(outputRoot, "bun", getBunBinaryName(normalizedOs));
  const hasExistingArtifacts =
    fs.existsSync(existingManifestPath) &&
    fs.existsSync(existingBundledCli) &&
    fs.existsSync(existingBundledBun);
  const sourceRootExists = fs.existsSync(runtimeSourceRoot);

  if (!sourceRootExists && hasExistingArtifacts) {
    console.log(
      `[code-assistant-runtime] 未找到源码目录 ${runtimeSourceRoot}，复用已有产物 ${outputRoot}`
    );
    return JSON.parse(fs.readFileSync(existingManifestPath, "utf8"));
  }

  // 同事首次 clone 本仓库但未同时 clone claude-code-guotai 时，既没有源码也没有旧产物。
  // 此时不抛错，改为打印警告并跳过，让 `npm run dev` 能继续跑；代码助手功能将在运行期提示缺失。
  const allowSkip = process.env.ZENMIND_DESKTOP_ALLOW_MISSING_CODE_ASSISTANT !== "0";
  if (!sourceRootExists && !hasExistingArtifacts && allowSkip) {
    console.warn(
      `[code-assistant-runtime] 未找到源码目录 ${runtimeSourceRoot}，已跳过代码助手运行时同步。` +
        `如需启用代码助手，请将 claude-code-guotai clone 到上述路径，或通过 ZENMIND_DESKTOP_CODE_ASSISTANT_SOURCE_ROOT 指定源码目录，然后重新执行 npm run sync:assets。`
    );
    return {
      skipped: true,
      reason: "source-missing",
      sourceRoot: runtimeSourceRoot,
      platform: { os: normalizedOs, arch: normalizedArch }
    };
  }

  ensureRuntimeBuildUpToDate(runtimeSourceRoot);
  const distRoot = path.join(runtimeSourceRoot, "dist");
  const cliPath = path.join(distRoot, "cli.js");
  if (!fs.existsSync(cliPath)) {
    if (allowSkip && !hasExistingArtifacts) {
      console.warn(
        `[code-assistant-runtime] 未找到代码助手构建产物 ${cliPath}，已跳过同步。请先在 ${runtimeSourceRoot} 中执行 bun run build 或使用 ZENMIND_DESKTOP_ALLOW_MISSING_CODE_ASSISTANT=0 强制报错。`
      );
      return {
        skipped: true,
        reason: "dist-missing",
        sourceRoot: runtimeSourceRoot,
        platform: { os: normalizedOs, arch: normalizedArch }
      };
    }
    throw new Error(`缺少代码助手 dist/cli.js：${cliPath}`);
  }

  const bundledRuntimeRoot = path.join(outputRoot, "claude-code-guotai");
  const bundledBunPath = resolveBundledBunPath({
    targetOs: normalizedOs,
    targetArch: normalizedArch,
    explicitPath: bunPath
  });
  const relayChunkFile = findRelayChunkFile(distRoot);
  const targetBunPath = path.join(outputRoot, "bun", getBunBinaryName(normalizedOs));

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundledRuntimeRoot, "desktop"), { recursive: true });
  fs.mkdirSync(path.dirname(targetBunPath), { recursive: true });

  fs.cpSync(distRoot, path.join(bundledRuntimeRoot, "dist"), {
    recursive: true,
    force: true
  });
  fs.writeFileSync(
    path.join(bundledRuntimeRoot, "desktop", "relay-entry.mjs"),
    `export { startRelayServer } from "../dist/${relayChunkFile}";\n`,
    "utf8"
  );

  fs.copyFileSync(bundledBunPath, targetBunPath);
  if (normalizedOs !== "windows") {
    fs.chmodSync(targetBunPath, 0o755);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    platform: {
      os: normalizedOs,
      arch: normalizedArch
    },
    sourceRoot: runtimeSourceRoot,
    relayChunkFile,
    files: {
      cli: "claude-code-guotai/dist/cli.js",
      relayEntrypoint: "claude-code-guotai/desktop/relay-entry.mjs",
      bun: `bun/${path.basename(targetBunPath)}`
    }
  };

  fs.writeFileSync(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  return manifest;
}
