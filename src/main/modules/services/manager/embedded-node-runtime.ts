import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
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
  probe?: (executable: string) => { node: string; arch: string } | Promise<{ node: string; arch: string }>;
}

function quoteShell(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

const execFileAsync = promisify(execFile);

/** macOS Node children must not inherit the main app's foreground Dock identity. */
export async function embeddedNodeExecutable(executable: string, platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") return executable;
  if (platform !== "darwin") return executable;
  const contents = path.dirname(path.dirname(executable));
  if (path.basename(path.dirname(executable)) !== "MacOS" || path.basename(contents) !== "Contents") {
    throw new Error("Desktop embedded Node requires a macOS Electron app bundle");
  }
  const frameworks = path.join(contents, "Frameworks");
  // Branded dev shells rename only the main executable; their helper keeps the
  // Electron name. Select the generic helper, excluding Renderer/GPU variants.
  const helpers = (await fs.promises.readdir(frameworks, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith(" Helper.app"));
  if (helpers.length !== 1) throw new Error("Desktop embedded Node requires one generic Electron Helper");
  const helperContents = path.join(frameworks, helpers[0].name, "Contents");
  const result = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(helperContents, "Info.plist")], {
    encoding: "utf8", timeout: 10000
  });
  const info = JSON.parse(result.stdout);
  const name = info.CFBundleExecutable;
  if (info.LSUIElement !== true || typeof name !== "string" || !name || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error("Desktop embedded Node requires an LSUIElement Electron Helper executable");
  }
  const helper = path.join(helperContents, "MacOS", name);
  await fs.promises.access(helper, fs.constants.X_OK);
  return helper;
}

async function probeNode(executable: string) {
  const result = await execFileAsync(executable, ["-p", "JSON.stringify({node:process.versions.node,arch:process.arch})"], {
    encoding: "utf8", timeout: 10000, windowsHide: true
  });
  try { return JSON.parse(result.stdout.trim()) as { node: string; arch: string }; }
  catch { throw new Error("Desktop embedded Node mode is unavailable"); }
}

async function verifyNode(executable: string, options: EmbeddedNodeRuntimeOptions) {
  const actual = await (options.probe ?? probeNode)(executable);
  if (actual.node !== options.nodeVersion || actual.arch !== options.arch) throw new Error("Desktop Node runtime version or architecture mismatch");
}

async function retryFileOperation<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Antivirus and recently exited children can transiently retain Windows
      // handles. Never busy-wait on Electron's main thread or retry bad paths.
      if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= 4) throw error;
      await delay(40 * 2 ** attempt);
    }
  }
}

const preparations = new Map<string, Promise<EmbeddedNodeRuntime>>();
interface EmbeddedNodeRuntime { binDir: string; node: string; nodeVersion: string; npmVersion: string; }

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
export function prepareEmbeddedNodeRuntime(options: EmbeddedNodeRuntimeOptions): Promise<EmbeddedNodeRuntime> {
  const resolved = path.resolve(options.binDir);
  const key = options.platform === "win32" ? resolved.toLowerCase() : resolved;
  const active = preparations.get(key);
  if (active) return active;
  const task = prepareRuntime(options).finally(() => { preparations.delete(key); });
  preparations.set(key, task);
  return task;
}

