import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type {
  App,
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue
} from "electron";
import type {
  CodeAssistantCommandResult,
  CodeAssistantRepoCommandResult,
  CodeAssistantRepoContext,
  CodeAssistantStatus,
  Manifest,
  ServiceState
} from "../shared/contracts";
import { readEnvFile } from "./env-file";
import { getPluginsRoot } from "./user-paths";

export const CLAUDE_CODE_RELAY_PLUGIN_ID = "claude-code-relay";
export const CLAUDE_CODE_RELAY_PLUGIN_NAME = "代码助手";

const CLAUDE_CODE_RELAY_PLUGIN_VERSION = "local-dev-v1";
const CODE_ASSISTANT_AGENT_KEY = "codeAssistant";
const DEFAULT_REPO_PATH = "/Users/jialin/Desktop/claude-code-guotai";
const BUNDLED_RUNTIME_ROOT_ENV_KEY = "ZENMIND_DESKTOP_CODE_ASSISTANT_RUNTIME_ROOT";
const BUNDLED_RUNTIME_RESOURCE_DIR = "code-assistant-runtime";
const BUNDLED_RUNTIME_DIRNAME = "claude-code-guotai";
const BUNDLED_RUNTIME_INSTALL_DIRNAME = "runtime";
const BUNDLED_BUN_DIRNAME = "bun";
const MANAGED_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
const MANAGED_ANTHROPIC_API_KEY = "sk-cp-MrreVGwHO4N3UzVS9MxR8kKvLsBEIRatEDFxmR__QY0n3NdU0YJ1XZiEprdo4jCr3URdwM2UAOkyVxpMqEyQKd3vXue1T2WreNAN-yD4wA47QcZ1ZROcXQw";
const MANAGED_ANTHROPIC_MODEL = "MiniMax-M2.7";
const DEFAULT_RELAY_PORT = 3210;
const DEFAULT_DASHBOARD_PORT = 3456;
const DEFAULT_AGENT_TIMEOUT_MS = 300000;

type ManagedClaudeCodeRelayConfig = {
  repoPath: string;
  workingDirectory: string;
  relayPort: number;
  dashboardPort: number;
  authToken: string;
  fullAccessGranted: boolean;
  enabled: boolean;
  userSelectedRepo: boolean;
};

type EnsureCodeAssistantReadyDeps = {
  getServiceState: (app: App, serviceId: string) => Promise<ServiceState>;
  initializeService: (app: App, serviceId: string) => Promise<{ ok: boolean; message: string }>;
  startService: (app: App, serviceId: string) => Promise<{ ok: boolean; message: string }>;
  stopService: (app: App, serviceId: string) => Promise<{ ok: boolean; message: string }>;
  showMessageBox: (
    ownerWindow: BrowserWindow | null,
    options: MessageBoxOptions
  ) => Promise<MessageBoxReturnValue>;
};

type SetCodeAssistantEnabledDeps = EnsureCodeAssistantReadyDeps;

type RelayConnectionState = {
  cliConnected: boolean;
  relayReachable: boolean;
  error: string;
};

function getPluginRoot(app: App) {
  return path.join(getPluginsRoot(app), CLAUDE_CODE_RELAY_PLUGIN_ID);
}


function parseRelayStatusPayload(payload: unknown) {
  const topLevel = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!topLevel) {
    return {
      cliConnected: false
    };
  }

  if (topLevel.cli_connected === true) {
    return {
      cliConnected: true
    };
  }

  const nestedData =
    topLevel.data && typeof topLevel.data === "object"
      ? (topLevel.data as Record<string, unknown>)
      : null;

  return {
    cliConnected: nestedData?.cli_connected === true
  };
}

function getManagedConfigPath(app: App) {
  return path.join(getPluginRoot(app), "managed-config.json");
}

function getManagedConfigTemplatePath(app: App) {
  return path.join(getPluginRoot(app), "managed-config.template.json");
}

