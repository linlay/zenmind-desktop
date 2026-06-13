import process from "node:process";
import { electronBuilderConfigPath, syncBrandArtifacts, resolveBrandId } from "../lib/brand-config.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./spawn.mjs";

const projectRoot = process.cwd();

async function syncWindowsBuiltinAssets(brand) {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"], withBrandEnv(brand, {
    cwd: projectRoot
  }));
}

export async function buildOnWindowsHost(brand = syncBrandArtifacts({ brandId: resolveBrandId() })) {
  const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

  await runAndWait(npmCmd, ["run", "sync:version"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "sync:demo"], brandProcessOptions({ cwd: projectRoot }));
  syncBrandArtifacts({ brandId: brand.id });
  await syncWindowsBuiltinAssets(brand);
  await runAndWait(npmCmd, ["run", "build"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=win32", "--arch=x64"], brandProcessOptions({
    cwd: projectRoot
  }));
  await runAndWait(npmCmd, [
    "exec",
    "electron-builder",
    "--",
    "--config",
    electronBuilderConfigPath(projectRoot, brand.id),
    "--config.win.signAndEditExecutable=false",
    "--win",
    "--x64"
  ], brandProcessOptions({
    cwd: projectRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    }
  }));
  await runAndWait(nodeBin(), ["./scripts/verify-win-package.mjs"], brandProcessOptions({ cwd: projectRoot }));
}

function nodeBin() {
  return process.execPath;
}
