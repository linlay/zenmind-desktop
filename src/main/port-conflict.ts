import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { ServiceDefinition } from "./manifest-utils";

type ShowMessageBox = typeof import("electron").dialog.showMessageBox;

type CommandResult = {
  stdout: string;
  stderr: string;
  error: (Error & { code?: number | string }) | null;
};

export type PortProcessInfo = {
  pid: number;
  name: string;
};

export type PortConflictInfo = {
  port: number;
  processInfo: PortProcessInfo | null;
};

interface DetectPortConflictOptions {
  fallbackPort?: number | null;
  findProcessOnPort?: typeof findProcessOnPort;
}

interface ShowPortConflictDialogDeps {
  showMessageBox?: ShowMessageBox;
}

interface KillProcessDeps {
  processRef?: Pick<NodeJS.Process, "kill" | "pid">;
  wait?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  taskkill?: (pid: number) => Promise<boolean>;
}

function normalizePort(port: number | null | undefined) {
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getDefaultShowMessageBox(): ShowMessageBox {
  const electronDialog = (require("electron") as typeof import("electron")).dialog;
  return electronDialog.showMessageBox.bind(electronDialog) as ShowMessageBox;
}

function runCommand(command: string, args: string[]) {
  return new Promise<CommandResult>((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        error: (error as CommandResult["error"]) ?? null
      });
    });
  });
}

function resolveUnixCommand(command: string) {
  const candidates = [
    path.join("/usr/sbin", command),
    path.join("/usr/bin", command),
    path.join("/bin", command),
    path.join("/usr/local/bin", command)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? command;
}

function buildWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function getProcessLabel(processInfo: PortProcessInfo | null) {
  if (!processInfo) {
    return "其他进程";
  }
  const processName = processInfo.name.trim() || "未知进程";
  return `进程 ${processName} (PID ${processInfo.pid})`;
}

export function isPortConflictError(errorMessage: string) {
  return /address already in use|EADDRINUSE/iu.test(errorMessage);
}

export function extractPortFromError(errorMessage: string) {
  const patterns = [
    /listen\s+\w+\s+(?:\[[^\]]+\]|[0-9a-f:.]+|localhost)?:(\d{2,5})(?::\s*bind|\b)/iu,
    /address already in use[^0-9\n]*(?:\[[^\]]+\]|[0-9a-f:.]+|localhost)?:(\d{2,5})\b/iu,
    /EADDRINUSE[^0-9\n]*(\d{2,5})\b/iu
  ];

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    const port = normalizePort(Number.parseInt(match?.[1] ?? "", 10));
    if (port) {
      return port;
    }
  }

  return null;
}

async function findUnixProcessOnPort(port: number): Promise<PortProcessInfo | null> {
  const lsofResult = await runCommand(resolveUnixCommand("lsof"), ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsofResult.error) {
    return null;
  }

  const pid = Number.parseInt(lsofResult.stdout.split(/\s+/u).find(Boolean) ?? "", 10);
  if (!Number.isInteger(pid) || pid < 1) {
    return null;
  }

  const psResult = await runCommand(resolveUnixCommand("ps"), ["-p", String(pid), "-o", "comm="]);
  const rawName = psResult.stdout.trim();
  return {
    pid,
    name: rawName ? path.basename(rawName) : "未知进程"
  };
}

