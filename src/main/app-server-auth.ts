import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";
import { parseEnvFileContent } from "./env-file";
import { getService } from "./services/service-registry";
import {
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServicesRoot,
  getServiceStateRoot
} from "./user-paths";

const APP_SERVER_SERVICE_ID = "zenmind-app-server";
const DESKTOP_DEVICE_NAME = "ZenMind Desktop";
const APP_SERVER_AUTH_SCRIPT_TIMEOUT_MS = 30_000;
const APP_SERVER_AUTH_SCRIPT_RETRY_DELAYS_MS = [150, 350, 700, 1_200];

type AppServerAuthLayout = {
  programDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
  logDir: string;
  envPath: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function getAppServerLayout(app: App): AppServerAuthLayout {
  const service = getService(APP_SERVER_SERVICE_ID);
  const programDir = path.join(getServicesRoot(app), service.id, service.version);
  const configDir = getServiceConfigRoot(app, service.id, service.kind);
  const dataDir = getServiceDataRoot(app, service.id, service.kind);
  const stateDir = getServiceStateRoot(app, service.id, service.kind);
  const logDir = getServiceLogsRoot(app, service.id, service.kind);
  return {
    programDir,
    configDir,
    dataDir,
    stateDir,
    logDir,
    envPath: path.join(configDir, ".env")
  };
}

function buildLayoutEnv(layout: AppServerAuthLayout): NodeJS.ProcessEnv {
  return {
    SERVICE_PROGRAM_DIR: layout.programDir,
    SERVICE_CONFIG_DIR: layout.configDir,
    SERVICE_DATA_DIR: layout.dataDir,
    SERVICE_STATE_DIR: layout.stateDir,
    SERVICE_LOG_DIR: layout.logDir
  };
}

function readAppServerEnv(layout: AppServerAuthLayout) {
  const content = fs.existsSync(layout.envPath) ? fs.readFileSync(layout.envPath, "utf8") : "";
  return parseEnvFileContent(content);
}

function readAppServerAuthSettings(layout: AppServerAuthLayout) {
  const env = readAppServerEnv(layout);
  const service = getService(APP_SERVER_SERVICE_ID);
  const port = env.get("SERVER_PORT")?.trim() || String(service.web.defaultPort);
  return {
    dbPath: env.get("AUTH_DB_PATH")?.trim() || path.join(layout.dataDir, "auth.db"),
    issuer: env.get("AUTH_ISSUER")?.trim() || `http://127.0.0.1:${port}`,
    username: env.get("AUTH_APP_USERNAME")?.trim() || "app"
  };
}

function resolveAppServerScript(layout: AppServerAuthLayout, baseName: string) {
  if (process.platform === "win32") {
    const windowsScript = path.join(layout.programDir, "scripts", `${baseName}.ps1`);
    if (fs.existsSync(windowsScript)) {
      return windowsScript;
    }
    throw new Error(`zenmind-app-server 缺少 Windows 脚本：scripts/${baseName}.ps1`);
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    const unixScript = path.join(layout.programDir, "scripts", `${baseName}.sh`);
    if (fs.existsSync(unixScript)) {
      fs.chmodSync(unixScript, 0o755);
      return unixScript;
    }
    throw new Error(`zenmind-app-server 缺少 Unix 脚本：scripts/${baseName}.sh`);
  }

  throw new Error(`不支持的平台：${process.platform}`);
}

function runAppServerScript(
  layout: AppServerAuthLayout,
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  const command = process.platform === "win32" ? windowsPowerShellPath() : scriptPath;
  const commandArgs = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args]
    : args;

  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      ...buildLayoutEnv(layout),
      ...env
    };
    execFile(command, commandArgs, {
      cwd: layout.programDir,
      env: childEnv,
      timeout: APP_SERVER_AUTH_SCRIPT_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      const result = {
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      };
      if (error) {
        const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(`${error.message}${detail ? `\n${detail}` : ""}`));
        return;
      }
      resolve(result);
    });
  });
}