function getBundledRuntimeBinaryName() {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function getBundledRuntimeInstallRoot(app: App) {
  return path.join(getPluginRoot(app), BUNDLED_RUNTIME_INSTALL_DIRNAME);
}

function getBundledCodeAssistantRuntimePath(app: App) {
  return path.join(getBundledRuntimeInstallRoot(app), BUNDLED_RUNTIME_DIRNAME);
}

function getBundledBunPath(app: App) {
  return path.join(getBundledRuntimeInstallRoot(app), BUNDLED_BUN_DIRNAME, getBundledRuntimeBinaryName());
}

function getBundledRuntimeSourceRoot(app: App) {
  if (process.env[BUNDLED_RUNTIME_ROOT_ENV_KEY]) {
    return process.env[BUNDLED_RUNTIME_ROOT_ENV_KEY];
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, BUNDLED_RUNTIME_RESOURCE_DIR)
    : path.join(process.cwd(), "build", "resources", BUNDLED_RUNTIME_RESOURCE_DIR);
}

function getBundledRuntimeSourcePath(app: App) {
  return path.join(getBundledRuntimeSourceRoot(app), BUNDLED_RUNTIME_DIRNAME);
}

function getBundledRuntimeSourceManifestPath(app: App) {
  return path.join(getBundledRuntimeSourceRoot(app), "manifest.json");
}

function getBundledRuntimeSourceBunPath(app: App) {
  return path.join(getBundledRuntimeSourceRoot(app), BUNDLED_BUN_DIRNAME, getBundledRuntimeBinaryName());
}

function hasBundledRuntimeSource(app: App) {
  return (
    fs.existsSync(path.join(getBundledRuntimeSourcePath(app), "dist", "cli.js")) &&
    fs.existsSync(getBundledRuntimeSourceBunPath(app))
  );
}

function hasBundledRuntimeInstall(app: App) {
  return (
    fs.existsSync(path.join(getBundledCodeAssistantRuntimePath(app), "dist", "cli.js")) &&
    fs.existsSync(getBundledBunPath(app))
  );
}

function syncBundledRuntimeInstall(app: App) {
  if (!hasBundledRuntimeSource(app)) {
    return false;
  }

  const sourceRoot = getBundledRuntimeSourceRoot(app);
  const installRoot = getBundledRuntimeInstallRoot(app);
  const sourceManifestPath = getBundledRuntimeSourceManifestPath(app);
  const installManifestPath = path.join(installRoot, "manifest.json");
  const sourceManifest = fs.existsSync(sourceManifestPath)
    ? fs.readFileSync(sourceManifestPath, "utf8")
    : null;
  const installManifest = fs.existsSync(installManifestPath)
    ? fs.readFileSync(installManifestPath, "utf8")
    : null;

  if (sourceManifest && installManifest === sourceManifest && hasBundledRuntimeInstall(app)) {
    return true;
  }

  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.cpSync(sourceRoot, installRoot, {
    recursive: true,
    force: true
  });
  if (process.platform !== "win32" && fs.existsSync(getBundledBunPath(app))) {
    fs.chmodSync(getBundledBunPath(app), 0o755);
  }
  return true;
}

function resolveDefaultRepoPath(app?: App) {
  if (app && hasBundledRuntimeInstall(app)) {
    return getBundledCodeAssistantRuntimePath(app);
  }
  return DEFAULT_REPO_PATH;
}

function defaultManagedConfig(app?: App): ManagedClaudeCodeRelayConfig {
  return {
    repoPath: resolveDefaultRepoPath(app),
    workingDirectory: "",
    relayPort: DEFAULT_RELAY_PORT,
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    authToken: "",
    fullAccessGranted: true,
    enabled: false,
    userSelectedRepo: false
  };
}

function normalizeBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeManagedConfig(
  value: unknown,
  fallbackRepoPath = DEFAULT_REPO_PATH
): ManagedClaudeCodeRelayConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    repoPath: normalizeString(raw.repoPath, fallbackRepoPath),
    workingDirectory: normalizeString(raw.workingDirectory, ""),
    relayPort: normalizeNumber(raw.relayPort, DEFAULT_RELAY_PORT),
    dashboardPort: normalizeNumber(raw.dashboardPort, DEFAULT_DASHBOARD_PORT),
    authToken: normalizeString(raw.authToken, ""),
    fullAccessGranted: normalizeBoolean(raw.fullAccessGranted, true),
    enabled: normalizeBoolean(raw.enabled, false),
    userSelectedRepo: normalizeBoolean(raw.userSelectedRepo, false)
  };
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readManagedConfigFile(filePath: string, fallbackRepoPath = DEFAULT_REPO_PATH) {
  const parsed = readJsonFile<ManagedClaudeCodeRelayConfig>(filePath);
  return parsed ? normalizeManagedConfig(parsed, fallbackRepoPath) : null;
}

export function readManagedConfig(app: App) {
  return readManagedConfigFile(getManagedConfigPath(app), resolveDefaultRepoPath(app));
}

