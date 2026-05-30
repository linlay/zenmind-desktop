import http from "node:http";
import path from "node:path";
import process from "node:process";
import {
  buildElectronSpawnErrorMessage,
  resolveValidatedElectronBinaryPath
} from "./lib/electron-installation.mjs";
import { hostArch, hostPlatform, isWindows, syncOsLabel } from "./platform/detect.mjs";
import { npmCmd, run, runAndWait } from "./platform/spawn.mjs";

const projectRoot = process.cwd();
const electronBinary = resolveValidatedElectronBinaryPath();

// 把当前 Node 的目录顶到 PATH 最前，并显式声明 NODE_BIN，
// 让 Electron 子进程里的 service-manager 不用再去 `where node` 摸路径
const nodeBin = process.execPath;
const nodeDir = path.dirname(nodeBin);
process.env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.ZENMIND_NODE_BIN = nodeBin;

function waitForUrl(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(undefined);
      });
      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${url}`));
          return;
        }
        setTimeout(tryConnect, 400);
      });
    };
    tryConnect();
  });
}

const children = [];

function track(child) {
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const syncOs = syncOsLabel();
const syncArch = hostArch();
try {
  await runAndWait("node", ["./scripts/sync-builtin-assets.mjs", `--os=${syncOs}`, `--arch=${syncArch}`], {
    cwd: projectRoot
  });
} catch (error) {
  console.error(
    `[dev] builtin asset sync failed; dev startup requires a complete core builtin asset set.\n` +
      `${error instanceof Error ? error.message : String(error)}`
  );
  shutdown(1);
}
await runAndWait(npmCmd, ["run", "build:main"], { cwd: projectRoot });

track(run(npmCmd, ["exec", "vite", "--", "--host", "127.0.0.1"], { cwd: projectRoot }));
await waitForUrl("http://127.0.0.1:5173");

const platform = hostPlatform();
const { spawnElectron } = isWindows()
  ? await import("./platform/dev-windows.mjs")
  : platform === "darwin"
    ? await import("./platform/dev-darwin.mjs")
    : await import("./platform/dev-unix.mjs");
const electron = track(spawnElectron(electronBinary, projectRoot));

electron.once("error", (error) => {
  console.error(
    buildElectronSpawnErrorMessage({
      electronBinaryPath: electronBinary,
      error
    })
  );
  shutdown(1);
});

electron.once("exit", (code) => shutdown(code ?? 0));
