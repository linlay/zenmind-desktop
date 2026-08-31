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
    Write-Host "[build-builtin-services] release $RepoName (ARCH=$SyncArch)"
    if ($DryRun) {
        Write-Host ('  (cd {0}; clear VERSION TARGET_OS TARGET_ARCH PROGRAM_TARGETS PROGRAM_TARGET_MATRIX RELEASE_DRY_RUN GOOS GOARCH; cmd.exe /d /s /c "make release ARCH={1}")' -f $projectDir, $SyncArch)
        return
    }

    $snapshot = @{}
    foreach ($name in $ClearedReleaseEnvironment) {
        $snapshot[$name] = [Environment]::GetEnvironmentVariable($name)
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Push-Location $projectDir
    try {
        # Invoke Make through cmd.exe so recursive $(MAKE) calls stay as `make`.
        # PowerShell otherwise resolves Make to a full path whose spaces break the recursive command.
        & cmd.exe /d /s /c "make release ARCH=$SyncArch"
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

function Assert-AgentPlatformBuiltins {
    $projectDir = Join-Path $WorkspaceRoot "agent-platform"
    $cacheDir = Join-Path $projectDir "build/builtins/$SyncOS-$SyncArch"
    $manifestPath = Join-Path $cacheDir "builtins.manifest.json"
    Write-Host "[build-builtin-services] check agent-platform builtin cache ($SyncOS/$SyncArch)"
    if ($DryRun) {
        Write-Host "  (require $manifestPath and the cached Windows builtin payloads)"
        return
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Missing agent-platform builtin cache: $cacheDir. Build it manually before running build-builtin-services.ps1."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedComponents = @("rg", "dbx", "httpx", "kbase-lance-engine", "poppler-pdftotext")
    $cachedComponents = @($manifest.components | ForEach-Object { $_.name })
    $missingComponents = @($expectedComponents | Where-Object { $_ -notin $cachedComponents })
    if ($missingComponents.Count -gt 0) {
        throw "agent-platform builtin cache is incomplete (missing: $($missingComponents -join ', ')). Build it manually before running build-builtin-services.ps1."
    }
    foreach ($relative in @("bin/rg.exe", "bin/dbx.exe", "bin/httpx.exe", "bin/kbase-lance-engine.exe", "bin/pdftotext.exe", "libexec/poppler-pdftotext/windows-amd64")) {
        $path = Join-Path $cacheDir $relative
        if (-not (Test-Path -LiteralPath $path)) {
            throw "agent-platform builtin cache is missing: $path. Build it manually before running build-builtin-services.ps1."
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

    Write-Host "[build-builtin-services] sync current upstream release packages into $DesktopRoot/build/resources/services"
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

Write-Host "[build-builtin-services] workspace=$WorkspaceRoot desktop=$DesktopRoot target=$SyncOS/$SyncArch"
Assert-AgentPlatformBuiltins
foreach ($repoName in $ServiceRepos) { Invoke-ServiceRelease -RepoName $repoName }
Sync-DesktopAssets
Write-Host "[build-builtin-services] synced 4 builtin service assets"