export function writeManagedConfig(app: App, config: ManagedClaudeCodeRelayConfig) {
  const filePath = getManagedConfigPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function updateManagedConfig(
  app: App,
  patch: Partial<ManagedClaudeCodeRelayConfig>
): ManagedClaudeCodeRelayConfig {
  const next = {
    ...(readManagedConfig(app) ?? defaultManagedConfig(app)),
    ...patch
  };
  writeManagedConfig(app, next);
  return next;
}

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function buildManifest(): Manifest {
  const isWindows = process.platform === "win32";
  return {
    id: CLAUDE_CODE_RELAY_PLUGIN_ID,
    name: CLAUDE_CODE_RELAY_PLUGIN_NAME,
    kind: "plugin",
    version: CLAUDE_CODE_RELAY_PLUGIN_VERSION,
    description: "本地托管代码助手运行时，供小宅界面的代码助手直接对话。",
    frontend: {
      mode: "none"
    },
    scripts: {
      start: isWindows ? "start.ps1" : "start.sh",
      stop: isWindows ? "stop.ps1" : "stop.sh"
    },
    configFiles: [
      {
        key: "env",
        label: ".env",
        relativePath: ".env",
        templateRelativePath: ".env.example",
        required: true
      },
      {
        key: "managed",
        label: "托管配置",
        relativePath: "managed-config.json",
        templateRelativePath: "managed-config.template.json",
        required: true
      }
    ],
    runtime: {
      pidRelativePath: "run/claude-code-relay.pid",
      logRelativePath: "run/claude-code-relay.log",
      errorLogRelativePath: "run/claude-code-relay.stderr.log",
      requiredPaths: [
        "manifest.json",
        isWindows ? "start.ps1" : "start.sh",
        isWindows ? "stop.ps1" : "stop.sh",
        "run-relay.mjs",
        ".env.example",
        "managed-config.template.json",
        "run"
      ]
    },
    web: {
      routePath: "",
      portEnvKey: "PORT",
      defaultPort: DEFAULT_RELAY_PORT
    },
    desktop: {
      autoStart: true,
      bundleTopLevelDir: CLAUDE_CODE_RELAY_PLUGIN_ID
    }
  };
}

function buildEnvTemplate() {
  return `PORT=${DEFAULT_RELAY_PORT}\nDASHBOARD_PORT=${DEFAULT_DASHBOARD_PORT}\n`;
}

function buildManagedConfigTemplate(app: App) {
  return `${JSON.stringify(defaultManagedConfig(app), null, 2)}\n`;
}

function buildRunRelayScript() {
  return `import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEnv(filePath) {
  const values = new Map();
  if (!fs.existsSync(filePath)) {
    return values;
  }
  for (const line of fs.readFileSync(filePath, "utf8").split(/\\r?\\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/gu, "");
    values.set(key, value);
  }
  return values;
}

function readClaudeSettingsEnv() {
  const values = new Map();
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return values;
  }
  try {
    const parsed = readJson(settingsPath);
    const rawEnv =
      parsed && typeof parsed === "object" && parsed.env && typeof parsed.env === "object"
        ? parsed.env
        : {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value === "string" && value.trim()) {
        values.set(key, value.trim());
      }
    }
  } catch {
    // Ignore unreadable Claude settings and fall back to process/.env values.
  }
  return values;
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function toNumber(raw, fallback) {
  const next = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(next) ? next : fallback;
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(\`端口 \${port} 已被其他进程占用。\`));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(undefined);
      });
    });
  });
}

async function main() {
  const command = process.argv[2] ?? "daemon";
  if (command !== "daemon") {
    throw new Error(\`未知命令：\${command}\`);
  }

  const installDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.join(installDir, "managed-config.json");
  const envPath = path.join(installDir, ".env");
  const config = readJson(configPath);
  const env = readEnv(envPath);
  const claudeSettingsEnv = readClaudeSettingsEnv();
  const relayPort = toNumber(env.get("PORT"), toNumber(config.relayPort, ${DEFAULT_RELAY_PORT}));
  const dashboardPort = toNumber(
    env.get("DASHBOARD_PORT"),
    toNumber(config.dashboardPort, ${DEFAULT_DASHBOARD_PORT})
  );

  if (!config || typeof config !== "object") {
    throw new Error("代码助手托管配置不可读。");
  }
  if (!config.repoPath || !fs.existsSync(config.repoPath)) {
    throw new Error(\`claude-code-guotai 项目不存在：\${config.repoPath || ""}\`);
  }
  if (!config.authToken) {
    throw new Error("代码助手令牌缺失，请重新启用代码助手。");
  }
  if (!config.enabled) {
    throw new Error("代码助手尚未启用。");
  }
  const userWorkingDirectory =
    typeof config.workingDirectory === "string" && config.workingDirectory.trim()
      ? config.workingDirectory.trim()
      : "";
  const effectiveCwd =
    userWorkingDirectory && fs.existsSync(userWorkingDirectory)
      ? userWorkingDirectory
      : config.repoPath;

  const bundledRelayEntry = path.join(config.repoPath, "desktop", "relay-entry.mjs");
  const bundledCliEntrypoint = path.join(config.repoPath, "dist", "cli.js");
  const sourceRelayEntry = path.join(config.repoPath, "src", "remote-relay", "relay-server.ts");
  const sourceCliEntrypoint = path.join(config.repoPath, "src", "entrypoints", "cli.tsx");
  const relayEntrypoint = fs.existsSync(bundledRelayEntry) ? bundledRelayEntry : sourceRelayEntry;
  const cliEntrypoint = fs.existsSync(bundledCliEntrypoint) ? bundledCliEntrypoint : sourceCliEntrypoint;

  if (!fs.existsSync(relayEntrypoint)) {
    throw new Error(\`代码助手 relay 入口不存在：\${relayEntrypoint}\`);
  }
  if (!fs.existsSync(cliEntrypoint)) {
    throw new Error(\`代码助手 CLI 入口不存在：\${cliEntrypoint}\`);
  }

  // 强制使用 MiniMax API，忽略所有环境变量和用户级 Claude 配置。
  // MiniMax Anthropic 兼容接口要求 Bearer Authorization 头，不能只传 x-api-key。
  const anthropicBaseUrl = ${JSON.stringify(MANAGED_ANTHROPIC_BASE_URL)};
  const claudeCodeApiBaseUrl = anthropicBaseUrl;
  const anthropicApiKey = ${JSON.stringify(MANAGED_ANTHROPIC_API_KEY)};

  process.env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  process.env.CLAUDE_CODE_API_BASE_URL = claudeCodeApiBaseUrl;
  process.env.ANTHROPIC_API_KEY = anthropicApiKey;
  process.env.ANTHROPIC_AUTH_TOKEN = anthropicApiKey;
  // The AGW proxy awaiting submit bridge is not ready yet; keep interviews in normal chat.
  process.env.CLAUDE_CODE_DISABLE_HITL = "1";
  process.env.CLAUDE_CODE_DISABLE_HUMAN_IN_THE_LOOP = "1";
  process.env.CLAUDE_CODE_DISABLE_ASK_USER_QUESTION_MODAL = "1";
  process.env.CLAUDE_CODE_DISABLE_ASK_USER_QUESTION = "1";

  await assertPortAvailable(relayPort);
  await assertPortAvailable(dashboardPort);

  const relayModuleUrl = pathToFileURL(relayEntrypoint).href;
  const relayModule = await import(relayModuleUrl);
  const relayResult = await relayModule.startRelayServer(relayPort, {
    noAuth: false,
    token: config.authToken,
    showQR: false,
    desktopOnly: true
  });

  const bunPath = process.execPath;
  const cliArgs = [
    "run",
    cliEntrypoint,
    "--print",
    "--model",
    ${JSON.stringify(MANAGED_ANTHROPIC_MODEL)},
    "--sdk-url",
    relayResult.cliSdkUrl,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  cliArgs.push(
    "--setting-sources",
    "",
    "--permission-mode",
    "default",
    "--add-dir",
    effectiveCwd,
  );

  let exiting = false;
  let childRestarting = false;
  let child = null;
  const spawnCliProcess = () => {
    const nextChild = spawn(
      bunPath,
      cliArgs,
      {
        cwd: effectiveCwd,
        stdio: "inherit",
        env: {
          ...process.env,
          CLAUDE_RELAY_SUBPROCESS: "1",
          CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: "1",
          ANTHROPIC_BASE_URL: ${JSON.stringify(MANAGED_ANTHROPIC_BASE_URL)},
          CLAUDE_CODE_API_BASE_URL: ${JSON.stringify(MANAGED_ANTHROPIC_BASE_URL)},
          ANTHROPIC_API_KEY: ${JSON.stringify(MANAGED_ANTHROPIC_API_KEY)},
          ANTHROPIC_AUTH_TOKEN: ${JSON.stringify(MANAGED_ANTHROPIC_API_KEY)},
          ANTHROPIC_MODEL: ${JSON.stringify(MANAGED_ANTHROPIC_MODEL)},
          ANTHROPIC_SMALL_FAST_MODEL: ${JSON.stringify(MANAGED_ANTHROPIC_MODEL)},
          CLAUDE_CODE_USE_MODEL: ${JSON.stringify(MANAGED_ANTHROPIC_MODEL)},
        }
      }
    );

    nextChild.on("exit", (code, signal) => {
      if (exiting || childRestarting) {
        return;
      }
      if (signal) {
        process.exit(1);
        return;
      }
      process.exit(code ?? 0);
    });

    child = nextChild;
    return nextChild;
  };

  spawnCliProcess();

  if (typeof relayResult.registerRespawnCli === "function") {
    relayResult.registerRespawnCli(async () => {
      childRestarting = true;
      try {
        const currentChild = child;
        if (currentChild) {
          try {
            currentChild.kill("SIGTERM");
          } catch {
            // Ignore termination failures while rotating the CLI process.
          }
          const killTimer = setTimeout(() => {
            try {
              currentChild.kill("SIGKILL");
            } catch {
              // Ignore forced kill failures during respawn.
            }
          }, 4000);
          try {
            await new Promise((resolve) => {
              currentChild.once("exit", resolve);
            });
          } finally {
            clearTimeout(killTimer);
          }
        }
        spawnCliProcess();
      } finally {
        childRestarting = false;
      }
    });
  }

  const shutdown = () => {
    if (exiting) {
      return;
    }
    exiting = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore child shutdown failures.
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore forced shutdown failures.
      }
      process.exit(0);
    }, 4000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

main().catch((error) => {
  console.error("[claude-code-relay] failed to start", error);
  process.exit(1);
});
`;
}

function buildUnixStartScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/run"
PID_FILE="$RUN_DIR/claude-code-relay.pid"
LOG_FILE="$RUN_DIR/claude-code-relay.log"
ERR_FILE="$RUN_DIR/claude-code-relay.stderr.log"
BUN_BIN="$ROOT_DIR/runtime/bun/${process.platform === "win32" ? "bun.exe" : "bun"}"

mkdir -p "$RUN_DIR"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [[ ! -x "$BUN_BIN" ]]; then
  BUN_BIN="$(command -v bun 2>/dev/null || true)"
fi

if [[ -z "$BUN_BIN" ]]; then
  echo "未检测到 Bun 运行时，请检查 bundled runtime。" >&2
  exit 1
fi

nohup "$BUN_BIN" run "$ROOT_DIR/run-relay.mjs" daemon >>"$LOG_FILE" 2>>"$ERR_FILE" </dev/null &
NEXT_PID="$!"
echo "$NEXT_PID" > "$PID_FILE"
sleep 1

if ! kill -0 "$NEXT_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "代码助手启动失败，请查看日志：$ERR_FILE" >&2
  exit 1
fi
`;
}

function buildUnixStopScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/run/claude-code-relay.pid"

if [[ ! -f "$PID_FILE" ]]; then
  exit 0
fi

TARGET_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -n "$TARGET_PID" ]] && kill -0 "$TARGET_PID" 2>/dev/null; then
  kill "$TARGET_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$TARGET_PID" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$TARGET_PID" 2>/dev/null; then
    kill -9 "$TARGET_PID" 2>/dev/null || true
  fi
fi

rm -f "$PID_FILE"
`;
}

