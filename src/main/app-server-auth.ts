import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";
import { parseEnvFileContent } from "./env-file";
import { getService } from "./services/service-registry";
import { getDesktopDeviceId } from "./device-identity";
import {
  getServiceConfigRoot,
  getServiceDataRoot,
  getServiceLogsRoot,
  getServicesRoot,
  getServiceStateRoot
} from "./user-paths";
import { PRODUCT_NAME } from "../shared/generated/brand";

const APP_SERVER_SERVICE_ID = "zenmind-app-server";
const DESKTOP_DEVICE_NAME = `${PRODUCT_NAME} Desktop`;
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

function buildAppServerAuthScriptEnv(
  layout: AppServerAuthLayout,
  overrides: NodeJS.ProcessEnv
) {
  return {
    ...Object.fromEntries(readAppServerEnv(layout)),
    ...overrides
  };
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

type ResolvedCommand = {
  command: string;
  args: string[];
};

function resolveAppServerCommand(layout: AppServerAuthLayout, subcommand: string): ResolvedCommand {
  const binaryName = process.platform === "win32" ? "zenmind-app-server.exe" : "zenmind-app-server";
  const binaryPath = path.join(layout.programDir, "backend", binaryName);

  // Auth helpers are bundled as scripts; the backend binary is the long-running server.
  if (process.platform === "win32") {
    const windowsScript = path.join(layout.programDir, "scripts", `${subcommand}.ps1`);
    if (fs.existsSync(windowsScript)) {
      return {
        command: windowsPowerShellPath(),
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsScript]
      };
    }
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    const unixScript = path.join(layout.programDir, "scripts", `${subcommand}.sh`);
    if (fs.existsSync(unixScript)) {
      fs.chmodSync(unixScript, 0o755);
      return {
        command: unixScript,
        args: []
      };
    }
  }

  if (fs.existsSync(binaryPath)) {
    return {
      command: binaryPath,
      args: [subcommand]
    };
  }

  if (process.platform === "win32") {
    throw new Error(`zenmind-app-server 缺少后端二进制文件：backend/${binaryName} 且缺少 Windows 脚本：scripts/${subcommand}.ps1`);
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    throw new Error(`zenmind-app-server 缺少后端二进制文件：backend/${binaryName} 且缺少 Unix 脚本：scripts/${subcommand}.sh`);
  }

  throw new Error(`不支持的平台：${process.platform}`);
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
  resolved: ResolvedCommand,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  const command = resolved.command;
  const commandArgs = [...resolved.args, ...args];

  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildLayoutEnv(layout),
      ...env
    };

    // Ensure common tool paths are available (Git mingw64, etc.)
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const userProfile = process.env.USERPROFILE ?? "";
      const configuredNodeBin = process.env.DESKTOP_NODE_BIN ?? process.env.ZENMIND_NODE_BIN;
      const nodeBinDir = configuredNodeBin
        ? path.dirname(configuredNodeBin)
        : (process.execPath ? path.dirname(process.execPath) : null);
      const staticPaths = [
        path.join(programFiles, "Git", "mingw64", "bin"),
        path.join(programFiles, "Git", "usr", "bin"),
        ...(userProfile ? [path.join(userProfile, "bin")] : []),
        ...(nodeBinDir ? [nodeBinDir] : [])
      ];
      const pathKey = childEnv.PATH !== undefined ? "PATH" : "Path";
      const current = (childEnv[pathKey] ?? "").split(path.delimiter).filter(Boolean);
      childEnv[pathKey] = [...new Set([...current, ...staticPaths])].join(path.delimiter);
    }

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

function isUnsupportedDeviceIdArgumentError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return /unknown argument:\s*(?:--device-id|-DeviceId)|unrecognized (?:option|argument).*?(?:--device-id|-DeviceId)|parameter cannot be found.*?(?:--device-id|-DeviceId|DeviceId)/iu.test(message);
}

