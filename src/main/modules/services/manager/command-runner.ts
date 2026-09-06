import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildServiceEnv } from "./command-env";
import { t } from "../../../support/i18n/main-i18n";

export const IS_WINDOWS = process.platform === "win32";
export const SERVICE_COMMAND_TIMEOUT_MS = 60_000;

export type ExecResult = {
  stdout: string;
  stderr: string;
};

type PowerShellCapturePayload = ExecResult & {
  hadError: boolean;
  exitCode: number;
};

export type RunExecFileOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function windowsPowerShellPath() {
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

export function decodePowerShellCapturePayload(value: string | Buffer): PowerShellCapturePayload | null {
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

function buildPowerShellWrapperScript(scriptPath: string, args: string[]) {
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
  $commandInfo = Get-Command $scriptPath
  $commonParams = @('Verbose','Debug','ErrorAction','WarningAction','InformationAction','ErrorVariable','WarningVariable','InformationVariable','OutVariable','OutBuffer','PipelineVariable','WhatIf','Confirm')
  $customParams = $commandInfo.Parameters.Keys | Where-Object { $commonParams -notcontains $_ }
  if ($customParams) {
    $scriptHash = @{}
    $scriptPos = @()
    for ($i = 0; $i -lt $scriptArgs.Length; $i += 2) {
      $name = $scriptArgs[$i].TrimStart('-')
      if ($commandInfo.Parameters.Keys -contains $name) {
        if ($i + 1 -lt $scriptArgs.Length) {
          $scriptHash[$name] = $scriptArgs[$i+1]
        } else {
          $scriptHash[$name] = $true
        }
      } else {
        $scriptPos += $scriptArgs[$i]
        if ($i + 1 -lt $scriptArgs.Length) {
          $scriptPos += $scriptArgs[$i+1]
        }
      }
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = & $scriptPath @scriptHash @scriptPos 2>&1
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  } else {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = & $scriptPath @scriptArgs 2>&1
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
  }
  foreach ($item in @($output)) {
    if ($item -is [System.Management.Automation.ErrorRecord]) {
      # Windows PowerShell converts stderr from a native child into an
      # ErrorRecord even when that child exits successfully. Stderr is valid
      # diagnostic output; the native exit code is the success signal.
      if ([string]$item.FullyQualifiedErrorId -ne 'NativeCommandError') {
        $hadError = $true
      }
      Add-CapturedText $stderr ($item | Out-String)
    } elseif ($item -is [System.Management.Automation.InformationRecord]) {
      Add-CapturedText $stdout $item.MessageData
    } else {
      Add-CapturedText $stdout $item
    }
  }
  if (-not $? -and $LASTEXITCODE -ne 0) {
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

function getCommandTimeoutMs(timeoutMs: number | undefined) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : SERVICE_COMMAND_TIMEOUT_MS;
}

function buildServiceCommandEnv(overrides?: NodeJS.ProcessEnv) {
  return {
    ...buildServiceEnv(),
    ...(overrides ?? {})
  };
}

function runPowerShellScript(scriptPath: string, args: string[], cwd: string, options: RunExecFileOptions = {}) {
  const wrapperScriptPath = path.join(
    os.tmpdir(),
    `desktop-powershell-wrapper-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );
  // Windows PowerShell 5.1 treats UTF-8 scripts without a BOM as ANSI, which
  // corrupts non-ASCII install/data paths before Get-Command sees them.
  fs.writeFileSync(wrapperScriptPath, `\uFEFF${buildPowerShellWrapperScript(scriptPath, args)}`, "utf8");
  const timeoutMs = getCommandTimeoutMs(options.timeoutMs);
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(windowsPowerShellPath(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapperScriptPath], {
      cwd,
      env: buildServiceCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(killTimer);
      try {
        fs.rmSync(wrapperScriptPath, { force: true });
      } catch {
        // Ignore wrapper cleanup failures and surface the script result instead.
      }
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const killTimer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (err) => {
      settle(() => reject(err));
    });
    child.once("exit", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const decoded = decodePowerShellCapturePayload(stdout);
      if (decoded) {
        decoded.stderr = [decoded.stderr.trim(), coerceExecText(stderr).trim()].filter(Boolean).join("\n");
      }
      const result = decoded ?? {
        stdout: "",
        stderr: [coerceExecText(stderr).trim(), coerceExecText(stdout).trim()].filter(Boolean).join("\n")
      };

      settle(() => {
        if (didTimeout) {
          reject(new Error(formatExecErrorMessage(`PowerShell command timed out after ${timeoutMs}ms`, result)));
          return;
        }

        if (code !== 0) {
          const status = signal ? `signal ${signal}` : `code ${code ?? -1}`;
          reject(new Error(formatExecErrorMessage(`PowerShell command exited with ${status}`, result)));
          return;
        }

        resolve({
          stdout: result.stdout,
          stderr: result.stderr
        });
      });
    });
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

export function runExecFile(command: string, args: string[], cwd: string, options: RunExecFileOptions = {}) {
  const resolved = resolveExecCommand(command, args, cwd);
  const timeoutMs = getCommandTimeoutMs(options.timeoutMs);
  if (resolved.powershellScript) {
    return runPowerShellScript(resolved.command, resolved.args, cwd, { timeoutMs, env: options.env });
  }

  return new Promise<ExecResult>((resolve, reject) => {
    if (!fs.existsSync(cwd)) {
      reject(new Error(t("service.commandCwdMissing", { cwd })));
      return;
    }

    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: buildServiceCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;

    const killTimer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (didTimeout) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${resolved.command} ${resolved.args.join(" ")}\n${stderr || stdout}`.trim()));
        return;
      }
      if (code !== 0) {
        const status = signal ? `signal ${signal}` : `code ${code ?? -1}`;
        reject(new Error(`Command failed: ${resolved.command} ${resolved.args.join(" ")} exited with ${status}\n${stderr || stdout}`.trim()));
        return;
      }
      resolve({
        stdout,
        stderr
      });
    });
  });
}
