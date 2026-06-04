import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { electronBuilderConfigPath, syncBrandArtifacts, resolveBrandId } from "../lib/brand-config.mjs";
import { npmCmd, runAndWait } from "./spawn.mjs";

const projectRoot = process.cwd();

function getElectronBuilderCacheDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "electron-builder");
  }
  if (process.platform === "linux") {
    return process.env.XDG_CACHE_HOME != null
      ? path.join(process.env.XDG_CACHE_HOME, "electron-builder")
      : path.join(os.homedir(), ".cache", "electron-builder");
  }
  return null;
}

async function syncWindowsBuiltinAssets() {
  await runAndWait(npmCmd, ["run", "sync:assets", "--", "--os=windows", "--arch=amd64"], {
    cwd: projectRoot
  });
}

export async function buildWithDocker(brand = syncBrandArtifacts({ brandId: resolveBrandId() })) {
  await runAndWait(npmCmd, ["run", "sync:version"], { cwd: projectRoot });
  await runAndWait(npmCmd, ["run", "sync:env"], { cwd: projectRoot });
  syncBrandArtifacts({ brandId: brand.id });
  await syncWindowsBuiltinAssets();
  await runAndWait(npmCmd, ["run", "build"], { cwd: projectRoot });

  const npmCacheDir = path.join(os.homedir(), ".npm");
  const electronBuilderCacheDir = getElectronBuilderCacheDir();

  fs.mkdirSync(npmCacheDir, { recursive: true });
  if (electronBuilderCacheDir != null) {
    fs.mkdirSync(electronBuilderCacheDir, { recursive: true });
  }

  const dockerArgs = [
    "run",
    "--rm",
    "--volume",
    `${projectRoot}:/project`,
    "--volume",
    `${brand.packageName}-node-modules:/project/node_modules`,
    "--volume",
    `${npmCacheDir}:/root/.npm`
  ];

  if (electronBuilderCacheDir != null) {
    dockerArgs.push("--volume", `${electronBuilderCacheDir}:/root/.cache/electron-builder`);
  }

  dockerArgs.push(
    "--workdir",
    "/project",
    "electronuserland/builder:wine",
    "/bin/bash",
    "-lc",
    [
      "npm install --no-package-lock --ignore-scripts",
      `node ./scripts/sync-brand.mjs --brand=${brand.id}`,
      "node ./scripts/stage-app.mjs --os=win32 --arch=x64",
      `npx electron-builder --config ${path.posix.relative("/project", electronBuilderConfigPath("/project", brand.id))} --win --x64`,
      "node ./scripts/verify-win-package.mjs"
    ].join(" && ")
  );

  await runAndWait("docker", dockerArgs, { cwd: projectRoot, shell: false });
}
