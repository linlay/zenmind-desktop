import { spawn } from "node:child_process";
import path from "node:path";
import { brandResourcesDir } from "../lib/brand-config.mjs";

export function spawnElectron(electronBinary, projectRoot, brand) {
  const serviceAssetsRoot = path.join(brandResourcesDir(projectRoot, brand), "services");
  return spawn(`chcp 65001 >NUL && "${electronBinary}" .`, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
      ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