function isSqliteBusyError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /database is locked|SQLITE_BUSY|sqlite_busy|locking protocol|Error:\s*stepping,\s*database is locked|\(5\)/iu.test(message);
}

async function runAppServerAuthScript(
  layout: AppServerAuthLayout,
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= APP_SERVER_AUTH_SCRIPT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await runAppServerScript(layout, scriptPath, args, env);
    } catch (reason) {
      lastError = reason;
      if (!isSqliteBusyError(reason) || attempt >= APP_SERVER_AUTH_SCRIPT_RETRY_DELAYS_MS.length) {
        throw reason;
      }
      await delay(APP_SERVER_AUTH_SCRIPT_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function buildSetupPublicKeyArgs(settings: ReturnType<typeof readAppServerAuthSettings>, keyDir: string, publicKeyPath: string) {
  if (process.platform === "win32") {
    return [
      "-Mode",
      "bootstrap",
      "-Db",
      settings.dbPath,
      "-Out",
      keyDir,
      "-PublicOut",
      publicKeyPath
    ];
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    return [
      "--mode",
      "bootstrap",
      "--db",
      settings.dbPath,
      "--out",
      keyDir,
      "--public-out",
      publicKeyPath
    ];
  }

  throw new Error(`不支持的平台：${process.platform}`);
}

function buildIssueAccessTokenArgs(settings: ReturnType<typeof readAppServerAuthSettings>) {
  if (process.platform === "win32") {
    return [
      "-Db",
      settings.dbPath,
      "-Issuer",
      settings.issuer,
      "-Username",
      settings.username,
      "-DeviceName",
      DESKTOP_DEVICE_NAME
    ];
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    return [
      "--db",
      settings.dbPath,
      "--issuer",
      settings.issuer,
      "--username",
      settings.username,
      "--device-name",
      DESKTOP_DEVICE_NAME
    ];
  }

  throw new Error(`不支持的平台：${process.platform}`);
}

export function getAppServerPublicKeyExportPath(app: App) {
  const layout = getAppServerLayout(app);
  return path.join(layout.dataDir, "keys", "publicKey.pem");
}

export async function ensureAppServerJwk(app: App) {
  const layout = getAppServerLayout(app);
  if (!fs.existsSync(layout.programDir)) {
    throw new Error("zenmind-app-server 未安装，无法签发 agent-platform access token。");
  }

  const settings = readAppServerAuthSettings(layout);
  const keyDir = path.join(layout.dataDir, "keys");
  const publicKeyPath = path.join(keyDir, "publicKey.pem");
  ensureDir(path.dirname(settings.dbPath));
  ensureDir(keyDir);

  const scriptPath = resolveAppServerScript(layout, "setup-public-key");
  await runAppServerAuthScript(layout, scriptPath, buildSetupPublicKeyArgs(settings, keyDir, publicKeyPath), {
    AUTH_DB_PATH: settings.dbPath
  });

  if (!fs.existsSync(publicKeyPath)) {
    throw new Error(`zenmind-app-server 未导出 public key：${publicKeyPath}`);
  }

  return {
    publicKeyPath,
    publicKeyPem: fs.readFileSync(publicKeyPath, "utf8")
  };
}

export async function issueAppServerAccessToken(app: App) {
  const layout = getAppServerLayout(app);
  const settings = readAppServerAuthSettings(layout);
  await ensureAppServerJwk(app);

  const scriptPath = resolveAppServerScript(layout, "issue-bridge-access-token");
  const result = await runAppServerAuthScript(layout, scriptPath, buildIssueAccessTokenArgs(settings), {
    AUTH_DB_PATH: settings.dbPath,
    AUTH_ISSUER: settings.issuer,
    AUTH_APP_USERNAME: settings.username
  });

  const token = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)?.trim() ?? "";
  if (!token) {
    throw new Error("zenmind-app-server 未返回 access token。");
  }
  return token;
}

export const __testInternals = {
  getAppServerLayout,
  readAppServerAuthSettings,
  resolveAppServerScript,
  runAppServerScript,
  runAppServerAuthScript
};
