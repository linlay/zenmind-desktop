import { spawn } from "node:child_process";

export function spawnElectron(electronBinary, projectRoot) {
  return spawn(`chcp 65001 >NUL && "${electronBinary}" .`, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  });
}
