import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import type { App } from "electron";
import type {
  ServiceCommandResult,
  ServiceConfigReadResult,
  ServiceId,
  ServiceImportResult,
  ServiceLogReadResult,
  ServiceLogTarget,
  ServiceLogsMeta,
  ServiceState
} from "../shared/contracts";
import type { ServiceDefinition } from "./manifest-utils";
import { getBuiltinAssetsRoot } from "./builtin-loader";
import { getAllServices, getService } from "./service-registry";
import { getPluginInstallDir } from "./plugin-loader";
import { ensureKeyPairForPan } from "./pan-auth";
import { readEnvFile, parseEnvFileContent } from "./env-file";
import { extractArchiveToDir, listArchiveEntries } from "./archive-utils";
import { getServicesRoot } from "./user-paths";

const startedThisSession = new Set<ServiceId>();
const LOG_READ_WINDOW_BYTES = 256 * 1024;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type PowerShellCapturePayload = ExecResult & {
  hadError: boolean;
  exitCode: number;
};

let shellPathEntriesCache: string[] | null = null;

function getStaticServicePaths() {
  if (process.platform === "win32") {
    return [];
  }

  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/podman/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    "/Applications/OrbStack.app/Contents/MacOS/bin",
    path.join(os.homedir(), ".local", "bin")
  ];
}

function getShellPathEntries() {
  if (process.platform === "win32") {
    return [];
  }
  if (shellPathEntriesCache) {
    return shellPathEntriesCache;
  }

  const shellPath = process.env.SHELL;
  if (!shellPath) {
    shellPathEntriesCache = [];
    return shellPathEntriesCache;
  }

  try {
    const result = spawnSync(shellPath, ["-lc", "printf '%s' \"$PATH\""], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      timeout: 1500
    });
    if (result.status === 0 && !result.error) {
      shellPathEntriesCache = result.stdout.split(path.delimiter).filter(Boolean);
      return shellPathEntriesCache;
    }
  } catch {
    // Fall back to the static service paths when the login shell cannot be probed.
  }

  shellPathEntriesCache = [];
  return shellPathEntriesCache;
}

type InitializationState = {
  version: string;
  status: "succeeded" | "failed";
  updatedAt: string;
  lastError?: string;
};

const INITIALIZATION_STATE_DIRNAME = ".zenmind-desktop";
const INITIALIZATION_STATE_FILE = "init-state.json";

function buildServiceEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extraPaths = [...getStaticServicePaths(), ...getShellPathEntries()];
  if (extraPaths.length === 0) {
    return env;
  }
  const current = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extraPaths])];
  env.PATH = merged.join(path.delimiter);
  return env;
}

const bundleValidationCache = new Map<string, { key: string; missingEntries: string[] }>();

export function getInstallDir(app: App, service: ServiceDefinition) {
  if (service.kind === "plugin") {
    return getPluginInstallDir(app, service.id);
  }
  return path.join(getServicesRoot(app), service.id, service.version);
}

function getAssetPath(app: App, service: ServiceDefinition) {
  if (!service.desktop.assetFileName) {
    throw new Error(`桌面端内置资源缺少 assetFileName：${service.id}`);
  }
  return path.join(getBuiltinAssetsRoot(app), service.id, service.desktop.assetFileName);
}

function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function fileExists(targetPath: string) {
  return fs.existsSync(targetPath);
}

function getInitializationStatePath(installDir: string) {
  return path.join(installDir, INITIALIZATION_STATE_DIRNAME, INITIALIZATION_STATE_FILE);
}

function readInitializationState(installDir: string): InitializationState | null {
  const filePath = getInitializationStatePath(installDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const status = parsed.status === "succeeded" || parsed.status === "failed" ? parsed.status : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const lastError = typeof parsed.lastError === "string" && parsed.lastError.trim() ? parsed.lastError : undefined;
    if (!version || !status || !updatedAt) {
      return null;
    }
    return {
      version,
      status,
      updatedAt,
      ...(lastError ? { lastError } : {})
    };
  } catch {
    return null;
  }
}

