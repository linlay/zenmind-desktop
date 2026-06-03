import process from "node:process";
import { electronBuilderConfigPath, syncBrandArtifacts, resolveBrandId } from "../lib/brand-config.mjs";
import { npmCmd, runAndWait } from "./spawn.mjs";

const projectRoot = process.cwd();

async function syncWindowsBuiltinAssets() {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"], {
    cwd: projectRoot
  });
}

export async function buildOnWindowsHost(brand = syncBrandArtifacts({ brandId: resolveBrandId() })) {
  await runAndWait(npmCmd, ["run", "sync:version"], { cwd: projectRoot });
  syncBrandArtifacts({ brandId: brand.id });
  await syncWindowsBuiltinAssets();
  await runAndWait(npmCmd, ["run", "build"], { cwd: projectRoot });
  await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=win32", "--arch=x64"], {
    cwd: projectRoot
  });
  await runAndWait(npmCmd, [
    "exec",
    "electron-builder",
    "--",
    "--config",
    electronBuilderConfigPath(projectRoot, brand.id),
    "--win",
    "--x64"
  ], {
    cwd: projectRoot
  });
  await runAndWait(nodeBin(), ["./scripts/verify-win-package.mjs"], { cwd: projectRoot });
}

function nodeBin() {
  return process.execPath;
}
