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
import { PRODUCT_NAME } from "../shared/brand";
import { resolveDesktopCapability } from "./services/manager/capabilities";
import { t } from "./i18n/main-i18n";

const IDENTITY_CENTER_SERVICE_ID = "identity-center";
const DESKTOP_DEVICE_NAME = `${PRODUCT_NAME} Desktop`;
const IDENTITY_CENTER_AUTH_SCRIPT_TIMEOUT_MS = 30_000;
const IDENTITY_CENTER_AUTH_SCRIPT_RETRY_DELAYS_MS = [150, 350, 700, 1_200];

type IdentityCenterAuthLayout = {
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

function getIdentityCenterLayout(app: App): IdentityCenterAuthLayout {
  const service = getService(IDENTITY_CENTER_SERVICE_ID);
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

function readIdentityCenterEnv(layout: IdentityCenterAuthLayout) {
  const content = fs.existsSync(layout.envPath) ? fs.readFileSync(layout.envPath, "utf8") : "";
  return parseEnvFileContent(content);
}

function buildIdentityCenterAuthScriptEnv(
  layout: IdentityCenterAuthLayout,
  overrides: NodeJS.ProcessEnv
) {
  return {
    ...Object.fromEntries(readIdentityCenterEnv(layout)),
    ...overrides
  };
}

function readIdentityCenterAuthSettings(layout: IdentityCenterAuthLayout) {
  const env = readIdentityCenterEnv(layout);
  const service = getService(IDENTITY_CENTER_SERVICE_ID);
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

function resolveIdentityCenterCommand(layout: IdentityCenterAuthLayout, subcommand: string): ResolvedCommand {
  const binaryName = process.platform === "win32" ? "identity-center.exe" : "identity-center";
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
    throw new Error(t("identityCenterAuth.missingBinaryAndWindowsScript", { binaryName, subcommand }));
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    throw new Error(t("identityCenterAuth.missingBinaryAndUnixScript", { binaryName, subcommand }));
  }

  throw new Error(t("identityCenterAuth.unsupportedPlatform", { platform: process.platform }));
}

function resolveIdentityCenterScript(layout: IdentityCenterAuthLayout, baseName: string) {
  if (process.platform === "win32") {
    const windowsScript = path.join(layout.programDir, "scripts", `${baseName}.ps1`);
    if (fs.existsSync(windowsScript)) {
      return windowsScript;
    }
    throw new Error(t("identityCenterAuth.missingWindowsScript", { baseName }));
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    const unixScript = path.join(layout.programDir, "scripts", `${baseName}.sh`);
    if (fs.existsSync(unixScript)) {
      fs.chmodSync(unixScript, 0o755);
      return unixScript;
    }
    throw new Error(t("identityCenterAuth.missingUnixScript", { baseName }));
  }

  throw new Error(t("identityCenterAuth.unsupportedPlatform", { platform: process.platform }));
}

function runIdentityCenterScript(
  layout: IdentityCenterAuthLayout,
  resolved: ResolvedCommand,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  const command = resolved.command;
  const commandArgs = [...resolved.args, ...args];

  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env
    };

    // Ensure common tool paths are available (Git mingw64, etc.)
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const userProfile = process.env.USERPROFILE ?? "";
      const configuredNodeBin = process.env.DESKTOP_NODE_BIN;
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
      timeout: IDENTITY_CENTER_AUTH_SCRIPT_TIMEOUT_MS
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
  return /unknown argument:\s*(?:--device-id|-DeviceId)|unrecognized (?:option|argument).*?(?:--device-id|-DeviceId)|(?:parameter cannot be found|找不到与参数名称).*?(?:--device-id|-DeviceId|DeviceId)/iu.test(message);
}

async function runIdentityCenterAuthScript(
  layout: IdentityCenterAuthLayout,
  resolved: ResolvedCommand,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= IDENTITY_CENTER_AUTH_SCRIPT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await runIdentityCenterScript(layout, resolved, args, env);
    } catch (reason) {
      lastError = reason;
      if (!isSqliteBusyError(reason) || attempt >= IDENTITY_CENTER_AUTH_SCRIPT_RETRY_DELAYS_MS.length) {
        throw reason;
      }
      await delay(IDENTITY_CENTER_AUTH_SCRIPT_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function buildSetupPublicKeyArgs(settings: ReturnType<typeof readIdentityCenterAuthSettings>, keyDir: string, publicKeyPath: string) {
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

  throw new Error(t("identityCenterAuth.unsupportedPlatform", { platform: process.platform }));
}

function buildIssueAccessTokenArgsWithDeviceId(
  settings: ReturnType<typeof readIdentityCenterAuthSettings>,
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

  throw new Error(t("identityCenterAuth.unsupportedPlatform", { platform: process.platform }));
}

function buildLegacyIssueAccessTokenArgs(settings: ReturnType<typeof readIdentityCenterAuthSettings>) {
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

  throw new Error(t("identityCenterAuth.unsupportedPlatform", { platform: process.platform }));
}

function readJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    throw new Error(t("identityCenterAuth.invalidJwt"));
  }
  try {
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(t("identityCenterAuth.jwtPayloadParseFailed"));
  }
}

function validateAccessTokenHasDeviceId(token: string) {
  const payload = readJwtPayload(token);
  const tokenDeviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (!tokenDeviceId) {
    throw new Error(t("identityCenterAuth.tokenMissingDeviceId"));
  }
}

function validateAccessTokenDeviceId(token: string, desktopDeviceId: string) {
  const payload = readJwtPayload(token);
  const tokenDeviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
  if (tokenDeviceId !== desktopDeviceId) {
    throw new Error(t("identityCenterAuth.tokenDeviceIdMismatch"));
  }
}

export function getIdentityCenterPublicKeyExportPath(app: App) {
  const layout = getIdentityCenterLayout(app);
  return path.join(layout.dataDir, "keys", "publicKey.pem");
}

export async function ensureIdentityCenterJwk(app: App) {
  const capability = await resolveDesktopCapability(app, "auth.publicKey");
  const publicKeyPath = capability.filePath || getIdentityCenterPublicKeyExportPath(app);
  if (!fs.existsSync(publicKeyPath)) {
    throw new Error(t("identityCenterAuth.publicKeyMissing", { path: publicKeyPath }));
  }
  return {
    publicKeyPath,
    publicKeyPem: fs.readFileSync(publicKeyPath, "utf8")
  };
}

export async function issueIdentityCenterAccessToken(app: App) {
  const capability = await resolveDesktopCapability(app, "auth.accessToken");
  const token = capability.token || capability.text || "";
  if (!token) {
    throw new Error(t("identityCenterAuth.tokenMissing"));
  }
  return token;
}

export const __testInternals = {
  getIdentityCenterLayout,
  readIdentityCenterAuthSettings,
  resolveIdentityCenterCommand,
  resolveIdentityCenterScript,
  buildIssueAccessTokenArgsWithDeviceId,
  buildLegacyIssueAccessTokenArgs,
  readJwtPayload,
  validateAccessTokenHasDeviceId,
  validateAccessTokenDeviceId,
  runIdentityCenterScript,
  runIdentityCenterAuthScript
};