function isAssetNewerThanInstall(assetPath: string, installDir: string) {
  try {
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    const initStatePath = getInitializationStatePath(installDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

function writeInitializationState(installDir: string, state: InitializationState) {
  const filePath = getInitializationStatePath(installDir);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function fixShellScriptPermissions(rootDir: string) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.name.endsWith(".sh")) {
        fs.chmodSync(entryPath, 0o755);
      }
    }
  }
}

function listMissingRuntimeFiles(service: ServiceDefinition, installDir: string) {
  return service.runtime.requiredPaths.filter((relativePath) => !fileExists(path.join(installDir, relativePath)));
}

function isInstallHealthy(service: ServiceDefinition, installDir: string) {
  return listMissingRuntimeFiles(service, installDir).length === 0;
}

function listTarEntries(archivePath: string) {
  return listArchiveEntries(archivePath);
}

function listMissingBundleEntries(service: ServiceDefinition, archivePath: string) {
  const stat = fs.statSync(archivePath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = bundleValidationCache.get(archivePath);
  if (cached && cached.key === cacheKey) {
    return cached.missingEntries;
  }

  const entries = listTarEntries(archivePath);
  const missingEntries = service.runtime.requiredPaths.filter((relativePath) => {
    const expectedPath = `${service.desktop.bundleTopLevelDir}/${relativePath}`;
    if (entries.has(expectedPath) || entries.has(`${expectedPath}/`)) {
      return false;
    }
    const prefix = expectedPath.endsWith("/") ? expectedPath : `${expectedPath}/`;
    return ![...entries].some((entry) => entry.startsWith(prefix));
  });
  bundleValidationCache.set(archivePath, {
    key: cacheKey,
    missingEntries
  });
  return missingEntries;
}

function ensureArchiveHealthy(service: ServiceDefinition, archivePath: string, sourceLabel: string) {
  if (!fileExists(archivePath)) {
    throw new Error(`${sourceLabel}缺失：${archivePath}`);
  }

  const missingEntries = listMissingBundleEntries(service, archivePath);
  if (missingEntries.length > 0) {
    throw new Error(`${sourceLabel}不完整，缺少：${missingEntries.join(", ")}`);
  }

  return archivePath;
}

function ensureBundleAssetHealthy(app: App, service: ServiceDefinition) {
  return ensureArchiveHealthy(service, getAssetPath(app, service), "桌面端内置资源");
}

function upsertEnvFileContent(content: string, updates: Map<string, string>) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const pending = new Map(updates);
  const nextLines = lines.map((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      return line;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!pending.has(key)) {
      return line;
    }

    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${value}`;
  });

  if (pending.size > 0 && nextLines.length > 0 && nextLines[nextLines.length - 1]?.trim() !== "") {
    nextLines.push("");
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.join("\n")}\n`;
}

function writeEnvFileUpdates(filePath: string, updates: Map<string, string>) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, upsertEnvFileContent(current, updates), "utf8");
}

function parsePort(service: ServiceDefinition, env: Map<string, string>) {
  if (!service.web.portEnvKey) {
    return service.web.defaultPort;
  }
  const value = env.get(service.web.portEnvKey);
  if (!value) {
    return service.web.defaultPort;
  }

  if (service.id === "agent-container-hub") {
    const pieces = value.split(":");
    const port = Number.parseInt(pieces[pieces.length - 1] ?? "", 10);
    return Number.isFinite(port) ? port : service.web.defaultPort;
  }

  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) ? port : service.web.defaultPort;
}

function getWebUrl(service: ServiceDefinition, env: Map<string, string>) {
  const port = parsePort(service, env);
  if (!port) {
    return "";
  }
  const routePath = service.web.routePath;
  return routePath ? `http://127.0.0.1:${port}${routePath}` : `http://127.0.0.1:${port}`;
}

function resolveRuntimePath(installDir: string, relativePath: string) {
  return relativePath ? path.join(installDir, relativePath) : "";
}

