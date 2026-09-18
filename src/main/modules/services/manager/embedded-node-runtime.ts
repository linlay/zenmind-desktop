import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { App } from "electron";
import { getDesktopRoot, getDesktopStateRoot } from "../../../infrastructure/filesystem/user-paths";
import { isDesktopDevelopmentRuntime, type DesktopDevelopmentRuntimeContext } from "../../../infrastructure/electron/development-runtime";
import { buildServiceEnv } from "./command-env";

export interface EmbeddedNodeRuntimeOptions {
  stateRoot: string;
  binDir: string;
  resourcesRoot: string;
  executable: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  probe?: (executable: string) => { node: string; arch: string };
}

function quoteShell(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function probeNode(executable: string) {
  const result = spawnSync(executable, ["-p", "JSON.stringify({node:process.versions.node,arch:process.arch})"], {
    encoding: "utf8", timeout: 10000, windowsHide: true
  });
  if (result.error || result.status !== 0) throw new Error("Desktop embedded Node could not start");
  try { return JSON.parse(result.stdout.trim()) as { node: string; arch: string }; }
  catch { throw new Error("Desktop embedded Node mode is unavailable"); }
}

function verifyNode(executable: string, options: EmbeddedNodeRuntimeOptions) {
  const actual = (options.probe ?? probeNode)(executable);
  if (actual.node !== options.nodeVersion || actual.arch !== options.arch) throw new Error("Desktop Node runtime version or architecture mismatch");
}

/** These wrappers set Electron's mode on the Node child only, never on Platform. */
export function embeddedNodeLaunchers(platform: NodeJS.Platform, executable: string, binDir: string) {
  if (platform === "win32") {
    return {
      "npm.cmd": '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\nexit /b %errorlevel%\r\n',
      "npx.cmd": '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npx-cli.js" %*\r\nexit /b %errorlevel%\r\n'
    };
  }
  return {
    node: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(executable)} "$@"\n`,
    npm: `#!/bin/sh\nexec ${quoteShell(path.join(binDir, "node"))} ${quoteShell(path.join(binDir, "node_modules/npm/bin/npm-cli.js"))} "$@"\n`,
    npx: `#!/bin/sh\nexec ${quoteShell(path.join(binDir, "node"))} ${quoteShell(path.join(binDir, "node_modules/npm/bin/npx-cli.js"))} "$@"\n`
  };
}

