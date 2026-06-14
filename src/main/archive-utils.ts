import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
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
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isWindows || isMac) {
      return "zip" as const;
    }
    throw new Error(`zip archives are only supported on Windows and macOS: ${archivePath}`);
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

function runPowerShellAsync(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: SYNC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout || "");
        }
      }
    );
  });
}

function decodeBase64Utf8(content: string) {
  const trimmed = content.trim();
  return trimmed ? Buffer.from(trimmed, "base64").toString("utf8") : "";
}

// PowerShell stdout follows the active code page, so return UTF-8 text as Base64.
function runPowerShellForUtf8Text(script: string) {
  return decodeBase64Utf8(runPowerShell(script));
}

function unsafeArchiveEntryPath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  return normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized === ".." ||
    /^[A-Za-z]:\//u.test(normalized);
}

function resolveSafeArchiveTarget(rootDir: string, entryName: string) {
  const normalized = entryName.trim().replace(/\\/g, "/");
  if (unsafeArchiveEntryPath(normalized)) {
    throw new Error(`archive contains unsafe path: ${entryName}`);
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...normalized.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`archive entry escapes target directory: ${entryName}`);
  }
  return target;
}

async function listZipArchiveEntriesWithJSZip(archivePath: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(archivePath));
  return new Set(
    Object.values(zip.files)
      .map((entry) => entry.name.trim().replace(/\\/g, "/"))
      .filter(Boolean)
  );
}

async function extractZipArchiveWithJSZip(archivePath: string, targetDir: string) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(archivePath));
  for (const entry of Object.values(zip.files)) {
    const entryName = entry.name.trim().replace(/\\/g, "/");
    if (!entryName) {
      continue;
    }
    const targetPath = resolveSafeArchiveTarget(targetDir, entryName);
    if (entry.dir || entryName.endsWith("/")) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, await entry.async("nodebuffer"));
  }
}

export function listArchiveEntries(archivePath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip") {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isMac) {
      throw new Error(`sync zip entry listing is not supported on macOS: ${archivePath}`);
    }
    if (!isWindows) {
      throw new Error(`zip archives are only supported on Windows and macOS: ${archivePath}`);
    }
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

export async function listArchiveEntriesAsync(archivePath: string) {
  const archiveType = ensureSupportedArchive(archivePath);
  if (archiveType === "zip" && process.platform === "darwin") {
    return listZipArchiveEntriesWithJSZip(archivePath);
  }
  return listArchiveEntries(archivePath);
}

export async function extractArchiveToDir(archivePath: string, targetDir: string): Promise<void> {
  const timing = beginStartupTiming("extractArchiveToDir", {
    archive: archivePath.split(/[\\/]/u).pop() ?? archivePath
  });
  const archiveType = ensureSupportedArchive(archivePath);
  try {
    fs.mkdirSync(targetDir, { recursive: true });

    if (archiveType === "zip") {
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      if (isMac) {
        await extractZipArchiveWithJSZip(archivePath, targetDir);
        return;
      }
      if (!isWindows) {
        throw new Error(`zip archives are only supported on Windows and macOS: ${archivePath}`);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "tar.exe",
            ["-xf", archivePath, "-C", targetDir],
            { timeout: SYNC_TIMEOUT_MS },
            (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        });
        return;
      } catch (tarError) {
        console.warn(`[archive-utils] tar.exe failed to extract, falling back to PowerShell:`, tarError);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(targetDir, { recursive: true });
        await runPowerShellAsync(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest = ${quotePowerShell(targetDir)}
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quotePowerShell(archivePath)}, $dest)
`);
        return;
      }
    }

    await new Promise<void>((resolve, reject) => {
      execFile(
        tarCommand(),
        ["-xzf", archivePath, "-C", targetDir],
        { timeout: SYNC_TIMEOUT_MS },
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
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