function readPid(pidFilePath: string) {
  if (!fs.existsSync(pidFilePath)) {
    return null;
  }
  const raw = fs.readFileSync(pidFilePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function isProcessRunning(pid: number | null) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const IS_WINDOWS = process.platform === "win32";

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellArray(values: string[]) {
  if (values.length === 0) {
    return "@()";
  }
  return `@(${values.map((value) => quotePowerShell(value)).join(", ")})`;
}

function decodeBase64Utf8(content: string) {
  const trimmed = content.trim();
  return trimmed ? Buffer.from(trimmed, "base64").toString("utf8") : "";
}

function coerceExecText(value: string | Buffer) {
  return typeof value === "string" ? value : value.toString("utf8");
}

function normalizeCapturedText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function decodePowerShellCapturePayload(value: string | Buffer): PowerShellCapturePayload | null {
  const content = coerceExecText(value).trim();
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Utf8(content)) as Record<string, unknown>;
    return {
      stdout: normalizeCapturedText(parsed.stdout),
      stderr: normalizeCapturedText(parsed.stderr),
      hadError: parsed.hadError === true,
      exitCode: typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : 0
    };
  } catch {
    return null;
  }
}

function buildPowerShellCaptureCommand(scriptPath: string, args: string[]) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$scriptPath = ${quotePowerShell(scriptPath)}
$scriptArgs = ${encodePowerShellArray(args)}
$stdout = [System.Collections.Generic.List[string]]::new()
$stderr = [System.Collections.Generic.List[string]]::new()
$hadError = $false
$nativeExitCode = 0
function Add-CapturedText([System.Collections.Generic.List[string]]$Lines, [object]$Value) {
  if ($null -eq $Value) {
    return
  }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return
  }
  $Lines.Add($text.TrimEnd([char]13, [char]10))
}
try {
  & $scriptPath @scriptArgs *>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      $hadError = $true
      Add-CapturedText $stderr ($_ | Out-String)
    } elseif ($_ -is [System.Management.Automation.InformationRecord]) {
      Add-CapturedText $stdout $_.MessageData
    } else {
      Add-CapturedText $stdout $_
    }
  }
  if (-not $?) {
    $hadError = $true
  }
  if ($LASTEXITCODE) {
    $nativeExitCode = $LASTEXITCODE
  }
} catch {
  $hadError = $true
  Add-CapturedText $stderr ($_ | Out-String)
}
$payload = @{
  stdout = ($stdout -join [Environment]::NewLine)
  stderr = ($stderr -join [Environment]::NewLine)
  hadError = $hadError
  exitCode = $nativeExitCode
} | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload)
[Console]::Out.Write([System.Convert]::ToBase64String($bytes))
if ($hadError -or $nativeExitCode -ne 0) {
  exit 1
}
`;
}

function formatExecErrorMessage(errorMessage: string, result: ExecResult) {
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return details || errorMessage;
}

function runPowerShellScript(scriptPath: string, args: string[], cwd: string) {
  const captureCommand = buildPowerShellCaptureCommand(scriptPath, args);
  return new Promise<ExecResult>((resolve, reject) => {
    execFile(
      windowsPowerShellPath(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", captureCommand],
      { cwd, env: buildServiceEnv() },
      (error, stdout, stderr) => {
        const decoded = decodePowerShellCapturePayload(stdout);
        const result = decoded ?? {
          stdout: "",
          stderr: [coerceExecText(stderr).trim(), coerceExecText(stdout).trim()].filter(Boolean).join("\n")
        };

        if (error) {
          reject(new Error(formatExecErrorMessage(error.message, result)));
          return;
        }

        resolve({
          stdout: result.stdout,
          stderr: result.stderr
        });
      }
    );
  });
}

function resolveExecCommand(command: string, args: string[], cwd: string) {
  if (IS_WINDOWS && command.toLowerCase().endsWith(".ps1")) {
    const scriptPath = path.isAbsolute(command) ? command : path.join(cwd, command);
    return {
      command: scriptPath,
      args,
      powershellScript: true
    };
  }
  return { command, args, powershellScript: false };
}

function runExecFile(command: string, args: string[], cwd: string) {
  const resolved = resolveExecCommand(command, args, cwd);
  if (resolved.powershellScript) {
    return runPowerShellScript(resolved.command, resolved.args, cwd);
  }

  return new Promise<ExecResult>((resolve, reject) => {
    execFile(resolved.command, resolved.args, { cwd, env: buildServiceEnv() }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${coerceExecText(stderr)}`.trim()));
        return;
      }
      resolve({
        stdout: coerceExecText(stdout),
        stderr: coerceExecText(stderr)
      });
    });
  });
}