function buildWindowsStartScript() {
  return `$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runDir = Join-Path $root "run"
$pidFile = Join-Path $runDir "claude-code-relay.pid"
$logFile = Join-Path $runDir "claude-code-relay.log"
$errFile = Join-Path $runDir "claude-code-relay.stderr.log"
$bundledBun = Join-Path (Join-Path $root "runtime") "bun\\bun.exe"
$bunBin = if (Test-Path $bundledBun) { $bundledBun } else { "bun" }

New-Item -ItemType Directory -Force -Path $runDir | Out-Null

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existingPid) {
    try {
      Get-Process -Id $existingPid -ErrorAction Stop | Out-Null
      exit 0
    } catch {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}

$process = Start-Process -FilePath $bunBin -ArgumentList @("run", (Join-Path $root "run-relay.mjs"), "daemon") -WorkingDirectory $root -RedirectStandardOutput $logFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
$process.Id | Set-Content -Path $pidFile -Encoding utf8
Start-Sleep -Seconds 1

try {
  Get-Process -Id $process.Id -ErrorAction Stop | Out-Null
} catch {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  throw "代码助手启动失败，请查看日志：$errFile"
}
`;
}

function buildWindowsStopScript() {
  return `$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path (Join-Path $root "run") "claude-code-relay.pid"

if (-not (Test-Path $pidFile)) {
  exit 0
}

$pid = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pid) {
  try {
    Stop-Process -Id $pid -Force -ErrorAction Stop
  } catch {
    # Ignore already-stopped processes.
  }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
`;
}