async function prepareRuntime(options: EmbeddedNodeRuntimeOptions): Promise<EmbeddedNodeRuntime> {
  const { executable, nodeVersion, platform, arch } = options;
  const io = fs.promises;
  const retry = <T>(operation: () => Promise<T>) => retryFileOperation(platform, operation);
  if (!path.isAbsolute(executable) || !(await io.stat(executable)).isFile()) throw new Error("Desktop Node executable is unavailable");
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error("Desktop Node runtime is unsupported on this platform");
  const npmSource = path.join(options.resourcesRoot, "npm");
  const npmPackage = JSON.parse(await io.readFile(path.join(npmSource, "package.json"), "utf8"));
  if (npmPackage.name !== "npm" || typeof npmPackage.version !== "string") throw new Error("Invalid bundled npm runtime");
  for (const name of ["npm-cli.js", "npx-cli.js"]) {
    if (!(await io.stat(path.join(npmSource, "bin", name))).isFile()) throw new Error("Bundled npm entry is missing");
  }
  const launcherArch = arch === "x64" ? "amd64" : arch;
  const nativeLauncher = platform === "win32" ? await io.readFile(path.join(options.resourcesRoot, launcherArch, "node.exe")) : null;
  const identity = JSON.stringify({ schema: 1, executable, nodeVersion, platform, arch, npm: npmPackage.version,
    nativeHash: nativeLauncher ? createHash("sha256").update(nativeLauncher).digest("hex") : "" });
  await io.mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  if ((await io.lstat(options.stateRoot)).isSymbolicLink()) throw new Error("Desktop Node runtime root must be a real directory");
  const binDir = options.binDir;
  if (!path.isAbsolute(binDir)) throw new Error("Desktop Node bin directory must be absolute");
  await io.mkdir(path.dirname(binDir), { recursive: true, mode: 0o700 });
  const node = path.join(binDir, platform === "win32" ? "node.exe" : "node");
  const marker = path.join(binDir, "runtime.json");
  const existing = await io.lstat(binDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Desktop Node bin must be a real directory");
  const oldIdentity = existing ? await io.readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Desktop Node bin is not managed by Desktop");
    throw error;
  }) : undefined;
  const complete = async () => {
    const commands = Object.keys(embeddedNodeLaunchers(platform, executable, binDir)).map(name => path.join(binDir, name));
    for (const file of [node, ...commands, path.join(binDir, ".desktop-node-runtime.json"),
      path.join(binDir, "node_modules/npm/bin/npm-cli.js"), path.join(binDir, "node_modules/npm/bin/npx-cli.js")]) {
      try { if (!(await io.stat(file)).isFile()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    return true;
  };
  const reusable = oldIdentity === identity && await complete();
  if (!reusable) {
    const stage = await io.mkdtemp(path.join(options.stateRoot, ".node-stage-"));
    let failure: unknown;
    let phase = "npm copy";
    try {
      const bin = path.join(stage, "bin");
      await io.mkdir(path.join(bin, "node_modules"), { recursive: true, mode: 0o700 });
      await retry(() => io.cp(npmSource, path.join(bin, "node_modules", "npm"), { recursive: true, dereference: true }));
      phase = "launcher preparation";
      for (const [name, content] of Object.entries(embeddedNodeLaunchers(platform, executable, binDir))) {
        await io.writeFile(path.join(bin, name), content, { mode: 0o755 });
      }
      if (nativeLauncher) await io.writeFile(path.join(bin, "node.exe"), nativeLauncher, { mode: 0o755 });
      await io.writeFile(path.join(bin, ".desktop-node-runtime.json"), JSON.stringify({ electronPath: executable }), { mode: 0o600 });
      await io.writeFile(path.join(bin, "runtime.json"), identity, { mode: 0o600 });
      phase = "runtime verification";
      await verifyNode(path.join(bin, platform === "win32" ? "node.exe" : "node"), options);
      let retired: string | undefined;
      phase = "previous runtime retirement";
      if (existing) {
        retired = await io.mkdtemp(path.join(options.stateRoot, ".node-retired-"));
        try { await retry(() => io.rename(binDir, path.join(retired!, "bin"))); }
        catch (error) {
          // Cleanup must never mask the original locked-directory error.
          await io.rmdir(retired).catch(() => {});
          if (platform === "win32") throw new Error("Desktop Node runtime is in use; stop its processes and retry", { cause: error });
          throw error;
        }
      }
      phase = "runtime publication";
      try { await retry(() => io.rename(bin, binDir)); }
      catch (error) {
        if (retired) {
          try { await retry(() => io.rename(path.join(retired!, "bin"), binDir)); }
          catch (restoreError) {
            throw new AggregateError([error, restoreError], `Runtime publication and rollback failed; previous runtime retained at ${retired}`, { cause: error });
          }
        }
        throw error;
      }
      // Retired files stay available to existing children; never delete them here.
    } catch (error) {
      failure = new Error(`Desktop Node runtime preparation failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    try { await retry(() => io.rm(stage, { recursive: true, force: true })); }
    catch (cleanupError) {
      if (failure) {
        failure = new AggregateError([failure, cleanupError], `${(failure as Error).message}; staging cleanup failed at ${stage}`, { cause: failure });
      } else {
        // Publication already succeeded. An unused staging directory cannot make
        // the valid runtime unavailable; retain it for later diagnosis.
        console.warn(`[embedded-node] staging cleanup failed at ${stage}`, cleanupError);
      }
    }
    if (failure) throw failure;
  }
  if (await io.readFile(marker, "utf8") !== identity || !await complete()) throw new Error("Desktop Node runtime is incomplete");
  if (reusable) await verifyNode(node, options);
  return { binDir, node, nodeVersion, npmVersion: npmPackage.version };
}

export function embeddedNodeResourcesRoot(app: Pick<App, "isPackaged" | "getAppPath">, context?: DesktopDevelopmentRuntimeContext, packagedRoot = process.resourcesPath) {
  return isDesktopDevelopmentRuntime(app, context)
    ? path.join(app.getAppPath(), "build", "resources", "node-runtime")
    : path.join(packagedRoot, "node-runtime");
}

// Desktop's executable, data root and bundled resources are fixed for this
// process. Keep a successful preparation for its lifetime; failures are retryable.
const appPreparations = new WeakMap<App, Promise<void>>();
const appRuntimes = new WeakMap<App, EmbeddedNodeRuntime>();

export function ensureEmbeddedNodeRuntime(app: App): Promise<void> {
  if (!process.versions.electron) return Promise.resolve();
  const pending = appPreparations.get(app);
  if (pending) return pending;
  const task = embeddedNodeExecutable(process.execPath, process.platform).then(executable => prepareEmbeddedNodeRuntime({
    stateRoot: path.join(getDesktopStateRoot(app), "node-runtime"), binDir: path.join(getDesktopRoot(app), "bin"),
    resourcesRoot: embeddedNodeResourcesRoot(app), executable,
    nodeVersion: process.versions.node, platform: process.platform, arch: process.arch
  })).then(runtime => { appRuntimes.set(app, runtime); }).catch(error => {
    appPreparations.delete(app);
    throw error;
  });
  appPreparations.set(app, task);
  return task;
}

/** Command assembly never copies files, probes Node, or starts preparation. */
export function getPreparedEmbeddedNodeStartEnv(app: App): NodeJS.ProcessEnv | undefined {
  if (!process.versions.electron) return undefined;
  const runtime = appRuntimes.get(app);
  if (!runtime) throw new Error("Desktop Node/npm runtime has not been prepared");
  const inherited = buildServiceEnv();
  const servicePath = [runtime.binDir, inherited.PATH ?? inherited.Path ?? ""].filter(Boolean).join(path.delimiter);
  return process.platform === "win32" ? { PATH: servicePath, Path: servicePath } : { PATH: servicePath };
}
