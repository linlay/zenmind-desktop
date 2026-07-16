import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import {
  buildElectronSpawnErrorMessage,
  resolveValidatedElectronBinaryPath
} from "./lib/electron-installation.mjs";
import {
  assertBrandArtifactsConsistent,
  removeStaleRendererBuild,
  syncBrandArtifacts,
  resolveBrandId
} from "./lib/brand-config.mjs";
import { hostArch, hostPlatform, isWindows, syncOsLabel } from "./platform/detect.mjs";
import { npmCmd, run, runAndWait, withBrandEnv } from "./platform/spawn.mjs";

const projectRoot = process.cwd();
const brand = syncBrandArtifacts({ brandId: resolveBrandId() });
process.env.BRAND = brand.id;
const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);
await runAndWait("node", ["./scripts/generate-app-icons.mjs"], brandProcessOptions({ cwd: projectRoot }));
if (removeStaleRendererBuild({ rootDir: projectRoot, brand })) {
  console.warn(`[dev] removed stale renderer output for BRAND=${brand.id}; Vite dev server will serve fresh assets.`);
}
assertBrandArtifactsConsistent({ rootDir: projectRoot, brand });
const electronBinary = resolveValidatedElectronBinaryPath();

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
  await runAndWait("node", [
    "./scripts/sync-builtin-assets.mjs",
    "--use-existing",
    `--os=${syncOs}`,
    `--arch=${syncArch}`
  ], brandProcessOptions({
    cwd: projectRoot
  }));
} catch (error) {
  console.error(
    `[dev] builtin asset sync failed; dev startup requires a complete core builtin asset set.\n` +
      `${error instanceof Error ? error.message : String(error)}`
  );
  shutdown(1);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveDevServerPort() {
  const configuredPort = Number.parseInt(process.env.DESKTOP_DEV_SERVER_PORT ?? "5173", 10);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new Error("DESKTOP_DEV_SERVER_PORT must be a valid TCP port");
  }
  for (let port = configuredPort; port < Math.min(configuredPort + 20, 65536); port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }
  throw new Error(`unable to find an available dev server port from ${configuredPort}`);
}
// Keep dev bundled env resources explicit. Without ENV_ZIP this clears stale env.zip.
await runAndWait("node", ["./scripts/sync-env-zip.mjs"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "build:main"], brandProcessOptions({ cwd: projectRoot }));

const devServerPort = await resolveDevServerPort();
const devServerUrl = `http://127.0.0.1:${devServerPort}`;
process.env.VITE_DEV_SERVER_URL = devServerUrl;
track(run(npmCmd, [
  "exec",
  "vite",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  String(devServerPort),
  "--strictPort"
], brandProcessOptions({ cwd: projectRoot })));
await waitForUrl(devServerUrl);

const platform = hostPlatform();
const { spawnElectron } = isWindows()
  ? await import("./platform/dev-windows.mjs")
  : platform === "darwin"
    ? await import("./platform/dev-darwin.mjs")
    : await import("./platform/dev-unix.mjs");
const electron = track(spawnElectron(electronBinary, projectRoot, brand));

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