function writeIfChanged(filePath: string, content: string) {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  fs.writeFileSync(filePath, content, "utf8");
}

function safeManagedAgentContent(token: string) {
  return `key: ${CODE_ASSISTANT_AGENT_KEY}
name: 代码助手
role: CLI 代码助手
description: 本地代码助手，支持代码生成和编辑
icon:
  name: terminal
  color: "#10B981"
mode: PROXY
proxyConfig:
  baseUrl: http://127.0.0.1:${DEFAULT_RELAY_PORT}
  token: "${token}"
  timeoutMs: ${DEFAULT_AGENT_TIMEOUT_MS}
`;
}

function expandUserPath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function deriveAgentsDir(app: App) {
  const platformRoot = path.join(app.getPath("userData"), "services", "agent-platform");
  if (fs.existsSync(platformRoot)) {
    for (const entry of fs.readdirSync(platformRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const env = readEnvFile(path.join(platformRoot, entry.name, ".env"));
      const fromEnv = env.get("AGENTS_DIR");
      if (fromEnv && fromEnv.trim()) {
        return expandUserPath(fromEnv);
      }
    }
  }
  return path.join(os.homedir(), "zenmind", "agents");
}

export function ensureManagedAgentDefinition(app: App, config: ManagedClaudeCodeRelayConfig) {
  const agentsDir = deriveAgentsDir(app);
  const agentDir = path.join(agentsDir, CODE_ASSISTANT_AGENT_KEY);
  const agentFilePath = path.join(agentDir, "agent.yml");
  const expectedBaseUrls = new Set([
    "",
    `http://127.0.0.1:${DEFAULT_RELAY_PORT}`,
    `http://localhost:${DEFAULT_RELAY_PORT}`
  ]);

  if (fs.existsSync(agentFilePath)) {
    const current = fs.readFileSync(agentFilePath, "utf8");
    const keyMatch = current.match(/^key:\s*(.+)\s*$/mu);
    const baseUrlMatch = current.match(/^\s*baseUrl:\s*(.+)\s*$/mu);
    const key = keyMatch?.[1]?.trim() ?? "";
    const baseUrl = baseUrlMatch?.[1]?.trim().replace(/^['"]|['"]$/gu, "") ?? "";
    if (key !== CODE_ASSISTANT_AGENT_KEY || (baseUrl && !expectedBaseUrls.has(baseUrl))) {
      throw new Error("当前 codeAssistant agent.yml 已被改作其他用途，请先手动确认后再启用代码助手集成。");
    }
  }

  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(agentFilePath, safeManagedAgentContent(config.authToken), "utf8");
}

export function syncManagedCodeAssistantAgentDefinition(app: App) {
  const config = readManagedConfig(app);
  if (!config?.enabled || !config.authToken) {
    return false;
  }
  ensureManagedAgentDefinition(app, config);
  return true;
}

function detectBunRuntime(app?: App) {
  if (app && fs.existsSync(getBundledBunPath(app))) {
    return true;
  }
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", ["bun"], { encoding: "utf8", env: process.env })
    : spawnSync("sh", ["-lc", "command -v bun"], { encoding: "utf8", env: process.env });
  return probe.status === 0;
}

function maybeMigrateManagedConfigToBundledRuntime(app: App) {
  if (!hasBundledRuntimeInstall(app)) {
    return;
  }
  const filePath = getManagedConfigPath(app);
  if (!fs.existsSync(filePath)) {
    return;
  }
  const config = readManagedConfig(app);
  if (!config) {
    return;
  }
  const bundledRuntimePath = getBundledCodeAssistantRuntimePath(app);
  const repoPathHasCli =
    Boolean(config.repoPath) &&
    (fs.existsSync(path.join(config.repoPath, "dist", "cli.js")) ||
      fs.existsSync(path.join(config.repoPath, "src", "entrypoints", "cli.tsx")));

  if (!repoPathHasCli) {
    const movedWorkingDirectory =
      config.repoPath && config.repoPath !== bundledRuntimePath && config.repoPath !== DEFAULT_REPO_PATH
        ? config.repoPath
        : config.workingDirectory;
    writeManagedConfig(app, {
      ...config,
      repoPath: bundledRuntimePath,
      workingDirectory: movedWorkingDirectory || "",
      userSelectedRepo: config.userSelectedRepo || Boolean(movedWorkingDirectory)
    });
    return;
  }

  if (config.repoPath !== bundledRuntimePath && config.repoPath === DEFAULT_REPO_PATH) {
    writeManagedConfig(app, {
      ...config,
      repoPath: bundledRuntimePath
    });
  }
}

export function buildCodeAssistantPermissionDialogOptions(): MessageBoxOptions {
  return {
    type: "question",
    buttons: ["保持受限模式", "授予完整权限"],
    defaultId: 1,
    cancelId: 0,
    title: "代码助手完整权限",
    message: "是否允许代码助手访问完整系统范围？",
    detail:
      "开启后，ZenMind Desktop 会以完整目录范围启动本地代码助手运行时。关闭时，代码助手仍可使用，但会遵循默认受限权限。若 macOS 受保护目录仍需系统级权限，请在系统设置中单独授予。"
  };
}

function showMessageBox(
  ownerWindow: BrowserWindow | null,
  options: MessageBoxOptions,
  invoke: EnsureCodeAssistantReadyDeps["showMessageBox"]
) {
  return invoke(ownerWindow, options);
}

export function ensureManagedClaudeCodeRelayPlugin(app: App) {
  const root = getPluginRoot(app);
  const manifest = buildManifest();
  const isWindows = process.platform === "win32";

  syncBundledRuntimeInstall(app);
  fs.mkdirSync(path.join(root, "run"), { recursive: true });
  writeIfChanged(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeIfChanged(path.join(root, ".env.example"), buildEnvTemplate());
  writeIfChanged(path.join(root, "managed-config.template.json"), buildManagedConfigTemplate(app));
  writeIfChanged(path.join(root, "run-relay.mjs"), buildRunRelayScript());
  if (isWindows) {
    writeIfChanged(path.join(root, "start.ps1"), buildWindowsStartScript());
    writeIfChanged(path.join(root, "stop.ps1"), buildWindowsStopScript());
  } else {
    writeIfChanged(path.join(root, "start.sh"), buildUnixStartScript());
    writeIfChanged(path.join(root, "stop.sh"), buildUnixStopScript());
    fs.chmodSync(path.join(root, "start.sh"), 0o755);
    fs.chmodSync(path.join(root, "stop.sh"), 0o755);
  }
  maybeMigrateManagedConfigToBundledRuntime(app);
}

async function readRelayConnectionState(app: App): Promise<RelayConnectionState> {
  const config = readManagedConfig(app);
  if (!config?.enabled || !config.authToken) {
    return {
      cliConnected: false,
      relayReachable: false,
      error: ""
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const url = new URL(`http://127.0.0.1:${config.relayPort}/api/status`);
    url.searchParams.set("token", config.authToken);
    const response = await fetch(url, {
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        cliConnected: false,
        relayReachable: false,
        error: `Relay 状态检查失败（HTTP ${response.status}）`
      };
    }
    const payload = await response.json();
    const parsed = parseRelayStatusPayload(payload);
    return {
      cliConnected: parsed.cliConnected,
      relayReachable: true,
      error: ""
    };
  } catch (error) {
    return {
      cliConnected: false,
      relayReachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCodeAssistantIntegrationStatus(
  app: App,
  serviceState: ServiceState | null
): Promise<CodeAssistantStatus> {
  const config = readManagedConfig(app);
  const configured = Boolean(config?.repoPath && config.authToken);
  const running = serviceState?.status === "running";
  const errors: string[] = [];
  let cliConnected = false;

  if (serviceState && serviceState.status === "error") {
    errors.push(serviceState.message);
  }
  if (config?.enabled) {
    if (!fs.existsSync(config.repoPath)) {
      errors.push(`claude-code-guotai 项目不存在：${config.repoPath}`);
    }
    if (!detectBunRuntime(app)) {
      errors.push("未检测到 Bun 运行时。");
    }
  }

  if (running && config?.enabled && configured) {
    const relayState = await readRelayConnectionState(app);
    cliConnected = relayState.cliConnected;
  }

  const recovering = Boolean(config?.enabled) && running && !cliConnected;
  const ready = Boolean(config?.enabled) && running && cliConnected;

  return {
    enabled: config?.enabled === true,
    fullAccessGranted: config?.fullAccessGranted === true,
    running,
    configured,
    repoSelected: config?.userSelectedRepo === true,
    repoPath: config?.repoPath ?? "",
    cliConnected,
    recovering,
    ready,
    ...(errors.length > 0 ? { error: errors.join("；") } : {})
  };
}

async function buildCommandResult(
  app: App,
  serviceState: ServiceState | null,
  ok: boolean,
  message: string,
  deps: Pick<EnsureCodeAssistantReadyDeps, "getServiceState" | "initializeService" | "startService" | "stopService">,
  prompted?: boolean
): Promise<CodeAssistantCommandResult> {
  return {
    ok,
    message,
    ...(prompted ? { prompted } : {}),
    status: await getCodeAssistantIntegrationStatus(app, serviceState)
  };
}

function waitForPortRelease(port: number, timeoutMs = 6000): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once("connect", () => {
        socket.destroy();
        setTimeout(check, 400);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(true);
      });
      socket.connect(port, "127.0.0.1");
    };
    check();
  });
}

async function restartManagedCodeAssistantService(
  app: App,
  serviceState: ServiceState,
  deps: Pick<SetCodeAssistantEnabledDeps, "getServiceState" | "startService" | "stopService">
) {
  const config = readManagedConfig(app);
  const relayPort = config?.relayPort ?? DEFAULT_RELAY_PORT;

  if (serviceState.status === "running") {
    const stopResult = await deps.stopService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    if (!stopResult.ok) {
      return {
        ok: false,
        message: stopResult.message,
        serviceState
      };
    }

    const portReleased = await waitForPortRelease(relayPort);
    if (!portReleased) {
      try {
        execSync(`lsof -ti :${relayPort} | xargs kill -9 2>/dev/null || true`, {
          encoding: "utf8",
          timeout: 3000
        });
        await waitForPortRelease(relayPort, 2000);
      } catch {
        // Best-effort force kill; proceed to start regardless.
      }
    }
  }

  const startResult = await deps.startService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  return {
    ok: startResult.ok,
    message: startResult.message,
    serviceState
  };
}

export async function ensureCodeAssistantReady(
  app: App,
  _ownerWindow: BrowserWindow | null,
  deps: EnsureCodeAssistantReadyDeps
): Promise<CodeAssistantCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);

  let serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  if (serviceState.status === "initialization-required") {
    const initResult = await deps.initializeService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    if (!initResult.ok) {
      return buildCommandResult(app, serviceState, false, initResult.message, deps);
    }
  }

  const config = updateManagedConfig(app, {
    enabled: true,
    authToken: readManagedConfig(app)?.authToken || generateToken()
  });

  try {
    ensureManagedAgentDefinition(app, config);
  } catch (error) {
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    return buildCommandResult(
      app,
      serviceState,
      false,
      error instanceof Error ? error.message : String(error),
      deps
    );
  }

  if (serviceState.status !== "running") {
    const startResult = await deps.startService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    return buildCommandResult(app, serviceState, startResult.ok, startResult.message, deps);
  }

  return buildCommandResult(app, serviceState, true, "代码助手已就绪。", deps);
}

export async function restartCodeAssistantRuntime(
  app: App,
  deps: SetCodeAssistantEnabledDeps
): Promise<CodeAssistantCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);

  let serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  if (serviceState.status === "initialization-required") {
    const initResult = await deps.initializeService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    if (!initResult.ok) {
      return buildCommandResult(app, serviceState, false, initResult.message, deps);
    }
  }

  const config = updateManagedConfig(app, {
    enabled: true,
    authToken: readManagedConfig(app)?.authToken || generateToken()
  });

  try {
    ensureManagedAgentDefinition(app, config);
  } catch (error) {
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    return buildCommandResult(
      app,
      serviceState,
      false,
      error instanceof Error ? error.message : String(error),
      deps
    );
  }

  const restartResult = await restartManagedCodeAssistantService(app, serviceState, deps);
  return buildCommandResult(
    app,
    restartResult.serviceState,
    restartResult.ok,
    restartResult.ok ? "代码助手已手动重启。" : restartResult.message,
    deps
  );
}