function containerEngineAvailable() {
  const env = buildServiceEnv();
  const probe = IS_WINDOWS
    ? (name: string) => spawnSync("where.exe", [name], { encoding: "utf8", env })
    : (name: string) => spawnSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8", env });

  if (probe("docker").status === 0) {
    return "docker";
  }
  if (probe("podman").status === 0) {
    return "podman";
  }
  return "";
}

function collectPrerequisites(service: ServiceDefinition, installDir: string) {
  const prerequisites: string[] = [];
  const envPath = path.join(installDir, ".env");
  if (!fs.existsSync(envPath)) {
    prerequisites.push("缺少 .env 配置文件");
  }

  for (const target of service.importTargets) {
    const targetPath = path.join(installDir, target.relativePath);
    if (target.required && !fs.existsSync(targetPath)) {
      prerequisites.push(`缺少 ${target.label}`);
    }
  }

  if (service.id === "agent-container-hub" && !containerEngineAvailable()) {
    prerequisites.push("未检测到 Docker 或 Podman");
  }

  return prerequisites;
}

function ensureDefaultConfig(service: ServiceDefinition, installDir: string) {
  for (const configFile of service.configFiles) {
    const targetPath = path.join(installDir, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = path.join(installDir, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}

async function ensureInitializationRequirements(app: App, service: ServiceDefinition, installDir: string) {
  if (service.id !== "pan-webclient") {
    return;
  }

  const publicKeyPath = path.join(installDir, "configs", "local-public-key.pem");
  if (fs.existsSync(publicKeyPath)) {
    return;
  }

  const { publicKeyPem } = ensureKeyPairForPan(app);
  ensureDir(path.dirname(publicKeyPath));
  fs.writeFileSync(publicKeyPath, publicKeyPem, "utf8");
}

async function ensureMutableInstallDir(app: App, service: ServiceDefinition) {
  const installDir = getInstallDir(app, service);
  if (fs.existsSync(installDir)) {
    return installDir;
  }

  if (service.kind === "builtin") {
    await installBuiltinService(app, service.id);
    return getInstallDir(app, service);
  }

  throw new Error(`${service.name} 尚未导入，请先导入插件。`);
}

type InstallBuiltinServiceOptions = {
  force?: boolean;
  archivePath?: string;
};

export async function installBuiltinService(
  app: App,
  serviceId: ServiceId,
  options: InstallBuiltinServiceOptions = {}
) {
  const service = getService(serviceId);
  if (service.kind !== "builtin") {
    throw new Error(`service ${serviceId} is not a builtin service`);
  }
  const assetPath = options.archivePath
    ? ensureArchiveHealthy(service, options.archivePath, "安装包")
    : ensureBundleAssetHealthy(app, service);

  const finalInstallDir = getInstallDir(app, service);
  const needsExtract =
    options.force ||
    !fs.existsSync(finalInstallDir) ||
    !isInstallHealthy(service, finalInstallDir) ||
    isAssetNewerThanInstall(assetPath, finalInstallDir);

  if (!needsExtract) {
    const initialization = await initializeService(app, serviceId);
    if (!initialization.ok) {
      throw new Error(initialization.message);
    }
    return finalInstallDir;
  }

  const versionRoot = path.dirname(finalInstallDir);
  ensureDir(versionRoot);
  const preservedEnvPath = path.join(finalInstallDir, ".env");
  const hasPreservedEnv = fileExists(preservedEnvPath);
  const preservedEnv = hasPreservedEnv ? fs.readFileSync(preservedEnvPath, "utf8") : "";

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${service.id}-extract-`));
  try {
    extractArchiveToDir(assetPath, tempRoot);
    const entries = fs.readdirSync(tempRoot);
    if (entries.length !== 1) {
      throw new Error(`unexpected archive layout for ${service.id}`);
    }
    const extractedRoot = path.join(tempRoot, entries[0]);
    fs.rmSync(finalInstallDir, { recursive: true, force: true });
    fs.cpSync(extractedRoot, finalInstallDir, { recursive: true });
    if (hasPreservedEnv) {
      fs.writeFileSync(path.join(finalInstallDir, ".env"), preservedEnv, "utf8");
    }
    const initialization = await initializeService(app, serviceId);
    if (!initialization.ok) {
      throw new Error(initialization.message);
    }
    return finalInstallDir;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function initializeService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const currentState = await getServiceState(app, serviceId);

  if (!currentState.installed) {
    return {
      ok: false,
      message: service.kind === "plugin" ? `${service.name} 尚未导入，请先导入插件。` : `${service.name} 尚未安装。`,
      service: currentState
    };
  }

  if (!isInstallHealthy(service, installDir)) {
    return {
      ok: false,
      message: currentState.message,
      service: currentState
    };
  }

  try {
    ensureDefaultConfig(service, installDir);
    fixShellScriptPermissions(installDir);
    await ensureInitializationRequirements(app, service, installDir);
    if (service.deployCommand) {
      await runExecFile(service.deployCommand[0], service.deployCommand.slice(1), installDir);
    }
    writeInitializationState(installDir, {
      version: service.version,
      status: "succeeded",
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    writeInitializationState(installDir, {
      version: service.version,
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error)
    });
    const nextState = await getServiceState(app, serviceId);
    return {
      ok: false,
      message: nextState.message,
      service: nextState
    };
  }

  const nextState = await getServiceState(app, serviceId);
  return {
    ok: true,
    message: `${service.name} 已初始化。`,
    service: nextState
  };
}

export async function listServices(app: App) {
  return Promise.all(getAllServices().map((service) => getServiceState(app, service.id)));
}

export async function getServiceState(app: App, serviceId: ServiceId): Promise<ServiceState> {
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const installed = fs.existsSync(installDir);
  const pidFilePath = resolveRuntimePath(installDir, service.runtime.pidRelativePath);
  const logFilePath = resolveRuntimePath(installDir, service.runtime.logRelativePath);
  const errorLogFilePath = resolveRuntimePath(installDir, service.runtime.errorLogRelativePath);
  const configFiles = service.configFiles.map((configFile) => {
    const absolutePath = path.join(installDir, configFile.relativePath);
    return {
      key: configFile.key,
      label: configFile.label,
      relativePath: configFile.relativePath,
      absolutePath,
      required: configFile.required,
      exists: fs.existsSync(absolutePath)
    };
  });

  const env = installed ? readEnvFile(path.join(installDir, ".env")) : new Map<string, string>();
  const port = parsePort(service, env);
  const webUrl = installed ? getWebUrl(service, env) : getWebUrl(service, new Map<string, string>());
  const pid = installed ? readPid(pidFilePath) : null;
  const missingRuntimeFiles = installed ? listMissingRuntimeFiles(service, installDir) : [];
  const initializationState =
    installed && missingRuntimeFiles.length === 0 ? readInitializationState(installDir) : null;
  const initializationSucceeded =
    initializationState?.status === "succeeded" && initializationState.version === service.version;
  const prerequisites =
    installed && missingRuntimeFiles.length === 0 && initializationSucceeded
      ? collectPrerequisites(service, installDir)
      : [];
  const running = installed && missingRuntimeFiles.length === 0 && isProcessRunning(pid);

  let status: ServiceState["status"] = "not-installed";
  let statusLabel = "未安装";
  let message = "尚未安装到本地运行目录。";

  if (installed) {
    status = "stopped";
    statusLabel = "已停止";
    message = "服务已安装，可手动启动。";
  }

  if (installed && missingRuntimeFiles.length > 0) {
    status = "error";
    statusLabel = "安装损坏";
    message = `安装目录缺少关键文件：${missingRuntimeFiles.join(", ")}`;
  }

  if (installed && missingRuntimeFiles.length === 0 && !initializationSucceeded) {
    if (initializationState?.status === "failed" && initializationState.version === service.version) {
      status = "error";
      statusLabel = "初始化失败";
      message = initializationState.lastError ? `初始化失败：${initializationState.lastError}` : "初始化失败，请重试。";
    } else {
      status = "initialization-required";
      statusLabel = "待初始化";
      message = service.kind === "plugin" ? "插件已导入，请先完成初始化。" : "服务已安装，请先完成初始化。";
    }
  }

  if (!installed && service.kind === "builtin") {
    try {
      ensureBundleAssetHealthy(app, service);
    } catch (error) {
      status = "error";
      statusLabel = "资源损坏";
      message = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed && missingRuntimeFiles.length === 0 && initializationSucceeded && prerequisites.length > 0) {
    const hasDependencyError = prerequisites.some((item) => item.includes("Docker") || item.includes("Podman"));
    status = hasDependencyError ? "dependency-missing" : "config-required";
    statusLabel = hasDependencyError ? "依赖未满足" : "待配置";
    message = prerequisites.join("；");
  }

  if (running && initializationSucceeded) {
    status = "running";
    statusLabel = "运行中";
    message = `服务进程正在运行。${webUrl ? `入口：${webUrl}` : ""}`.trim();
  }

  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    version: service.version,
    description: service.description,
    installDir,
    installed,
    status,
    statusLabel,
    message,
    frontendMode: service.frontend.mode,
    configFiles,
    healthMeta: {
      pid,
      pidFilePath,
      logFilePath,
      errorLogFilePath,
      webUrl,
      port,
      prerequisites
    }
  };
}

const agentPlatformDefaultContainerHubBaseUrls = new Set([
  "",
  "http://127.0.0.1:11960",
  "http://localhost:11960",
  "http://host.docker.internal:11960"
]);

const agentWebclientDefaultBaseUrls = new Set([
  "",
  "http://127.0.0.1:11949",
  "http://localhost:11949"
]);

async function ensurePreStartRequirements(app: App, service: ServiceDefinition) {
  if (service.id === "agent-platform") {
    const installDir = getInstallDir(app, service);
    const envPath = path.join(installDir, ".env");
    const env = readEnvFile(envPath);
    const currentHubBaseUrl = env.get("AGENT_CONTAINER_HUB_BASE_URL") ?? "";
    const updates = new Map<string, string>();

    try {
      const hubState = await getServiceState(app, "agent-container-hub");
      const desiredHubBaseUrl = `http://127.0.0.1:${hubState.healthMeta.port}`;
      if (agentPlatformDefaultContainerHubBaseUrls.has(currentHubBaseUrl)) {
        updates.set("AGENT_CONTAINER_HUB_BASE_URL", desiredHubBaseUrl);
      }
    } catch {
      // Agent Platform can run without Container Hub being registered in Desktop.
    }
    if (!env.get("SERVER_PORT")) {
      updates.set("SERVER_PORT", String(service.web.defaultPort));
    }
    updates.set("AGENT_AUTH_ENABLED", "true");
    updates.set("AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE", path.join("configs", "local-public-key.pem"));

    if (updates.size > 0) {
      writeEnvFileUpdates(envPath, updates);
    }

    const { publicKeyPem } = ensureKeyPairForPan(app);
    const publicKeyPath = path.join(installDir, "configs", "local-public-key.pem");
    ensureDir(path.dirname(publicKeyPath));
    fs.writeFileSync(publicKeyPath, publicKeyPem, "utf8");
    return;
  }

  if (service.id === "agent-webclient") {
    const installDir = getInstallDir(app, service);
    const envPath = path.join(installDir, ".env");
    const env = readEnvFile(envPath);
    const platformState = await getServiceState(app, "agent-platform");
    const desiredBaseUrl = `http://127.0.0.1:${platformState.healthMeta.port || 11949}`;
    const currentBaseUrl = env.get("BASE_URL") ?? "";
    const updates = new Map<string, string>();

    if (agentWebclientDefaultBaseUrls.has(currentBaseUrl)) {
      updates.set("BASE_URL", desiredBaseUrl);
    }
    if (!env.get("PORT")) {
      updates.set("PORT", String(service.web.defaultPort));
    }

    if (updates.size > 0) {
      writeEnvFileUpdates(envPath, updates);
    }
  }
}

async function runServiceCommand(app: App, service: ServiceDefinition, command: string[], successMessage: string) {
  const installDir = getInstallDir(app, service);
  if (!fs.existsSync(installDir) || !isInstallHealthy(service, installDir)) {
    if (service.kind !== "builtin") {
      throw new Error(`${service.name} 未安装或安装已损坏。`);
    }
    await installBuiltinService(app, service.id);
  }
  if (command.length === 0) {
    throw new Error(`${service.name} 缺少可执行脚本定义。`);
  }
  await runExecFile(command[0], command.slice(1), installDir);
  return {
    ok: true,
    message: successMessage,
    service: await getServiceState(app, service.id)
  } satisfies ServiceCommandResult;
}

export async function startService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const current = await getServiceState(app, serviceId);
  const service = getService(serviceId);
  const installDir = getInstallDir(app, service);
  const initializationState = current.installed ? readInitializationState(installDir) : null;

  if (current.status === "initialization-required") {
    return {
      ok: false,
      message: current.message,
      service: current
    };
  }

  if (initializationState?.status === "failed" && initializationState.version === service.version) {
    return {
      ok: false,
      message: current.message,
      service: current
    };
  }

  if ((!current.installed || current.status === "error") && current.kind === "builtin") {
    await installBuiltinService(app, serviceId);
  }
  const nextState = await getServiceState(app, serviceId);
  if (
    nextState.status === "config-required" ||
    nextState.status === "dependency-missing" ||
    nextState.status === "error"
  ) {
    return {
      ok: false,
      message: nextState.message,
      service: nextState
    };
  }
  if (nextState.status === "running") {
    return {
      ok: true,
      message: `${nextState.name} 已在运行。`,
      service: nextState
    };
  }

  await ensurePreStartRequirements(app, service);
  const result = await runServiceCommand(app, service, service.startCommand, `${service.name} 已启动。`);
  startedThisSession.add(serviceId);
  return result;
}

