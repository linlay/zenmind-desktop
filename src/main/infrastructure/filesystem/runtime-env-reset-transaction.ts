import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppPathReader, AppPackageReader, RuntimeEnvResetResult } from "./runtime-env-contracts";
import { resolveRuntimeRoot, resolveDesktopVersion } from "./runtime-env-paths";
import { importBundledEnvZipToRuntime } from "./runtime-env-import";
import { inspectEnvImportTarget } from "./runtime-env-publication";
import { APP_BRAND } from "../../../shared/brand";

type ResetRequest = {
  schemaVersion: 2;
  id: string;
  desktopVersion: string;
  status: "prepared" | "ready" | "applying" | "verifying" | "completed" | "failed" | "rollback-ready";
  step: "desktop" | "backup" | "publish";
  failure?: string;
  result: RuntimeEnvResetResult;
};

function resetPaths(app: AppPathReader, platform: NodeJS.Platform, id?: string) {
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  // Sibling storage survives replacement of the entire runtime and Electron profile.
  const root = `${runtimeRoot}.desktop-reset`;
  inspectEnvImportTarget(root, "request.json", false);
  const transactionRoot = id ? path.join(root, id) : root;
  return { root, runtimeRoot, transactionRoot, requestPath: path.join(root, "request.json"),
    candidate: path.join(transactionRoot, "candidate"), backup: path.join(transactionRoot, "previous-runtime") };
}

