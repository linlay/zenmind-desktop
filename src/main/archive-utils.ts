import { execFileSync } from "node:child_process";
import { beginStartupTiming } from "./startup-timing";

function isZipArchive(archivePath: string) {
  return archivePath.toLowerCase().endsWith(".zip");
}

function isTarArchive(archivePath: string) {
  const normalized = archivePath.toLowerCase();
  return normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz") || normalized.endsWith(".skill");
}

function ensureSupportedArchive(archivePath: string) {
  if (isZipArchive(archivePath)) {
    if (process.platform !== "win32") {
      throw new Error(`zip archives are only supported on Windows: ${archivePath}`);
    }
    return "zip" as const;
  }

  if (isTarArchive(archivePath)) {
    return "tar" as const;
  }

  throw new Error(`unsupported archive format: ${archivePath}`);
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

const SYNC_TIMEOUT_MS = 300_000;

function tarCommand() {
  if (process.platform === "win32") {
    return "tar.exe";
  }
  if (process.platform === "darwin") {
    return "tar";
  }
  return "tar";
}

function runPowerShell(script: string) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: SYNC_TIMEOUT_MS }
  );
}

function decodeBase64Utf8(content: string) {
  const trimmed = content.trim();
  return trimmed ? Buffer.from(trimmed, "base64").toString("utf8") : "";
}

// PowerShell stdout follows the active code page, so return UTF-8 text as Base64.
function runPowerShellForUtf8Text(script: string) {
  return decodeBase64Utf8(runPowerShell(script));
}

export function listArchiveEntries(archivePath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip") {
    const output = runPowerShellForUtf8Text(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead(${quotePowerShell(archivePath)})
try {
  $entries = @($zip.Entries | ForEach-Object { $_.FullName })
  $json = if ($entries.Count -eq 0) { "[]" } else { ConvertTo-Json -Compress -InputObject $entries }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$json)
  [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
} finally {
  $zip.Dispose()
}
`);
    const entries = JSON.parse(output) as unknown;
    if (!Array.isArray(entries)) {
      throw new Error(`unexpected zip entry listing output: ${archivePath}`);
    }

    return new Set(
      entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().replace(/\\/g, "/"))
        .filter(Boolean)
    );
  }

  const output = execFileSync(tarCommand(), ["-tzf", archivePath], { encoding: "utf8", timeout: SYNC_TIMEOUT_MS });

  return new Set(
    output
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function extractArchiveToDir(archivePath: string, targetDir: string) {
  const timing = beginStartupTiming("extractArchiveToDir", {
    archive: archivePath.split(/[\\/]/u).pop() ?? archivePath
  });
  const archiveType = ensureSupportedArchive(archivePath);
  try {
    if (archiveType === "zip") {
      runPowerShell(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest = ${quotePowerShell(targetDir)}
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(archivePath)}, $dest)
`);
      return;
    }

    execFileSync(tarCommand(), ["-xzf", archivePath, "-C", targetDir], { timeout: SYNC_TIMEOUT_MS });
  } finally {
    timing.end({ type: archiveType });
  }
}

export function readFileFromArchive(archivePath: string, entryPath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip") {
    return runPowerShellForUtf8Text(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead(${quotePowerShell(archivePath)})
try {
  $entry = $zip.Entries | Where-Object { $_.FullName.Replace('\\', '/') -eq ${quotePowerShell(entryPath.replace(/\\/g, "/"))} } | Select-Object -First 1
  if ($null -eq $entry) {
    throw ${quotePowerShell(`archive entry not found: ${entryPath}`)}
  }

  $stream = $entry.Open()
  try {
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    try {
      $content = $reader.ReadToEnd()
      $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$content)
      [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
} finally {
  $zip.Dispose()
}
`);
  }

  return execFileSync(tarCommand(), ["-xzf", archivePath, "-O", entryPath], { encoding: "utf8", timeout: SYNC_TIMEOUT_MS });
}