/** Publish verified commands at a stable Desktop-owned path, retaining replaced files for live processes. */
export function prepareEmbeddedNodeRuntime(options: EmbeddedNodeRuntimeOptions) {
  const { executable, nodeVersion, platform, arch } = options;
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error("Desktop Node executable is unavailable");
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("Desktop Node runtime is unsupported on this platform");
  const npmSource = path.join(options.resourcesRoot, "npm");
  const npmPackage = JSON.parse(fs.readFileSync(path.join(npmSource, "package.json"), "utf8"));
  if (npmPackage.name !== "npm" || typeof npmPackage.version !== "string") throw new Error("Invalid bundled npm runtime");
  for (const name of ["npm-cli.js", "npx-cli.js"]) {
    if (!fs.statSync(path.join(npmSource, "bin", name)).isFile()) throw new Error("Bundled npm entry is missing");
  }
  const launcherArch = arch === "x64" ? "amd64" : arch;
  const nativeLauncher = platform === "win32" ? fs.readFileSync(path.join(options.resourcesRoot, launcherArch, "node.exe")) : null;
  const identity = JSON.stringify({ schema: 1, executable, nodeVersion, platform, arch, npm: npmPackage.version,
    nativeHash: nativeLauncher ? createHash("sha256").update(nativeLauncher).digest("hex") : "" });
  fs.mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(options.stateRoot).isSymbolicLink()) throw new Error("Desktop Node runtime root must be a real directory");
  const binDir = options.binDir;
  if (!path.isAbsolute(binDir)) throw new Error("Desktop Node bin directory must be absolute");
  fs.mkdirSync(path.dirname(binDir), { recursive: true, mode: 0o700 });
  const node = path.join(binDir, platform === "win32" ? "node.exe" : "node");
  const marker = path.join(binDir, "runtime.json");
  const existing = fs.lstatSync(binDir, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Desktop Node bin must be a real directory");
  const reusable = existing && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === identity;
  if (existing && !fs.existsSync(marker)) throw new Error("Desktop Node bin is not managed by Desktop");
  if (!reusable) {
    const stage = fs.mkdtempSync(path.join(options.stateRoot, ".node-stage-"));
    try {
      const bin = path.join(stage, "bin");
      fs.mkdirSync(path.join(bin, "node_modules"), { recursive: true, mode: 0o700 });
      fs.cpSync(npmSource, path.join(bin, "node_modules", "npm"), { recursive: true, dereference: true });
      for (const [name, content] of Object.entries(embeddedNodeLaunchers(platform, executable, binDir))) {
        fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
      }
      if (nativeLauncher) fs.writeFileSync(path.join(bin, "node.exe"), nativeLauncher, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, ".desktop-node-runtime.json"), JSON.stringify({ electronPath: executable }), { mode: 0o600 });
      fs.writeFileSync(path.join(bin, "runtime.json"), identity, { mode: 0o600 });
      verifyNode(path.join(bin, platform === "win32" ? "node.exe" : "node"), options);
      let retired: string | undefined;
      if (existing) {
        retired = fs.mkdtempSync(path.join(options.stateRoot, ".node-retired-"));
        try {
          // Windows may deny a rename while another process holds a file without
          // delete sharing. Never overwrite a loaded node.exe; keep the old bin intact.
          fs.renameSync(binDir, path.join(retired, "bin"));
        } catch (error) {
          fs.rmdirSync(retired);
          if (platform === "win32") throw new Error("Desktop Node runtime is in use; stop its processes and retry", { cause: error });
          throw error;
        }
      }
      try { fs.renameSync(bin, binDir); }
      catch (error) {
        if (retired) fs.renameSync(path.join(retired, "bin"), binDir);
        throw error;
      }
      // Retired files and legacy hashed runtimes stay available to existing children.
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  if (fs.readFileSync(marker, "utf8") !== identity || !fs.lstatSync(node).isFile()
      || !fs.statSync(path.join(binDir, "node_modules/npm/bin/npm-cli.js")).isFile()) {
    throw new Error("Desktop Node runtime is incomplete");
  }
  if (reusable) verifyNode(node, options);
  return { binDir, node, nodeVersion, npmVersion: npmPackage.version };
}

export function embeddedNodeResourcesRoot(app: Pick<App, "isPackaged" | "getAppPath">, context?: DesktopDevelopmentRuntimeContext, packagedRoot = process.resourcesPath) {
  return isDesktopDevelopmentRuntime(app, context)
    ? path.join(app.getAppPath(), "build", "resources", "node-runtime")
    : path.join(packagedRoot, "node-runtime");
}

export function getEmbeddedNodeStartEnv(app: App): NodeJS.ProcessEnv | undefined {
  // Node-based tooling/tests have no embedded Electron runtime to export.
  if (!process.versions.electron) return undefined;
  const resourcesRoot = embeddedNodeResourcesRoot(app);
  const runtime = prepareEmbeddedNodeRuntime({
    stateRoot: path.join(getDesktopStateRoot(app), "node-runtime"), binDir: path.join(getDesktopRoot(app), "bin"), resourcesRoot,
    executable: process.execPath, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch
  });
  const inherited = buildServiceEnv();
  const servicePath = [runtime.binDir, inherited.PATH ?? inherited.Path ?? ""].filter(Boolean).join(path.delimiter);
  return process.platform === "win32" ? { PATH: servicePath, Path: servicePath } : { PATH: servicePath };
}
