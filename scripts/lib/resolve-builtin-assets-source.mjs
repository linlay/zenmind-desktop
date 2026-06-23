import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BUILTIN_ASSETS_SOURCE_ENV = "DESKTOP_BUILTIN_ASSETS_SOURCE";
const LEGACY_BUILTIN_ASSETS_SOURCE_ENV = "ZENMIND_BUILTIN_ASSETS_SOURCE";

function readConfiguredSource() {
  return (
    process.env[BUILTIN_ASSETS_SOURCE_ENV] ??
    process.env[LEGACY_BUILTIN_ASSETS_SOURCE_ENV]
  )?.trim() || "";
}

export function resolveBuiltinAssetsSource(projectRoot = process.cwd()) {
  const configured = readConfiguredSource();
  if (configured) {
    return configured;
  }

  const workspaceRoot = path.resolve(projectRoot, "..");
  const prepareScript = path.join(workspaceRoot, "scripts", "prepare-desktop-builtin-assets.sh");
  if (!fs.existsSync(prepareScript)) {
    return "";
  }

  const staging = execFileSync("bash", [prepareScript], {
    cwd: workspaceRoot,
    encoding: "utf8"
  }).trim();

  if (staging) {
    process.env[BUILTIN_ASSETS_SOURCE_ENV] = staging;
  }

  return staging;
}
