import { spawn } from "node:child_process";
import { desktopBuiltinServicesDir } from "../lib/desktop-resources.mjs";

export function spawnElectron(electronBinary, projectRoot, brand) {
  const serviceAssetsRoot = desktopBuiltinServicesDir(projectRoot);
  return spawn(electronBinary, ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
      ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT: serviceAssetsRoot,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