export async function stopService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const current = await getServiceState(app, serviceId);
  if (!current.installed) {
    return {
      ok: true,
      message: `${service.name} 尚未安装。`,
      service: current
    };
  }
  if (current.status !== "running") {
    return {
      ok: true,
      message: `${service.name} 当前未运行。`,
      service: current
    };
  }

  const result = await runServiceCommand(app, service, service.stopCommand, `${service.name} 已停止。`);
  startedThisSession.delete(serviceId);
  return result;
}

export async function restartService(app: App, serviceId: ServiceId): Promise<ServiceCommandResult> {
  await stopService(app, serviceId);
  return startService(app, serviceId);
}

export async function readServiceConfig(app: App, serviceId: ServiceId, key: string): Promise<ServiceConfigReadResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }

  const installDir = getInstallDir(app, service);
  if (!fs.existsSync(installDir)) {
    return {
      ok: true,
      path: path.join(installDir, configFile.relativePath),
      content: "",
      exists: false,
      source: "missing"
    };
  }

  const filePath = path.join(installDir, configFile.relativePath);
  if (fs.existsSync(filePath)) {
    return {
      ok: true,
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
      exists: true,
      source: "file"
    };
  }

  if (configFile.templateRelativePath) {
    const templatePath = path.join(installDir, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      return {
        ok: true,
        path: filePath,
        content: fs.readFileSync(templatePath, "utf8"),
        exists: false,
        source: "template"
      };
    }
  }

  return {
    ok: true,
    path: filePath,
    content: "",
    exists: false,
    source: "missing"
  };
}