async function findWindowsProcessOnPort(port: number): Promise<PortProcessInfo | null> {
  const lookupScript = [
    `$connection = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($null -eq $connection) { exit 0 }",
    "$pid = [int]$connection.OwningProcess",
    "$process = Get-Process -Id $pid -ErrorAction SilentlyContinue | Select-Object -First 1",
    'if ($null -eq $process) { Write-Output "$pid`t" } else { Write-Output "$pid`t$($process.ProcessName)" }'
  ].join("; ");

  const result = await runCommand(buildWindowsPowerShellPath(), [
    "-NoProfile",
    "-Command",
    lookupScript
  ]);
  if (result.error) {
    return null;
  }

  const [pidText, ...nameParts] = result.stdout.trim().split(/\t/u);
  const pid = Number.parseInt(pidText ?? "", 10);
  if (!Number.isInteger(pid) || pid < 1) {
    return null;
  }

  const rawName = nameParts.join("\t").trim();
  return {
    pid,
    name: rawName || "未知进程"
  };
}

export async function findProcessOnPort(port: number): Promise<PortProcessInfo | null> {
  if (!normalizePort(port)) {
    return null;
  }
  if (process.platform === "win32") {
    return findWindowsProcessOnPort(port);
  }
  return findUnixProcessOnPort(port);
}

export async function detectPortConflict(
  errorMessage: string,
  service: Pick<ServiceDefinition, "web">,
  options: DetectPortConflictOptions = {}
): Promise<PortConflictInfo | null> {
  if (!isPortConflictError(errorMessage)) {
    return null;
  }

  const port =
    extractPortFromError(errorMessage) ??
    normalizePort(options.fallbackPort ?? null) ??
    normalizePort(service.web.defaultPort);
  if (!port) {
    return null;
  }

  const findProcess = options.findProcessOnPort ?? findProcessOnPort;
  return {
    port,
    processInfo: await findProcess(port)
  };
}

export function buildPortConflictDialogOptions(port: number, processInfo: PortProcessInfo | null): MessageBoxOptions {
  return {
    type: "warning",
    buttons: ["取消", "终止进程并重启"],
    defaultId: 0,
    cancelId: 0,
    title: "端口被占用",
    message: `端口 ${port} 已被${getProcessLabel(processInfo)}占用。是否终止该进程并重新启动？`,
    detail: "确认后会先终止占用进程，再自动重试启动服务。"
  };
}

export async function showPortConflictDialog(
  ownerWindow: BrowserWindow | null,
  port: number,
  processInfo: PortProcessInfo | null,
  deps: ShowPortConflictDialogDeps = {}
): Promise<boolean> {
  const showMessageBox = deps.showMessageBox ?? getDefaultShowMessageBox();
  const options = buildPortConflictDialogOptions(port, processInfo);
  const result: MessageBoxReturnValue = ownerWindow
    ? await showMessageBox(ownerWindow, options)
    : await showMessageBox(options);
  return result.response === 1;
}

function isProcessGone(pid: number, processRef: Pick<NodeJS.Process, "kill" | "pid">) {
  try {
    processRef.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function killWindowsProcessTreeByPid(
  pid: number,
  processRef: Pick<NodeJS.Process, "kill" | "pid"> = process
) {
  return new Promise<boolean>((resolve) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
      if (!error || isProcessGone(pid, processRef)) {
        resolve(true);
        return;
      }

      resolve(false);
    });
  });
}

export async function killProcessByPid(pid: number, deps: KillProcessDeps = {}) {
  const normalizedPid = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(normalizedPid) || normalizedPid < 1) {
    return false;
  }

  const processRef = deps.processRef ?? process;
  const platform = deps.platform ?? process.platform;
  if (normalizedPid === processRef.pid) {
    return false;
  }

  const wait = deps.wait ?? delay;
  if (platform === "win32") {
    const taskkill = deps.taskkill ?? ((targetPid: number) => killWindowsProcessTreeByPid(targetPid, processRef));
    const killed = await taskkill(normalizedPid);
    if (killed) {
      await wait(250);
      return isProcessGone(normalizedPid, processRef);
    }
  }

  try {
    processRef.kill(normalizedPid, "SIGTERM");
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") {
      return true;
    }
  }

  await wait(250);
  if (isProcessGone(normalizedPid, processRef)) {
    return true;
  }

  try {
    processRef.kill(normalizedPid, "SIGKILL");
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") {
      return true;
    }
    return false;
  }

  await wait(250);
  return isProcessGone(normalizedPid, processRef);
}

export const __testInternals = {
  buildPortConflictDialogOptions,
  killWindowsProcessTreeByPid
};
