import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const electronBinary = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  isWindows ? "electron.cmd" : "electron"
);

function run(cmd, args, options = {}) {
  return spawn(cmd, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
    shell: isWindows,
    ...options
  });
}

function runAndWait(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = run(cmd, args);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? -1}`));
    });
    child.once("error", reject);
  });
}

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

const syncOs = isWindows ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const syncArch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
await runAndWait(npmCmd, ["run", "sync:assets", "--", `--os=${syncOs}`, `--arch=${syncArch}`]);
await runAndWait(npmCmd, ["run", "build:main"]);

track(run(npmCmd, ["exec", "vite", "--", "--host", "127.0.0.1"]));
await waitForUrl("http://127.0.0.1:5173");

const electron = track(
  spawn(electronBinary, ["."], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: isWindows,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173"
    }
  })
);

electron.once("exit", (code) => shutdown(code ?? 0));