export async function setCodeAssistantEnabled(
  app: App,
  enabled: boolean,
  ownerWindow: BrowserWindow | null,
  deps: SetCodeAssistantEnabledDeps
): Promise<CodeAssistantCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);

  let serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  if (serviceState.status === "initialization-required") {
    const initResult = await deps.initializeService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    if (!initResult.ok) {
      return buildCommandResult(app, serviceState, false, initResult.message, deps);
    }
  }

  if (!enabled) {
    updateManagedConfig(app, {
      enabled: false
    });
    if (serviceState.status === "running") {
      const stopResult = await deps.stopService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
      serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
      return buildCommandResult(app, serviceState, stopResult.ok, "代码助手已停用。", deps);
    }
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    return buildCommandResult(app, serviceState, true, "代码助手已停用。", deps);
  }

  return ensureCodeAssistantReady(app, ownerWindow, deps);
}

export async function setCodeAssistantFullAccessGranted(
  app: App,
  _granted: boolean,
  ownerWindow: BrowserWindow | null,
  deps: SetCodeAssistantEnabledDeps
): Promise<CodeAssistantCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);

  let serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  if (serviceState.status === "initialization-required") {
    const initResult = await deps.initializeService(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    if (!initResult.ok) {
      return buildCommandResult(app, serviceState, false, initResult.message, deps);
    }
  }

  const previousConfig = readManagedConfig(app) ?? defaultManagedConfig(app);
  const nextConfig = updateManagedConfig(app, {
    enabled: previousConfig.enabled,
    fullAccessGranted: true,
    authToken: previousConfig.authToken || generateToken()
  });

  try {
    ensureManagedAgentDefinition(app, nextConfig);
  } catch (error) {
    serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
    return buildCommandResult(
      app,
      serviceState,
      false,
      error instanceof Error ? error.message : String(error),
      deps
    );
  }

  serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  return buildCommandResult(
    app,
    serviceState,
    true,
    "代码助手已使用工作空间优先模式；访问外部位置时会请求确认。",
    deps
  );
}