export async function writeServiceConfig(
  app: App,
  serviceId: ServiceId,
  key: string,
  content: string
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }

  const installDir = await ensureMutableInstallDir(app, service);

  const filePath = path.join(installDir, configFile.relativePath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");

  return {
    ok: true,
    message: `${service.name} 配置已保存。`,
    service: await getServiceState(app, serviceId)
  };
}

export async function importServiceFile(
  app: App,
  serviceId: ServiceId,
  targetKey: string,
  sourcePath: string
): Promise<ServiceImportResult> {
  const service = getService(serviceId);
  const target = service.importTargets.find((item) => item.key === targetKey);
  if (!target) {
    throw new Error(`unknown import target: ${targetKey}`);
  }

  const installDir = await ensureMutableInstallDir(app, service);

  const targetPath = path.join(installDir, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);

  return {
    ok: true,
    message: `${target.label} 已导入。`,
    targetPath,
    service: await getServiceState(app, serviceId)
  };
}

export async function getServiceLogsMeta(app: App, serviceId: ServiceId): Promise<ServiceLogsMeta> {
  const state = await getServiceState(app, serviceId);
  return {
    ok: true,
    logPath: state.healthMeta.logFilePath,
    exists: fs.existsSync(state.healthMeta.logFilePath)
  };
}

