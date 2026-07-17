#Requires -Version 5.1
param(
    [string]$WorkspaceRoot
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopRoot = Split-Path -Parent $ScriptDir
if (-not $WorkspaceRoot) { $WorkspaceRoot = Split-Path -Parent $DesktopRoot }
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$PlatformRoot = Join-Path $WorkspaceRoot "agent-platform"
$CanonicalLock = Join-Path $PlatformRoot "scripts/release-assets/builtins.lock.json"
$Services = @("agent-container-hub", "agent-webclient", "agent-platform", "identity-center")

if ($env:OS -ne "Windows_NT" -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    throw "This end-to-end regression requires Windows AMD64 PowerShell 5.1"
}
foreach ($command in @("go", "git", "make", "node", "npm", "robocopy", "cargo", "rustup", "protoc", "syft")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required" }
}
if (-not (Test-Path -LiteralPath $CanonicalLock -PathType Leaf)) { throw "Canonical lock is missing: $CanonicalLock" }
$lockHashBefore = (Get-FileHash -LiteralPath $CanonicalLock -Algorithm SHA256).Hash

try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PlatformRoot "scripts/sync-local-builtins.ps1") -Target windows/amd64
    if ($LASTEXITCODE -ne 0) { throw "Native builtin preparation failed" }

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DesktopRoot "scripts/build-all-dist.ps1") -SyncOS windows -SyncArch amd64 -WorkspaceRoot $WorkspaceRoot
    if ($LASTEXITCODE -ne 0) { throw "Desktop four-service orchestration failed" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    foreach ($service in $Services) {
        $repoRoot = Join-Path $WorkspaceRoot $service
        $version = (Get-Content -LiteralPath (Join-Path $repoRoot "VERSION") -Raw).Trim()
        $archive = Join-Path $repoRoot "dist/release/$service-$version-windows-amd64.zip"
        if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Missing Windows Program Bundle: $archive" }
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            if ($zip.Entries.Count -eq 0) { throw "Empty Program Bundle: $archive" }
            foreach ($entry in $zip.Entries) {
                if (-not $entry.FullName.StartsWith("$service/")) { throw "ZIP entry is outside $service/: $($entry.FullName)" }
                if ($entry.FullName.Contains("\")) { throw "ZIP entry uses a non-portable separator: $($entry.FullName)" }
            }
        } finally { $zip.Dispose() }
    }

    $platformVersion = (Get-Content -LiteralPath (Join-Path $PlatformRoot "VERSION") -Raw).Trim()
    $platformArchive = Join-Path $PlatformRoot "dist/release/agent-platform-$platformVersion-windows-amd64.zip"
    foreach ($suffix in @(".sha256", ".sizes.json", ".sbom.cdx.json")) {
        if (-not (Test-Path -LiteralPath "$platformArchive$suffix" -PathType Leaf)) {
            throw "Missing Agent Platform release report: $platformArchive$suffix"
        }
    }

    $desktopManifestPath = Join-Path $DesktopRoot "build/resources/services/manifest.json"
    $desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($desktopManifest.services).Count -ne 4) { throw "Desktop did not sync exactly four builtin services" }
    foreach ($service in $Services) {
        $record = @($desktopManifest.services | Where-Object { $_.id -eq $service })
        if ($record.Count -ne 1) { throw "Desktop manifest does not contain exactly one $service record" }
        if (-not ([string]$record[0].assetFileName).EndsWith("-windows-amd64.zip")) {
            throw "Desktop synced a non-Windows asset for $service: $($record[0].assetFileName)"
        }
    }

    Write-Host "[windows-release-chain] passed: synced 4 builtin service assets"
} finally {
    $lockHashAfter = (Get-FileHash -LiteralPath $CanonicalLock -Algorithm SHA256).Hash
    if ($lockHashAfter -ne $lockHashBefore) {
        throw "Canonical builtins.lock.json changed during the Windows release regression"
    }
}