export function isManagedClaudeCodeRelayPlugin(serviceId: string) {
  return serviceId === CLAUDE_CODE_RELAY_PLUGIN_ID;
}

function parseGitBranchList(stdout: string): { current: string; branches: string[] } {
  const branches: string[] = [];
  let current = "";
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("(") || line.includes("HEAD detached")) continue;
    if (line.startsWith("* ")) {
      current = line.slice(2).trim();
      if (current) branches.push(current);
    } else {
      branches.push(line);
    }
  }
  return { current, branches };
}

function effectiveWorkingDirectory(config: ManagedClaudeCodeRelayConfig): string {
  const trimmed = typeof config.workingDirectory === "string" ? config.workingDirectory.trim() : "";
  if (trimmed && fs.existsSync(trimmed)) {
    return trimmed;
  }
  return config.repoPath;
}

export function getCodeAssistantRepoContext(app: App): CodeAssistantRepoContext {
  const config = readManagedConfig(app) ?? defaultManagedConfig(app);
  const userSelected = config.userSelectedRepo === true;
  const repoPath = userSelected
    ? (config.workingDirectory || config.repoPath)
    : config.repoPath;
  const repoExists = Boolean(repoPath && fs.existsSync(repoPath));
  if (!repoExists) {
    return { repoPath, repoExists, isGitRepo: false, userSelected, currentBranch: "", branches: [] };
  }
  const isGitRepo = fs.existsSync(path.join(repoPath, ".git"));
  if (!isGitRepo) {
    return { repoPath, repoExists, isGitRepo, userSelected, currentBranch: "", branches: [] };
  }
  const branchResult = spawnSync("git", ["branch", "--list", "--no-color"], {
    cwd: repoPath,
    encoding: "utf8",
    env: process.env
  });
  if (branchResult.status !== 0) {
    return { repoPath, repoExists, isGitRepo, userSelected, currentBranch: "", branches: [] };
  }
  const { current, branches } = parseGitBranchList(branchResult.stdout ?? "");
  return { repoPath, repoExists, isGitRepo, userSelected, currentBranch: current, branches };
}

