import fs from "node:fs";
import path from "node:path";

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

function patchAgentPlatformPublicKeyDeployFlag(content: string) {
  return content
    .replace(/--local-public-key-file/gu, "--public-key-source-file")
    .replace(/DEPLOY_LOCAL_PUBLIC_KEY_FILE/gu, "DEPLOY_PUBLIC_KEY_SOURCE_FILE")
    .replace(/DeployLocalPublicKeyFile/gu, "DeployPublicKeySourceFile");
}

function patchAgentPlatformRuntimeNames(programDir: string) {
  const shellPath = path.join(programDir, "scripts", "program-common.sh");
  if (fs.existsSync(shellPath)) {
    let content = fs.readFileSync(shellPath, "utf8");
    const original = content;
    content = patchAgentPlatformPublicKeyDeployFlag(content)
      .replace(/LOG_FILE="\$LOG_DIR\/\$APP_NAME\.log"/gu, 'LOG_FILE="$LOG_DIR/agent-platform.log"')
      .replace(/PID_FILE="\$RUN_DIR\/\$APP_NAME\.pid"/gu, 'PID_FILE="$RUN_DIR/agent-platform.pid"')
      .replace(/(\n\s*else\n\s*)return(\n\s*fi\n\n\s*timeout_ms=)/u, "$1return 0$2");
    if (!content.includes('mkdir -p "$(dirname "$PID_FILE")"')) {
      content = content.replace(
        /program_clear_stale_pid_file "\$PID_FILE" "\$APP_NAME"/gu,
        'mkdir -p "$(dirname "$PID_FILE")"\n  program_clear_stale_pid_file "$PID_FILE" "$APP_NAME"'
      );
    }
    if (!content.includes("program_resolve_runtime_root()")) {
      const runtimeRootHelper = [
        "program_expand_runtime_path() {",
        '  local value="$1"',
        '  if [[ "$value" == "~" ]]; then',
        '    printf \'%s\\n\' "${HOME:-$BUNDLE_ROOT}"',
        "    return",
        "  fi",
        '  if [[ "$value" == "~/"* ]]; then',
        '    printf \'%s/%s\\n\' "${HOME:-$BUNDLE_ROOT}" "${value:2}"',
        "    return",
        "  fi",
        '  if [[ "$value" == /* ]]; then',
        '    printf \'%s\\n\' "$value"',
        "    return",
        "  fi",
        '  printf \'%s\\n\' "$BUNDLE_ROOT/$value"',
        "}",
        "",
        "program_resolve_runtime_root() {",
        '  if [[ -n "${RUNTIME_DIR:-}" ]]; then',
        '    RUNTIME_ROOT="$(program_expand_runtime_path "$RUNTIME_DIR")"',
        "  fi",
        "}"
      ].join("\n");
      content = content.replace(
        /\nprogram_prepare_runtime_dirs\(\) \{/u,
        `\n${runtimeRootHelper}\n\nprogram_prepare_runtime_dirs() {`
      );
    }
    if (
      content.includes("program_prepare_runtime_dirs() {") &&
      !/program_prepare_runtime_dirs\(\) \{\n\s*program_resolve_runtime_root/u.test(content)
    ) {
      content = content.replace(
        /program_prepare_runtime_dirs\(\) \{\n/u,
        "program_prepare_runtime_dirs() {\n  program_resolve_runtime_root\n"
      );
    }
    if (content !== original) {
      fs.writeFileSync(shellPath, content, "utf8");
    }
  }

  const powerShellPath = path.join(programDir, "scripts", "program-common.ps1");
  if (fs.existsSync(powerShellPath)) {
    let content = fs.readFileSync(powerShellPath, "utf8");
    const original = content;
    content = patchAgentPlatformPublicKeyDeployFlag(content)
      .replace(
        /\$Script:LogFile\s*=\s*Join-Path\s+\$Script:LogDir\s+["']\$Script:AppName\.log["']/gu,
        '$Script:LogFile = Join-Path $Script:LogDir "agent-platform.log"'
      )
      .replace(
        /\$Script:PidFile\s*=\s*Join-Path\s+\$Script:RunDir\s+["']\$Script:AppName\.pid["']/gu,
        '$Script:PidFile = Join-Path $Script:RunDir "agent-platform.pid"'
      );
    if (!content.includes('Split-Path -Parent $Script:PidFile')) {
      content = content.replace(
        /Clear-StalePidFile\s+-PidFile\s+\$Script:PidFile\s+-ProcessName\s+\$Script:AppName/gu,
        'New-Item -ItemType Directory -Path (Split-Path -Parent $Script:PidFile) -Force | Out-Null\r\n  Clear-StalePidFile -PidFile $Script:PidFile -ProcessName $Script:AppName'
      );
    }
    if (!content.includes("function Resolve-ProgramRuntimeRoot")) {
      const runtimeRootHelper = [
        "function Resolve-ProgramRuntimePath {",
        "  param([string]$Value)",
        "  $trimmed = $Value.Trim()",
        "  if ($trimmed -eq '~') { return $HOME }",
        "  if ($trimmed.StartsWith('~/') -or $trimmed.StartsWith('~\\')) {",
        "    $relative = $trimmed.Substring(2)",
        "    return (Join-Path $HOME $relative)",
        "  }",
        "  if ([System.IO.Path]::IsPathRooted($trimmed)) { return $trimmed }",
        "  return (Join-Path $Script:BundleRoot $trimmed)",
        "}",
        "",
        "function Resolve-ProgramRuntimeRoot {",
        "  if ($env:RUNTIME_DIR) {",
        "    $Script:RuntimeRoot = Resolve-ProgramRuntimePath $env:RUNTIME_DIR",
        "  }",
        "}"
      ].join("\r\n");
      content = content.replace(
        /\r?\nfunction Initialize-ProgramRuntime\s*\{/u,
        `\r\n${runtimeRootHelper}\r\n\r\nfunction Initialize-ProgramRuntime {`
      );
    }
    if (
      /function Initialize-ProgramRuntime\s*\{/u.test(content) &&
      !/function Initialize-ProgramRuntime\s*\{\r?\n\s*Resolve-ProgramRuntimeRoot/u.test(content)
    ) {
      content = content.replace(
        /function Initialize-ProgramRuntime\s*\{\r?\n/u,
        "function Initialize-ProgramRuntime {\r\n  Resolve-ProgramRuntimeRoot\r\n"
      );
    }
    if (content !== original) {
      fs.writeFileSync(powerShellPath, content, "utf8");
    }
  }

  const manifestPath = path.join(programDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        runtime?: { pidRelativePath?: string; logRelativePath?: string };
      };
      manifest.runtime = {
        ...(manifest.runtime ?? {}),
        pidRelativePath: "run/agent-platform.pid",
        logRelativePath: "run/agent-platform.log"
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } catch {
      // Leave invalid manifests to the normal health checks.
    }
  }
}

function replaceScriptLines(content: string, searchLines: string[], replacementLines: string[]) {
  const lfSearch = searchLines.join("\n");
  if (content.includes(lfSearch)) {
    return content.replace(lfSearch, replacementLines.join("\n"));
  }

  const crlfSearch = searchLines.join("\r\n");
  return content.replace(crlfSearch, replacementLines.join("\r\n"));
}

function patchAgentPlatformDeployDiagnostics(programDir: string) {
  const shellPath = path.join(programDir, "deploy.sh");
  if (fs.existsSync(shellPath)) {
    let content = fs.readFileSync(shellPath, "utf8");
    const original = content;
    content = replaceScriptLines(
      content,
      [
        'cd "$SCRIPT_DIR"',
        "program_validate_bundle",
        "program_initialize_config",
        "program_load_env",
        "program_prepare_runtime_dirs",
        "",
        'echo "[program-deploy] bundle validated"',
        'echo "[program-deploy] backend binary: $BACKEND_BIN"',
        'echo "[program-deploy] runtime directories prepared under $RUNTIME_ROOT and $RUN_DIR"'
      ],
      [
        'cd "$SCRIPT_DIR"',
        'echo "[program-deploy] validating bundle"',
        "program_validate_bundle",
        'echo "[program-deploy] bundle validated"',
        'echo "[program-deploy] backend binary: $BACKEND_BIN"',
        'echo "[program-deploy] initializing config under $CONFIG_DIR"',
        "program_initialize_config",
        'echo "[program-deploy] config initialized: $CONFIG_DIR"',
        'echo "[program-deploy] loading env: $ENV_FILE"',
        "program_load_env",
        'echo "[program-deploy] env loaded"',
        'echo "[program-deploy] preparing runtime dirs under $RUNTIME_ROOT and $RUN_DIR"',
        "program_prepare_runtime_dirs",
        'echo "[program-deploy] runtime directories prepared under $RUNTIME_ROOT and $RUN_DIR"',
        'echo "[program-deploy] deploy complete"'
      ]
    );
    if (content !== original) {
      fs.writeFileSync(shellPath, content, "utf8");
    }
  }

  const powerShellPath = path.join(programDir, "deploy.ps1");
  if (fs.existsSync(powerShellPath)) {
    let content = fs.readFileSync(powerShellPath, "utf8");
    const original = content;
    content = replaceScriptLines(
      content,
      [
        "Set-Location $ScriptDir",
        "Test-ProgramBundle",
        "Initialize-ProgramConfig",
        "Import-ProgramEnv",
        "Initialize-ProgramRuntime",
        "",
        "Write-Host '[program-deploy] bundle validated'",
        'Write-Host ("[program-deploy] backend binary: {0}" -f $Script:BackendBin)',
        'Write-Host ("[program-deploy] runtime directories prepared under {0} and {1}" -f $Script:RuntimeRoot, $Script:RunDir)'
      ],
      [
        "Set-Location $ScriptDir",
        "Write-Host '[program-deploy] validating bundle'",
        "Test-ProgramBundle",
        "Write-Host '[program-deploy] bundle validated'",
        'Write-Host ("[program-deploy] backend binary: {0}" -f $Script:BackendBin)',
        'Write-Host ("[program-deploy] initializing config under {0}" -f $Script:ConfigDir)',
        "Initialize-ProgramConfig",
        'Write-Host ("[program-deploy] config initialized: {0}" -f $Script:ConfigDir)',
        'Write-Host ("[program-deploy] loading env: {0}" -f $Script:EnvFile)',
        "Import-ProgramEnv",
        "Write-Host '[program-deploy] env loaded'",
        'Write-Host ("[program-deploy] preparing runtime dirs under {0} and {1}" -f $Script:RuntimeRoot, $Script:RunDir)',
        "Initialize-ProgramRuntime",
        'Write-Host ("[program-deploy] runtime directories prepared under {0} and {1}" -f $Script:RuntimeRoot, $Script:RunDir)',
        "Write-Host '[program-deploy] deploy complete'"
      ]
    );
    if (content !== original) {
      fs.writeFileSync(powerShellPath, content, "utf8");
    }
  }
}

export function patchProgramCommonForLayeredLayout(programDir: string) {
  const manifestPath = path.join(programDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: string };
    if (manifest.id === "agent-platform") {
      patchAgentPlatformRuntimeNames(programDir);
      patchAgentPlatformDeployDiagnostics(programDir);
    }
  } catch {
    // Invalid manifests are reported by the install health checks.
  }
}
