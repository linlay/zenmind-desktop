import http from "node:http";
import path from "node:path";
import process from "node:process";
import {
  buildElectronSpawnErrorMessage,
  resolveValidatedElectronBinaryPath
} from "./lib/electron-installation.mjs";
import {
  assertBrandArtifactsConsistent,
  loadBrandConfig,
  removeStaleRendererBuild,
  resolveBrandId
} from "./lib/brand-config.mjs";
import { createDevShutdownCoordinator } from "./platform/dev-process-cleanup.mjs";
import { hostArch, hostPlatform, isWindows, syncOsLabel } from "./platform/detect.mjs";
import { npmCmd, run, runAndWait, withBrandEnv } from "./platform/spawn.mjs";

const projectRoot = process.cwd();
const brand = loadBrandConfig(projectRoot, resolveBrandId());
process.env.BRAND = brand.id;
const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

// 把当前 Node 的目录顶到 PATH 最前，并显式声明 NODE_BIN，
// 让 Electron 子进程里的 service-manager 不用再去 `where node` 摸路径
const nodeBin = process.execPath;
const nodeDir = path.dirname(nodeBin);
process.env.PATH = `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.DESKTOP_NODE_BIN = nodeBin;

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

function track(name, child) {
  children.push({ name, child });
  return child;
}

const shutdown = createDevShutdownCoordinator({ records: children });

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

async function startDev() {
  await runAndWait(npmCmd, ["run", "brand:prepare"], brandProcessOptions({ cwd: projectRoot }));
  if (removeStaleRendererBuild({ rootDir: projectRoot, brand })) {
    console.warn(`[dev] removed stale renderer output for BRAND=${brand.id}; Vite dev server will serve fresh assets.`);
  }
  assertBrandArtifactsConsistent({ rootDir: projectRoot, brand });
  const electronBinary = resolveValidatedElectronBinaryPath();

  const syncOs = syncOsLabel();
  const syncArch = hostArch();
  try {
    await runAndWait("node", [
      "./scripts/sync-builtin-assets.mjs",
      "--use-existing",
      `--os=${syncOs}`,
      `--arch=${syncArch}`
    ], brandProcessOptions({
      cwd: projectRoot
    }));
  } catch (error) {
    throw new Error(
      `[dev] builtin asset sync failed; dev startup requires a complete core builtin asset set.\n` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Keep dev bundled env resources explicit. Without ENV_ZIP this clears stale env.zip.
  await runAndWait("node", ["./scripts/sync-env-zip.mjs"], brandProcessOptions({ cwd: projectRoot }));
  await runAndWait(npmCmd, ["run", "build:main:prepared"], brandProcessOptions({ cwd: projectRoot }));

  track(
    "vite",
    run(npmCmd, ["exec", "vite", "--", "--host", "127.0.0.1"], brandProcessOptions({ cwd: projectRoot }))
  );
  await waitForUrl("http://127.0.0.1:5173");

  const platform = hostPlatform();
  const { spawnElectron } = isWindows()
    ? await import("./platform/dev-windows.mjs")
    : platform === "darwin"
      ? await import("./platform/dev-darwin.mjs")
      : await import("./platform/dev-unix.mjs");
  const electron = track("electron", spawnElectron(electronBinary, projectRoot, brand));

  electron.once("error", (error) => {
    console.error(
      buildElectronSpawnErrorMessage({
        electronBinaryPath: electronBinary,
        error
      })
    );
    void shutdown(1);
  });

  electron.once("exit", (code) => {
    void shutdown(code ?? 0);
  });
}

try {
  await startDev();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