async function runAppServerAuthScript(
  layout: AppServerAuthLayout,
  resolved: ResolvedCommand,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= APP_SERVER_AUTH_SCRIPT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await runAppServerScript(layout, resolved, args, env);
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

function buildIssueAccessTokenArgsWithDeviceId(
  settings: ReturnType<typeof readAppServerAuthSettings>,
  desktopDeviceId: string
) {
  if (process.platform === "win32") {
    return [
      "-Db",
      settings.dbPath,
      "-Issuer",
      settings.issuer,
      "-Username",
      settings.username,
      "-DeviceName",
      DESKTOP_DEVICE_NAME,
      "-DeviceId",
      desktopDeviceId
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
      DESKTOP_DEVICE_NAME,
      "--device-id",
      desktopDeviceId
    ];
  }

  throw new Error(`不支持的平台：${process.platform}`);
}

function buildLegacyIssueAccessTokenArgs(settings: ReturnType<typeof readAppServerAuthSettings>) {
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

function readJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    throw new Error("zenmind-app-server 返回的 access token 不是有效 JWT。");
  }
  try {
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("zenmind-app-server 返回的 access token payload 无法解析。");
  }
}

function validateAccessTokenHasDeviceId(token: string) {
  const payload = readJwtPayload(token);
  const tokenDeviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (!tokenDeviceId) {
    throw new Error("zenmind-app-server access token 缺少 device_id。");
  }
}

function validateAccessTokenDeviceId(token: string, desktopDeviceId: string) {
  const payload = readJwtPayload(token);
  const tokenDeviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (tokenDeviceId !== desktopDeviceId) {
    throw new Error("zenmind-app-server access token 的 device_id 与 DESKTOP_DEVICE_ID 不一致。");
  }
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

  const resolved = resolveAppServerCommand(layout, "setup-public-key");
  await runAppServerAuthScript(layout, resolved, buildSetupPublicKeyArgs(settings, keyDir, publicKeyPath), {
    ...buildAppServerAuthScriptEnv(layout, {
      AUTH_DB_PATH: settings.dbPath
    })
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
  const desktopDeviceId = getDesktopDeviceId(app);
  await ensureAppServerJwk(app);

  const resolved = resolveAppServerCommand(layout, "issue-bridge-access-token");
  const env = {
    ...buildAppServerAuthScriptEnv(layout, {
      AUTH_DB_PATH: settings.dbPath,
      AUTH_ISSUER: settings.issuer,
      AUTH_APP_USERNAME: settings.username,
      DESKTOP_DEVICE_ID: desktopDeviceId
    })
  };
  let shouldValidateExactDeviceId = true;
  let result: ExecResult;
  try {
    result = await runAppServerAuthScript(layout, resolved, buildIssueAccessTokenArgsWithDeviceId(settings, desktopDeviceId), env);
  } catch (reason) {
    if (!isUnsupportedDeviceIdArgumentError(reason)) {
      throw reason;
    }
    shouldValidateExactDeviceId = false;
    result = await runAppServerAuthScript(layout, resolved, buildLegacyIssueAccessTokenArgs(settings), env);
  }

  const token = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)?.trim() ?? "";
  if (!token) {
    throw new Error("zenmind-app-server 未返回 access token。");
  }
  if (shouldValidateExactDeviceId) {
    validateAccessTokenDeviceId(token, desktopDeviceId);
  } else {
    validateAccessTokenHasDeviceId(token);
  }
  return token;
}

export const __testInternals = {
  getAppServerLayout,
  readAppServerAuthSettings,
  resolveAppServerCommand,
  resolveAppServerScript,
  buildIssueAccessTokenArgsWithDeviceId,
  buildLegacyIssueAccessTokenArgs,
  readJwtPayload,
  validateAccessTokenHasDeviceId,
  validateAccessTokenDeviceId,
  runAppServerScript,
  runAppServerAuthScript
};