export async function readServiceLog(
  app: App,
  serviceId: ServiceId,
  target: ServiceLogTarget
): Promise<ServiceLogReadResult> {
  const state = await getServiceState(app, serviceId);
  const filePath = target === "error" ? state.healthMeta.errorLogFilePath : state.healthMeta.logFilePath;

  if (!filePath) {
    return {
      ok: true,
      path: "",
      exists: false,
      content: "",
      truncated: false,
      startOffset: 0,
      totalBytes: 0
    };
  }

  try {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    const startOffset = Math.max(0, totalBytes - LOG_READ_WINDOW_BYTES);
    const bytesToRead = totalBytes - startOffset;

    if (bytesToRead === 0) {
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: "",
        truncated: false,
        startOffset,
        totalBytes
      };
    }

    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, startOffset);
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: buffer.toString("utf8", 0, bytesRead),
        truncated: startOffset > 0,
        startOffset,
        totalBytes
      };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        exists: false,
        content: "",
        truncated: false,
        startOffset: 0,
        totalBytes: 0
      };
    }
    throw error;
  }
}

export async function stopStartedServices(app: App) {
  for (const serviceId of [...startedThisSession]) {
    try {
      await stopService(app, serviceId);
    } catch (error) {
      console.error(`failed to stop ${serviceId} during app shutdown`, error);
    }
  }
}

export async function stopRunningServices(app: App) {
  const services = await listServices(app);
  const failures: string[] = [];

  for (const service of services) {
    if (service.status !== "running") {
      continue;
    }

    try {
      await stopService(app, service.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${service.name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`停止运行中服务失败：${failures.join("；")}`);
  }
}

export const __testInternals = {
  LOG_READ_WINDOW_BYTES,
  parseEnvFileContent,
  parsePort,
  getWebUrl,
  containerEngineAvailable,
  fixShellScriptPermissions,
  listMissingRuntimeFiles,
  isInstallHealthy,
  listMissingBundleEntries,
  ensureBundleAssetHealthy,
  upsertEnvFileContent,
  ensurePreStartRequirements,
  decodePowerShellCapturePayload,
  getInitializationStatePath,
  readInitializationState
};
