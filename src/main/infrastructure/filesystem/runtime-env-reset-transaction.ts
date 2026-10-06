import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppPathReader, AppPackageReader, RuntimeEnvResetResult } from "./runtime-env-contracts";
import { resolveRuntimeRoot, resolveDesktopVersion } from "./runtime-env-paths";
import { importBundledEnvZipToRuntime } from "./runtime-env-import";
import { inspectEnvImportTarget } from "./runtime-env-publication";

type ResetRequest = {
  schemaVersion: 1;
  id: string;
  desktopVersion: string;
  status: "prepared" | "ready" | "applying" | "completed" | "failed";
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
  if (!value || value.schemaVersion !== 1 || typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(value.id) || typeof value.desktopVersion !== "string" ||
      !["prepared", "ready", "applying", "completed", "failed"].includes(value.status) ||
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

export async function prepareRuntimeEnvReset(app: AppPathReader & AppPackageReader, platform: NodeJS.Platform) {
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
  // Windows inherits the user's directory ACL; POSIX mode bits do not set an ACL.
  try {
    const desktopVersion = resolveDesktopVersion(app);
    const imported = await importBundledEnvZipToRuntime(app, platform, {
      expectedDesktopVersion: desktopVersion, targetRoot: paths.candidate, source: "reset"
    });
    if (!imported) throw new Error("The bundled env.zip required for reset is unavailable.");
    const result = { ...imported, targetRoot: paths.runtimeRoot, backupPath: paths.backup };
    writeRequest(app, platform, { schemaVersion: 1, id, status: "prepared", desktopVersion, result });
    return { id, result };
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
  fs.rmSync(paths.transactionRoot, { recursive: true, force: true });
  fs.unlinkSync(paths.requestPath);
}

function preserveAdditionalAgents(runtimeRoot: string, candidate: string, platform: NodeJS.Platform) {
  inspectEnvImportTarget(runtimeRoot, "agents", true);
  inspectEnvImportTarget(candidate, "agents", true);
  const source = path.join(runtimeRoot, "agents");
  const target = path.join(candidate, "agents");
  if (!fs.existsSync(source)) return;
  const bundledNames = fs.existsSync(target) ? fs.readdirSync(target) : [];
  // Windows names are case-insensitive. On macOS, existsSync follows the volume's
  // actual case rules (both case-sensitive and case-insensitive volumes exist).
  const windowsNames = platform === "win32" ? new Set(bundledNames.map((name) => name.toLowerCase())) : null;
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const destination = path.join(target, name);
    if (windowsNames?.has(name.toLowerCase()) || fs.existsSync(destination)) continue;
    // Copy opaque user resources only after services have stopped. Do not parse
    // Agent YAML or follow links into external workspaces.
    fs.cpSync(path.join(source, name), destination, {
      recursive: true, dereference: false, verbatimSymlinks: true,
      force: false, errorOnExist: true, preserveTimestamps: true
    });
  }
}

// Synchronous on purpose: runs before any runtime opens files or Electron becomes ready.
export function consumeRuntimeEnvReset(app: AppPathReader & AppPackageReader, platform: NodeJS.Platform) {
  const request = readRequest(app, platform);
  if (!request || request.status === "prepared") return false;
  const paths = resetPaths(app, platform, request.id);
  if (request.status === "completed" && request.desktopVersion === resolveDesktopVersion(app)) {
    fs.unlinkSync(paths.requestPath);
    return true;
  }
  if (request.status !== "ready" || request.desktopVersion !== resolveDesktopVersion(app)) {
    throw new Error(`Runtime reset requires recovery. Request: ${paths.requestPath}; backup: ${paths.backup}`);
  }
  if (platform !== "darwin" && platform !== "win32") throw new Error("Runtime reset requires macOS or Windows.");
  inspectEnvImportTarget(paths.root, `${request.id}/candidate`, true);
  inspectEnvImportTarget(paths.root, `${request.id}/previous-runtime`, true);
  inspectEnvImportTarget(paths.runtimeRoot, ".", true);
  if (!fs.existsSync(paths.candidate) || fs.existsSync(paths.backup)) throw new Error(`Runtime reset paths require recovery: ${paths.transactionRoot}`);
  writeRequest(app, platform, { ...request, status: "applying" });
  try {
    preserveAdditionalAgents(paths.runtimeRoot, paths.candidate, platform);
    if (fs.existsSync(paths.runtimeRoot)) fs.renameSync(paths.runtimeRoot, paths.backup);
    // Both platforms use same-volume rename. In particular, Windows sharing errors
    // must abort here; never copy over a locked profile or delete the old environment.
    fs.renameSync(paths.candidate, paths.runtimeRoot);
    writeRequest(app, platform, { ...request, status: "completed" });
    fs.unlinkSync(paths.requestPath);
    return true;
  } catch (error) {
    try { writeRequest(app, platform, { ...request, status: "failed" }); } catch { /* Preserve applying state. */ }
    throw new Error(`Runtime reset failed. Preserve ${paths.transactionRoot} for recovery.`, { cause: error });
  }
}