function readRequest(app: AppPathReader, platform: NodeJS.Platform): ResetRequest | null {
  const { requestPath } = resetPaths(app, platform);
  let content: string;
  try { content = fs.readFileSync(requestPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: ResetRequest;
  try { value = JSON.parse(content) as ResetRequest; }
  catch { throw new Error(`Invalid runtime reset request; preserved at ${requestPath}`); }
  if (!value || value.schemaVersion !== 2 || typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(value.id) || typeof value.desktopVersion !== "string" ||
      !["prepared", "ready", "applying", "verifying", "completed", "failed", "rollback-ready"].includes(value.status) ||
      !["desktop", "backup", "publish"].includes(value.step) ||
      !value.result || value.result.targetRoot !== resolveRuntimeRoot(app, platform)) {
    throw new Error(`Invalid runtime reset request; preserved at ${requestPath}`);
  }
  return value;
}

function writeRequest(app: AppPathReader, platform: NodeJS.Platform, request: ResetRequest) {
  const { root, requestPath } = resetPaths(app, platform);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = `${requestPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, requestPath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export async function prepareRuntimeEnvReset(app: AppPathReader & AppPackageReader, platform: NodeJS.Platform,
  secureDirectory?: (directory: string) => void) {
  if (platform !== "darwin" && platform !== "win32") throw new Error("Runtime reset requires macOS or Windows.");
  const existing = readRequest(app, platform);
  if (existing) {
    if (existing.status !== "prepared") throw new Error(`Runtime reset requires recovery: ${resetPaths(app, platform).requestPath}`);
    cancelRuntimeEnvReset(app, platform, existing.id);
  }
  const id = randomUUID();
  const paths = resetPaths(app, platform, id);
  fs.mkdirSync(paths.transactionRoot, { recursive: true, mode: 0o700 });
  if (platform === "darwin") fs.chmodSync(paths.root, 0o700);
  // The composition root injects the existing Windows ACL/macOS mode policy
  // before package data or restored credentials are written.
  secureDirectory?.(paths.root);
  secureDirectory?.(paths.transactionRoot);
  try {
    const desktopVersion = resolveDesktopVersion(app);
    const imported = await importBundledEnvZipToRuntime(app, platform, {
      expectedDesktopVersion: desktopVersion, targetRoot: paths.candidate, source: "reset"
    });
    if (!imported) throw new Error("The bundled env.zip required for reset is unavailable.");
    const result = { ...imported, targetRoot: paths.runtimeRoot, backupPath: paths.backup };
    writeRequest(app, platform, { schemaVersion: 2, id, status: "prepared", step: "desktop", desktopVersion, result });
    return { id, result, candidateRoot: paths.candidate, transactionRoot: paths.transactionRoot };
  } catch (error) {
    fs.rmSync(paths.transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

export function armRuntimeEnvReset(app: AppPathReader, platform: NodeJS.Platform, id: string) {
  const request = readRequest(app, platform);
  if (!request || request.id !== id || request.status !== "prepared") throw new Error("Runtime reset preparation is no longer valid.");
  writeRequest(app, platform, { ...request, status: "ready" });
}

export function cancelRuntimeEnvReset(app: AppPathReader, platform: NodeJS.Platform, id: string) {
  const request = readRequest(app, platform);
  if (!request || request.id !== id || !["prepared", "ready"].includes(request.status)) return;
  const paths = resetPaths(app, platform, id);
  inspectEnvImportTarget(paths.root, `${id}/previous-runtime`, true);
  if (fs.existsSync(paths.backup)) throw new Error("Cannot cancel a runtime reset after backup has begun.");
  inspectEnvImportTarget(paths.root, id, true);
  if (!fs.existsSync(path.join(paths.transactionRoot, "platform-error.log"))) {
    fs.rmSync(paths.transactionRoot, { recursive: true, force: true });
  }
  fs.unlinkSync(paths.requestPath);
}

// Restore only Desktop-owned persistent partitions. Service configs, service
// data, caches, Chromium profile and lifecycle markers remain freshly deployed.
function restoreDesktopData(runtimeRoot: string, candidate: string) {
  const desktop = APP_BRAND.paths.desktopDataSubdir;
  const partitions = ["config/desktop", "config/webs", "config/plugins", "config/website-bridges", "secrets",
    "state/desktop/bootstrap.json", "state/desktop/pet-state.json"];
  inspectEnvImportTarget(runtimeRoot, path.join(desktop, "data"), true);
  const dataRoot = path.join(runtimeRoot, desktop, "data");
  if (fs.existsSync(dataRoot)) {
    for (const entry of fs.readdirSync(dataRoot)) {
      if (!["services", "env-initial"].includes(entry)) partitions.push(`data/${entry}`);
    }
  }
  for (const partition of partitions) {
    const relative = path.join(desktop, partition);
    inspectEnvImportTarget(runtimeRoot, path.dirname(relative), true);
    const source = path.join(runtimeRoot, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    inspectEnvImportTarget(runtimeRoot, relative, stat.isDirectory());
    inspectEnvImportTarget(candidate, relative, stat.isDirectory());
    fs.cpSync(source, path.join(candidate, relative), {
      recursive: true, dereference: false, verbatimSymlinks: true, force: true,
      filter: (file) => {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Desktop recovery refuses symbolic link: ${file}`);
        return true;
      }
    });
  }
}

export function getRuntimeEnvResetRecovery(app: AppPathReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (!request || request.status === "prepared" || request.status === "completed") return null;
  const paths = resetPaths(app, platform, request.id);
  return { ...request.result, backupPath: paths.backup, transactionRoot: paths.transactionRoot, status: request.status };
}

export function completeRuntimeEnvReset(app: AppPathReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (!request || request.status !== "verifying") return;
  writeRequest(app, platform, { ...request, status: "completed" });
  fs.unlinkSync(resetPaths(app, platform).requestPath);
}

export function resumeRuntimeEnvReset(app: AppPathReader & AppPackageReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (request?.status === "rollback-ready") return;
  if (!request || !["failed", "applying"].includes(request.status) || request.desktopVersion !== resolveDesktopVersion(app)) {
    throw new Error("This reset cannot be resumed with the current Desktop version.");
  }
  writeRequest(app, platform, { ...request, status: "ready" });
}

export function requestRuntimeEnvRollback(app: AppPathReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (!request || !["failed", "applying", "verifying"].includes(request.status)) throw new Error("No reset is available for rollback.");
  const paths = resetPaths(app, platform, request.id);
  inspectEnvImportTarget(paths.root, `${request.id}/previous-runtime`, true);
  if (!fs.existsSync(paths.backup) && (request.step === "publish" || !fs.existsSync(paths.runtimeRoot))) {
    throw new Error("The original runtime is unavailable for rollback.");
  }
  writeRequest(app, platform, { ...request, status: "rollback-ready" });
}