type RepoControlDeps = Pick<EnsureCodeAssistantReadyDeps, "getServiceState" | "startService" | "stopService">;

async function restartIfRunning(app: App, deps: RepoControlDeps) {
  const serviceState = await deps.getServiceState(app, CLAUDE_CODE_RELAY_PLUGIN_ID);
  if (serviceState.status !== "running") {
    return { ok: true, message: "" };
  }
  const restartResult = await restartManagedCodeAssistantService(app, serviceState, deps);
  return {
    ok: restartResult.ok,
    message: restartResult.ok ? "" : restartResult.message
  };
}

export async function updateCodeAssistantRepoPath(
  app: App,
  nextRepoPath: string,
  deps: RepoControlDeps
): Promise<CodeAssistantRepoCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);
  const trimmed = String(nextRepoPath || "").trim();
  if (!trimmed) {
    return { ok: false, message: "未指定目录。", context: getCodeAssistantRepoContext(app) };
  }
  if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isDirectory()) {
    return { ok: false, message: `工作空间不存在：${trimmed}`, context: getCodeAssistantRepoContext(app) };
  }
  updateManagedConfig(app, { workingDirectory: trimmed, userSelectedRepo: true });
  const restart = await restartIfRunning(app, deps);
  const context = getCodeAssistantRepoContext(app);
  if (!restart.ok) {
    return { ok: false, message: `已切换工作空间，但重启代码助手失败：${restart.message}`, context };
  }
  return { ok: true, message: `代码助手工作空间已切换为：${trimmed}`, context };
}

export async function setCodeAssistantBranch(
  app: App,
  branch: string,
  deps: RepoControlDeps
): Promise<CodeAssistantRepoCommandResult> {
  ensureManagedClaudeCodeRelayPlugin(app);
  const target = String(branch || "").trim();
  if (!target) {
    return { ok: false, message: "未指定分支。", context: getCodeAssistantRepoContext(app) };
  }
  const config = readManagedConfig(app) ?? defaultManagedConfig(app);
  const cwd = effectiveWorkingDirectory(config);
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, message: "代码助手工作空间不存在。", context: getCodeAssistantRepoContext(app) };
  }
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    return { ok: false, message: "当前工作空间不是 Git 仓库。", context: getCodeAssistantRepoContext(app) };
  }
  const currentContext = getCodeAssistantRepoContext(app);
  if (currentContext.currentBranch === target) {
    return { ok: true, message: `当前已在分支：${target}`, context: currentContext };
  }
  const checkout = spawnSync("git", ["switch", target], {
    cwd,
    encoding: "utf8",
    env: process.env
  });
  if (checkout.status !== 0) {
    const stderr = (checkout.stderr ?? checkout.stdout ?? "").trim();
    const hasLocalChangeConflict =
      stderr.includes("Your local changes to the following files would be overwritten") ||
      stderr.includes("Please commit your changes or stash them before you switch branches");
    return {
      ok: false,
      message: hasLocalChangeConflict
        ? `切换到分支 ${target} 失败：当前工作区有未提交修改，会被目标分支覆盖。请先提交、暂存或清理修改后再切换。`
        : stderr || `切换到分支 ${target} 失败。`,
      context: getCodeAssistantRepoContext(app)
    };
  }
  const restart = await restartIfRunning(app, deps);
  const context = getCodeAssistantRepoContext(app);
  if (!restart.ok) {
    return { ok: false, message: `已切换分支，但重启代码助手失败：${restart.message}`, context };
  }
  return { ok: true, message: `已切换到分支：${target}`, context };
}

export const __testInternals = {
  buildManifest,
  buildCodeAssistantPermissionDialogOptions,
  defaultManagedConfig,
  deriveAgentsDir,
  expandUserPath,
  ensureManagedAgentDefinition,
  getManagedConfigPath,
  getManagedConfigTemplatePath,
  getPluginRoot,
  normalizeManagedConfig,
  parseRelayStatusPayload,
  readManagedConfig,
  readManagedConfigFile,
  safeManagedAgentContent,
  syncManagedCodeAssistantAgentDefinition,
  updateManagedConfig,
  writeManagedConfig
};
