import fs from "node:fs";
import path from "node:path";
import type { ServiceDefinition } from "../../manifest-utils";

export function agentWebclientInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");
  let backendEntry = "backend/server.cjs";
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        backend?: { entry?: unknown } | null;
        runtime?: { requiredPaths?: unknown } | null;
      };
      if (typeof manifest.backend?.entry === "string" && manifest.backend.entry.trim()) {
        backendEntry = manifest.backend.entry.trim();
      }
      const requiredPaths = Array.isArray(manifest.runtime?.requiredPaths)
        ? manifest.runtime.requiredPaths.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (
        backendEntry === "backend/server.js" ||
        requiredPaths.includes("backend/package.json") ||
        requiredPaths.includes("backend/node_modules")
      ) {
        return true;
      }
    }

    const staleUnixLauncherMarkers = ["BACKEND_PACKAGE_FILE", "BACKEND_NODE_MODULES_DIR", "backend/package.json", "backend/node_modules"];
    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      const hasInvalidAbsoluteBackendEntry = /BACKEND_ENTRY=["']\/backend\/server\.cjs["']/u.test(programCommon);
      if (hasInvalidAbsoluteBackendEntry || staleUnixLauncherMarkers.some((marker) => programCommon.includes(marker))) {
        return true;
      }
    }

    const staleWindowsLauncherMarkers = ["BackendPackageFile", "BackendModulesDir", "backend\\package.json", "backend\\node_modules"];
    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      const hasInvalidAbsoluteBackendEntry = /\$Script:BackendEntry\s*=\s*["']\\?backend\\server\.cjs["']/u.test(programCommon);
      if (hasInvalidAbsoluteBackendEntry || staleWindowsLauncherMarkers.some((marker) => programCommon.includes(marker))) {
        return true;
      }
    }
  } catch {
    return true;
  }

  const serverPath = fs.existsSync(path.join(installDir, backendEntry))
    ? path.join(installDir, backendEntry)
    : path.join(installDir, "backend", "server.js");
  if (!fs.existsSync(serverPath)) {
    return false;
  }

  try {
    const serverContent = fs.readFileSync(serverPath, "utf8");
    return (
      serverContent.includes("(secure ? https : http).request") ||
      serverContent.includes("function buildUpgradeRequest(") ||
      !serverContent.includes("function createWebSocketProxy(") ||
      !serverContent.includes("proxy.upgrade(req, socket, head)") ||
      !serverContent.includes("server.on('upgrade'")
    );
  } catch {
    return true;
  }
}

export function zenmindAppServerInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const indexPath = path.join(installDir, "frontend", "dist", "index.html");
  const envExamplePath = path.join(installDir, ".env.example");
  const envPath = path.join(installDir, ".env");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");

  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        frontend?: { entry?: unknown } | null;
        web?: { routePath?: unknown } | null;
      };
      if (manifest.frontend?.entry !== "/admin/" || manifest.web?.routePath !== "/admin/") {
        return true;
      }
    }

    if (fs.existsSync(envExamplePath)) {
      const envExample = fs.readFileSync(envExamplePath, "utf8");
      if (!envExample.includes("FRONTEND_DIST_DIR=./frontend/dist")) {
        return true;
      }
    }

    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf8");
      if (!/(^|\n)FRONTEND_DIST_DIR=.+(\n|$)/u.test(envContent)) {
        return true;
      }
    }

    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      if (
        !programCommon.includes('FRONTEND_DIST_DIR="${FRONTEND_DIST_DIR:-./frontend/dist}"') ||
        !programCommon.includes('nohup "$BACKEND_BIN"')
      ) {
        return true;
      }
    }

    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      if (
        !programCommon.includes("Resolve-ProgramFrontendDistDir") ||
        !programCommon.includes("$env:FRONTEND_DIST_DIR")
      ) {
        return true;
      }
    }

    if (!fs.existsSync(indexPath)) {
      return false;
    }

    const indexContent = fs.readFileSync(indexPath, "utf8");
    return !indexContent.includes("/admin/assets/");
  } catch {
    return true;
  }
}

export function agentPlatformInstallNeedsRefresh(installDir: string) {
  const manifestPath = path.join(installDir, "manifest.json");
  const programCommonShPath = path.join(installDir, "scripts", "program-common.sh");
  const programCommonPs1Path = path.join(installDir, "scripts", "program-common.ps1");

  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        configFiles?: Array<{ key?: unknown; relativePath?: unknown; templateRelativePath?: unknown }> | null;
        runtime?: { pidRelativePath?: unknown; logRelativePath?: unknown } | null;
      };
      if (
        manifest.runtime?.pidRelativePath !== "run/agent-platform.pid" ||
        manifest.runtime?.logRelativePath !== "run/agent-platform.log"
      ) {
        return true;
      }
      const configKeys = new Set(
        Array.isArray(manifest.configFiles)
          ? manifest.configFiles.map((entry) => entry?.key).filter((key): key is string => typeof key === "string")
          : []
      );
      const requiredConfigKeys = [
        "env",
        "runtime",
        "host-tools",
        "ai-tools",
        "channels",
        "coder-settings",
        "local-public-key",
        "prompts"
      ];
      if (requiredConfigKeys.some((key) => !configKeys.has(key))) {
        return true;
      }
    }

    if (fs.existsSync(programCommonShPath)) {
      const programCommon = fs.readFileSync(programCommonShPath, "utf8");
      const declaresPidFile = /(^|\n)\s*PID_FILE=/u.test(programCommon);
      const hasDesktopPidFile =
        programCommon.includes('PID_FILE="$RUN_DIR/agent-platform.pid"') ||
        programCommon.includes('PID_FILE="$RUN_DIR/pid/agent-platform.pid"');
      if (
        programCommon.includes('PID_FILE="$RUN_DIR/$APP_NAME.pid"') ||
        programCommon.includes('LOG_FILE="$LOG_DIR/$APP_NAME.log"') ||
        (declaresPidFile && !hasDesktopPidFile)
      ) {
        return true;
      }
    }

    if (fs.existsSync(programCommonPs1Path)) {
      const programCommon = fs.readFileSync(programCommonPs1Path, "utf8");
      const declaresPidFile = /(^|\r?\n)\s*\$Script:PidFile\s*=/u.test(programCommon);
      const hasDesktopPidFile =
        /\$Script:PidFile\s*=\s*Join-Path\s+\$Script:RunDir\s+['"]agent-platform\.pid['"]/u.test(programCommon) ||
        /\$Script:PidFile\s*=\s*Join-Path\s+\(Join-Path\s+\$Script:RunDir\s+['"]pid['"]\)\s+['"]agent-platform\.pid['"]/u.test(programCommon);
      if (
        programCommon.includes('$Script:PidFile = Join-Path $Script:RunDir "$Script:AppName.pid"') ||
        programCommon.includes('$Script:LogFile = Join-Path $Script:LogDir "$Script:AppName.log"') ||
        (declaresPidFile && !hasDesktopPidFile)
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

export function serviceInstallNeedsRefresh(service: ServiceDefinition, installDir: string) {
  if (service.id === "agent-platform") {
    return agentPlatformInstallNeedsRefresh(installDir);
  }

  if (service.id === "agent-webclient") {
    return agentWebclientInstallNeedsRefresh(installDir);
  }

  if (service.id === "zenmind-app-server") {
    return zenmindAppServerInstallNeedsRefresh(installDir);
  }

  return false;
}
