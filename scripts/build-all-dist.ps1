#Requires -Version 5.1
param(
    [string]$SyncOS = "windows",
    [string]$SyncArch = "amd64",
    [string]$WorkspaceRoot,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopRoot = Split-Path -Parent $ScriptDir
if (-not $WorkspaceRoot) { $WorkspaceRoot = Split-Path -Parent $DesktopRoot }
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$ServiceRepos = @(
    "agent-container-hub",
    "agent-webclient",
    "agent-platform",
    "identity-center"
)
$ClearedReleaseEnvironment = @(
    "VERSION",
    "TARGET_OS",
    "TARGET_ARCH",
    "PROGRAM_TARGETS",
    "PROGRAM_TARGET_MATRIX",
    "RELEASE_DRY_RUN",
    "GOOS",
    "GOARCH"
)

switch ($SyncOS.ToLowerInvariant()) {
    "windows" { $SyncOS = "windows" }
    "win32" { $SyncOS = "windows" }
    default { throw "Native PowerShell orchestration supports -SyncOS windows only (got: $SyncOS)" }
}
switch ($SyncArch.ToLowerInvariant()) {
    "amd64" { $SyncArch = "amd64" }
    "x64" { $SyncArch = "amd64" }
    default { throw "This release scope supports -SyncArch amd64 only (got: $SyncArch)" }
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Invoke-ServiceRelease {
    param([string]$RepoName)
    $projectDir = Join-Path $WorkspaceRoot $RepoName
    if (-not (Test-Path -LiteralPath $projectDir -PathType Container)) {
        throw "Missing service project: $projectDir"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir "Makefile") -PathType Leaf)) {
        throw "Missing Makefile: $projectDir"
    }
    Write-Host "[build-all-dist] release $RepoName (ARCH=$SyncArch)"
    if ($DryRun) {
        Write-Host "  (cd $projectDir; clear VERSION TARGET_OS TARGET_ARCH PROGRAM_TARGETS PROGRAM_TARGET_MATRIX RELEASE_DRY_RUN GOOS GOARCH; make release ARCH=$SyncArch)"
        return
    }

    $snapshot = @{}
    foreach ($name in $ClearedReleaseEnvironment) {
        $snapshot[$name] = [Environment]::GetEnvironmentVariable($name)
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Push-Location $projectDir
    try {
        & make release "ARCH=$SyncArch"
        if ($LASTEXITCODE -ne 0) {
            throw "Upstream release failed for $RepoName with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
        foreach ($name in $ClearedReleaseEnvironment) {
            if ($null -eq $snapshot[$name]) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($name, $snapshot[$name])
            }
        }
    }
}

function Sync-DesktopAssets {
    $arguments = @("./scripts/sync-builtin-assets.mjs")
    foreach ($repoName in $ServiceRepos) {
        $arguments += "--source=$(Join-Path (Join-Path $WorkspaceRoot $repoName) 'dist/release')"
    }
    $arguments += "--os=$SyncOS"
    $arguments += "--arch=$SyncArch"

    Write-Host "[build-all-dist] sync current upstream release packages into $DesktopRoot/build/resources/services"
    if ($DryRun) {
        Write-Host "  (cd $DesktopRoot; node $($arguments -join ' '))"
        return
    }
    Push-Location $DesktopRoot
    try {
        & node @arguments
        if ($LASTEXITCODE -ne 0) { throw "Desktop builtin asset sync failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

Assert-Command "make"
Assert-Command "node"
if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) {
    throw "Workspace root does not exist: $WorkspaceRoot"
}

Write-Host "[build-all-dist] workspace=$WorkspaceRoot desktop=$DesktopRoot target=$SyncOS/$SyncArch"
foreach ($repoName in $ServiceRepos) { Invoke-ServiceRelease -RepoName $repoName }
Sync-DesktopAssets
Write-Host "[build-all-dist] synced 4 builtin service assets"