// Synchronous on purpose: runs before any runtime opens files or Electron becomes ready.
export function consumeRuntimeEnvReset(app: AppPathReader & AppPackageReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (!request || request.status === "prepared") return false;
  const paths = resetPaths(app, platform, request.id);
  if (platform !== "darwin" && platform !== "win32") throw new Error("Runtime reset requires macOS or Windows.");
  inspectEnvImportTarget(paths.root, `${request.id}/candidate`, true);
  inspectEnvImportTarget(paths.root, `${request.id}/previous-runtime`, true);
  inspectEnvImportTarget(paths.runtimeRoot, ".", true);
  if (request.status === "rollback-ready") {
    const failed = path.join(paths.transactionRoot, "failed-runtime");
    inspectEnvImportTarget(paths.root, `${request.id}/failed-runtime`, true);
    if (fs.existsSync(paths.backup)) {
      if (fs.existsSync(paths.runtimeRoot)) {
        if (fs.existsSync(failed)) throw new Error(`Rollback paths conflict: ${paths.transactionRoot}`);
        fs.renameSync(paths.runtimeRoot, failed);
      }
      fs.renameSync(paths.backup, paths.runtimeRoot);
    } else if (!fs.existsSync(paths.runtimeRoot) || (!fs.existsSync(failed) && request.step === "publish")) {
      throw new Error(`Rollback requires recovery: ${paths.transactionRoot}`);
    }
    fs.unlinkSync(paths.requestPath);
    return false;
  }
  if (request.desktopVersion !== resolveDesktopVersion(app)) throw new Error(`Runtime reset version mismatch: ${paths.transactionRoot}`);
  if (request.status === "completed") { fs.unlinkSync(paths.requestPath); return false; }
  if (request.status === "verifying") return true;
  if (request.status !== "ready") throw new Error(`Runtime reset requires recovery: ${paths.transactionRoot}`);
  let next = { ...request, status: "applying" as ResetRequest["status"] };
  writeRequest(app, platform, next);
  try {
    if (next.step === "desktop") {
      if (!fs.existsSync(paths.candidate) || fs.existsSync(paths.backup)) throw new Error("Invalid reset candidate or backup.");
      restoreDesktopData(paths.runtimeRoot, paths.candidate);
      // Same-version data recovery preserves user preferences and deleted Sites;
      // do not replay the package's one-shot first-install defaults afterwards.
      fs.rmSync(path.join(paths.candidate, "desktop-init.json"), { force: true });
      next = { ...next, step: "backup" };
      writeRequest(app, platform, next);
    }
    if (next.step === "backup") {
      // Intent is journaled before rename; an explicit retry can recognize a
      // completed rename without ever replacing an existing original backup.
      if (!fs.existsSync(paths.backup)) fs.renameSync(paths.runtimeRoot, paths.backup);
      else if (fs.existsSync(paths.runtimeRoot)) throw new Error("Both original root and backup exist.");
      next = { ...next, step: "publish" };
      writeRequest(app, platform, next);
    }
    if (fs.existsSync(paths.candidate)) {
      if (fs.existsSync(paths.runtimeRoot)) throw new Error("Cannot publish over an existing runtime.");
      fs.renameSync(paths.candidate, paths.runtimeRoot);
    } else if (!fs.existsSync(paths.runtimeRoot) || !fs.existsSync(paths.backup)) {
      throw new Error("Reset publication is incomplete.");
    }
    writeRequest(app, platform, { ...next, status: "verifying" });
    return true;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try { writeRequest(app, platform, { ...next, status: "failed", failure }); } catch { /* Preserve applying state. */ }
    throw new Error(`Runtime reset failed: ${failure}\nRecovery: ${paths.transactionRoot}`, { cause: error });
  }
}
