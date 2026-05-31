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

function patchShellProgramCommonForLayeredLayout(programDir: string) {
  const scriptPath = path.join(programDir, "scripts", "program-common.sh");
  if (!fs.existsSync(scriptPath)) {
    return;
  }

  let content = fs.readFileSync(scriptPath, "utf8");
  const original = content;
  content = content
    .replace(/ENV_FILE="\$\{ZENMIND_SERVICE_ENV_FILE:-\$BUNDLE_ROOT\/\.env\}"/gu, 'ENV_FILE="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/.env"')
    .replace(/ENV_FILE="\$BUNDLE_ROOT\/\.env"/gu, 'ENV_FILE="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/.env"')
    .replace(/CONFIG_DIR="\$\{ZENMIND_SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs"/gu, 'CONFIG_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs"')
    .replace(/CONFIG_DIR="\$BUNDLE_ROOT\/configs"/gu, 'CONFIG_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs"')
    .replace(/CONFIG_ENV_DIR="\$\{ZENMIND_SERVICE_CONFIG_DIR:-\$BUNDLE_ROOT\}\/configs\/environments"/gu, 'CONFIG_ENV_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs/environments"')
    .replace(/CONFIG_ENV_DIR="\$BUNDLE_ROOT\/configs\/environments"/gu, 'CONFIG_ENV_DIR="${SERVICE_CONFIG_DIR:-$BUNDLE_ROOT}/configs/environments"')
    .replace(/DATA_DIR="\$\{ZENMIND_SERVICE_DATA_DIR:-\$BUNDLE_ROOT\/data\}"/gu, 'DATA_DIR="${SERVICE_DATA_DIR:-$BUNDLE_ROOT/data}"')
    .replace(/DATA_DIR="\$BUNDLE_ROOT\/data"/gu, 'DATA_DIR="${SERVICE_DATA_DIR:-$BUNDLE_ROOT/data}"')
    .replace(/RUN_DIR="\$\{ZENMIND_SERVICE_STATE_DIR:-\$BUNDLE_ROOT\/run\}"/gu, 'RUN_DIR="${SERVICE_STATE_DIR:-$BUNDLE_ROOT/run}"')
    .replace(/RUN_DIR="\$BUNDLE_ROOT\/run"/gu, 'RUN_DIR="${SERVICE_STATE_DIR:-$BUNDLE_ROOT/run}"')
    .replace(/LOG_FILE="\$\{ZENMIND_SERVICE_LOG_DIR:-\$RUN_DIR\}\//gu, 'LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/LOG_FILE="\$RUN_DIR\//gu, 'LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/ERROR_LOG_FILE="\$\{ZENMIND_SERVICE_LOG_DIR:-\$RUN_DIR\}\//gu, 'ERROR_LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/ERROR_LOG_FILE="\$RUN_DIR\//gu, 'ERROR_LOG_FILE="${SERVICE_LOG_DIR:-$RUN_DIR}/')
    .replace(/nohup "\$BACKEND_BIN" >>"\$LOG_FILE" 2>&1 &/gu, 'nohup "$BACKEND_BIN" </dev/null >>"$LOG_FILE" 2>&1 &')
    .replace(/nohup "\$NODE_CMD" "\$BACKEND_ENTRY" >>"\$LOG_FILE" 2>&1 &/gu, 'nohup "$NODE_CMD" "$BACKEND_ENTRY" </dev/null >>"$LOG_FILE" 2>&1 &')
    .replace(
      /cp -R -n "\$source_env_dir"\/\. "\$CONFIG_ENV_DIR"\/\n/gu,
      [
        'local entry',
        '    for entry in "$source_env_dir"/*; do',
        '      [[ -e "$entry" ]] || continue',
        '      local target="$CONFIG_ENV_DIR/$(basename "$entry")"',
        '      if [[ ! -e "$target" ]]; then',
        '        cp -R "$entry" "$target"',
        '      fi',
        '    done',
        ''
      ].join("\n")
    );

  if (content !== original) {
    fs.writeFileSync(scriptPath, content, "utf8");
  }
}

function patchPowerShellProgramCommonForLayeredLayout(programDir: string) {
  const scriptPath = path.join(programDir, "scripts", "program-common.ps1");
  if (!fs.existsSync(scriptPath)) {
    return;
  }

  let content = fs.readFileSync(scriptPath, "utf8");
  const original = content;
  content = content
    .replace(/\$Script:EnvFile\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_ENV_FILE\)\s*\{\s*\$env:ZENMIND_SERVICE_ENV_FILE\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+["']\.env["']\s*\}/gu, '$Script:EnvFile = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) ".env"')
    .replace(/\$Script:EnvFile\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]\.env['"]/gu, '$Script:EnvFile = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) ".env"')
    .replace(/\$Script:ConfigDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]configs['"]/gu, '$Script:ConfigDir = Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) "configs"')
    .replace(/\$Script:ConfigEnvDir\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:BundleRoot\s+['"]configs['"]\)\s+['"]environments['"]/gu, '$Script:ConfigEnvDir = Join-Path (Join-Path $(if ($env:SERVICE_CONFIG_DIR) { $env:SERVICE_CONFIG_DIR } else { $Script:BundleRoot }) "configs") "environments"')
    .replace(/\$Script:DataDir\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_DATA_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_DATA_DIR\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+['"]data['"]\s*\}/gu, '$Script:DataDir = if ($env:SERVICE_DATA_DIR) { $env:SERVICE_DATA_DIR } else { Join-Path $Script:BundleRoot "data" }')
    .replace(/\$Script:DataDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]data['"]/gu, '$Script:DataDir = if ($env:SERVICE_DATA_DIR) { $env:SERVICE_DATA_DIR } else { Join-Path $Script:BundleRoot "data" }')
    .replace(/\$Script:RunDir\s*=\s*if\s*\(\$env:ZENMIND_SERVICE_STATE_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_STATE_DIR\s*\}\s*else\s*\{\s*Join-Path\s+\$Script:BundleRoot\s+['"]run['"]\s*\}/gu, '$Script:RunDir = if ($env:SERVICE_STATE_DIR) { $env:SERVICE_STATE_DIR } else { Join-Path $Script:BundleRoot "run" }')
    .replace(/\$Script:RunDir\s*=\s*Join-Path\s+\$Script:BundleRoot\s+['"]run['"]/gu, '$Script:RunDir = if ($env:SERVICE_STATE_DIR) { $env:SERVICE_STATE_DIR } else { Join-Path $Script:BundleRoot "run" }')
    .replace(/\$Script:LogFile\s*=\s*Join-Path\s+\$\(if\s*\(\$env:ZENMIND_SERVICE_LOG_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_LOG_DIR\s*\}\s*else\s*\{\s*\$Script:RunDir\s*\}\)\s+([^;\r\n]+)/gu, '$Script:LogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:LogFile\s*=\s*Join-Path\s+\$Script:RunDir\s+([^;\r\n]+)/gu, '$Script:LogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:ErrorLogFile\s*=\s*Join-Path\s+\$\(if\s*\(\$env:ZENMIND_SERVICE_LOG_DIR\)\s*\{\s*\$env:ZENMIND_SERVICE_LOG_DIR\s*\}\s*else\s*\{\s*\$Script:RunDir\s*\}\)\s+([^;\r\n]+)/gu, '$Script:ErrorLogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1')
    .replace(/\$Script:ErrorLogFile\s*=\s*Join-Path\s+\$Script:RunDir\s+([^;\r\n]+)/gu, '$Script:ErrorLogFile = Join-Path $(if ($env:SERVICE_LOG_DIR) { $env:SERVICE_LOG_DIR } else { $Script:RunDir }) $1');

  if (content !== original) {
    fs.writeFileSync(scriptPath, content, "utf8");
  }
}

function patchAgentPlatformRuntimeNames(programDir: string) {
  const shellPath = path.join(programDir, "scripts", "program-common.sh");
  if (fs.existsSync(shellPath)) {
    let content = fs.readFileSync(shellPath, "utf8");
    const original = content;
    content = content
      .replace(/LOG_FILE="\$LOG_DIR\/\$APP_NAME\.log"/gu, 'LOG_FILE="$LOG_DIR/agent-platform.log"')
      .replace(/PID_FILE="\$RUN_DIR\/\$APP_NAME\.pid"/gu, 'PID_FILE="$RUN_DIR/agent-platform.pid"');
    if (!content.includes('mkdir -p "$(dirname "$PID_FILE")"')) {
      content = content.replace(
        /program_clear_stale_pid_file "\$PID_FILE" "\$APP_NAME"/gu,
        'mkdir -p "$(dirname "$PID_FILE")"\n  program_clear_stale_pid_file "$PID_FILE" "$APP_NAME"'
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
    content = content
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

export function patchProgramCommonForLayeredLayout(programDir: string) {
  patchShellProgramCommonForLayeredLayout(programDir);
  patchPowerShellProgramCommonForLayeredLayout(programDir);
  const manifestPath = path.join(programDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: string };
    if (manifest.id === "agent-platform") {
      patchAgentPlatformRuntimeNames(programDir);
    }
  } catch {
    // Invalid manifests are reported by the install health checks.
  }
}
