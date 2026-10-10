import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DesktopActionCallRequest, DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { WEBAPP_ID_PATTERN } from "../../../shared/webapp-manifest";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import { fail, readString } from "./action-values";
import { rejectUnexpectedArgs, trustedWebappWorkspaceSource } from "./webapp-tooling-actions";
import { installFailureDetails, sanitizeWebappDiagnosticValue } from "./webapp-action-results";
import { resolveExistingWorkspacePath, executeWebappToolingInWorker, WebappToolingError } from "../webs";

export type PreparedWebappInstall = {
  archivePath: string;
  publicArchivePath: string;
  workspaceRootToRedact: string;
  expectedId: string;
  label: string;
  version: string;
  sha256: string;
  archiveBytes: number;
};

export function isAbsoluteWebappArchivePath(value: string, platform: NodeJS.Platform) {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value)) return false;
  if (platform === "win32") {
    // Require a drive-qualified local path; UNC, device and drive-relative paths are not local imports.
    return /^[a-z]:[\\/]/iu.test(value) && !value.slice(2).includes(":") &&
      path.win32.isAbsolute(value) && path.win32.extname(value).toLowerCase() === ".zip";
  }
  if (platform === "darwin") {
    return path.posix.isAbsolute(value) && !value.startsWith("//") && path.posix.extname(value).toLowerCase() === ".zip";
  }
  return path.posix.isAbsolute(value) && !value.startsWith("//") && path.posix.extname(value).toLowerCase() === ".zip";
}

function archiveUnavailable(action: string, archivePath: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code || "UNKNOWN";
  return fail(action, "file_unavailable", `The requested WebApp ZIP is unavailable (${code}).`, {
    stage: "archive", executionState: "not_started", path: archivePath,
    category: code === "EACCES" || code === "EPERM" ? "authorization" : code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "validation",
    cause: { code, message: error instanceof Error ? error.message : String(error) },
    recovery: { strategy: "fix_resource", message: "Verify the single ZIP exists and is readable on the Desktop host. Relative paths use the current Run Workspace." },
  });
}

export async function prepareWebappInstall(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; prepared: PreparedWebappInstall } | { ok: false; response: DesktopActionCallResponse }> {
  const action = request.action;
  const reject = (response: DesktopActionCallResponse) => ({ ok: false as const, response });
  if (invocation.kind !== "desktop" && invocation.kind !== "agentPlatform") {
    return reject(fail(action, "forbidden", "WebApp installation requires an authorized Desktop or Agent Platform caller."));
  }
  const invalid = rejectUnexpectedArgs(action, args, ["archivePath", "expectedId"]);
  if (invalid) return reject(fail(action, "invalid_args", invalid.error?.message || "Invalid installation arguments.", { stage: "arguments", executionState: "not_started" }));
  const requestedPath = readString(args, "archivePath");
  if (!requestedPath) return reject(fail(action, "invalid_args", "archivePath is required.", { stage: "arguments", executionState: "not_started" }));
  const hasExpectedId = Object.hasOwn(args, "expectedId");
  const expectedId = typeof args.expectedId === "string" ? args.expectedId : "";
  if (hasExpectedId && !WEBAPP_ID_PATTERN.test(expectedId)) {
    return reject(fail(action, "invalid_args", "expectedId must be the manifest id (webapp- followed by 16 lowercase hex digits), not its key; omit it when unknown.", { stage: "arguments", executionState: "not_started" }));
  }
  if (invocation.kind === "agentPlatform") {
    const source = request.source;
    if (!source?.runId?.trim() || !source.chatId?.trim()) {
      return reject(fail(action, "forbidden", "WebApp installation requires a trusted Agent Platform Run."));
    }
  }
  let archivePath = requestedPath;
  let publicArchivePath = requestedPath;
  let workspaceRootToRedact = "";
  const platform = options.platform ?? process.platform;
  const absolute = isAbsoluteWebappArchivePath(requestedPath, platform);
  if (!absolute) {
    if (invocation.kind !== "agentPlatform" || /^[\\/@]|^[a-z]:/iu.test(requestedPath)) {
      return reject(fail(action, "invalid_path", "archivePath must be a local absolute ZIP path on the Desktop host or a relative ZIP path in the Run Workspace. Platform resolves @chat/@workspace before dispatch.", { stage: "arguments", executionState: "not_started" }));
    }
    const trusted = trustedWebappWorkspaceSource(action, request);
    if (!trusted.ok) return reject(trusted.response);
    workspaceRootToRedact = trusted.workspaceRoot;
    try {
      const resolved = resolveExistingWorkspacePath(trusted.workspaceRoot, requestedPath, "file", "archive");
      archivePath = resolved.absolutePath;
      publicArchivePath = resolved.relativePath;
    } catch (error) {
      if (error instanceof WebappToolingError) {
        return reject(fail(action, error.code, error.message, {
          ...sanitizeWebappDiagnosticValue(error.details) as Record<string, unknown>,
          stage: error.stage, executionState: "not_started",
        }));
      }
      return reject(archiveUnavailable(action, requestedPath, error));
    }
  }
  if (path.extname(archivePath).toLowerCase() !== ".zip") {
    return reject(fail(action, "invalid_args", "archivePath must identify one ZIP file.", { stage: "arguments", executionState: "not_started" }));
  }
  try {
    archivePath = fs.realpathSync.native(archivePath);
    if (!fs.statSync(archivePath).isFile()) throw Object.assign(new Error("The archive is not a regular file."), { code: "WRONG_FILE_TYPE" });
    fs.accessSync(archivePath, fs.constants.R_OK);
  } catch (error) {
    return reject(archiveUnavailable(action, publicArchivePath, error));
  }
  try {
    const result = await executeWebappToolingInWorker({ operation: "install.preflight", archivePath, ...(expectedId ? { expectedId } : {}) }, {
      workerPath: options.webappToolingWorkerPath || path.join(options.app.getAppPath(), "dist-electron", "main", "webapp-tooling-worker.js"),
    });
    if (!result || typeof result.id !== "string" || !WEBAPP_ID_PATTERN.test(result.id) ||
      typeof result.label !== "string" || typeof result.version !== "string" ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256) ||
      typeof result.archiveBytes !== "number" || !Number.isSafeInteger(result.archiveBytes) || result.archiveBytes <= 0) {
      return reject(fail(action, "invalid_action_result", "The Desktop Worker did not return a valid WebApp install preflight result.", {
        stage: "internal", executionState: "not_started",
        recovery: { strategy: "repair_host", message: "Rebuild or repair the Desktop Main and its matching WebApp Tooling Worker together." },
      }));
    }
    return { ok: true, prepared: { archivePath, publicArchivePath, workspaceRootToRedact,
      expectedId: result.id, label: result.label, version: result.version,
      sha256: result.sha256, archiveBytes: result.archiveBytes } };
  } catch (error) {
    if (error instanceof WebappToolingError) {
      if (error.stage === "internal") {
        return reject(fail(action, error.code, error.message, { ...error.details, stage: error.stage, executionState: "not_started" }));
      }
      return reject(fail(action, "webapp_install_failed", error.message, {
        ...installFailureDetails({ archivePath: publicArchivePath, expectedId, diagnostic: {
          stage: error.stage === "arguments" ? "archive" : error.stage,
          code: error.code, message: error.message, details: error.details,
        } }),
        stage: error.stage, executionState: "not_started",
      }));
    }
    return reject(fail(action, "tooling_failed", "Desktop could not complete WebApp installation preflight.", {
      stage: "internal", executionState: "not_started",
      cause: { message: error instanceof Error ? error.message : String(error) },
      recovery: { strategy: "repair_host", message: "Repair the Desktop Main and WebApp Tooling Worker before retrying." },
    }));
  }
}

export async function verifyPreparedWebappArchive(action: string, prepared: PreparedWebappInstall) {
  const changed = () => fail(action, "archive_changed", "The WebApp ZIP changed after preflight; start a new installation request.", {
    stage: "archive", category: "conflict", executionState: "not_started",
    recovery: { strategy: "fix_resource", message: "Retry installation to validate and confirm the current ZIP." },
  });
  try {
    if (fs.statSync(prepared.archivePath).size !== prepared.archiveBytes) return changed();
    const hash = createHash("sha256");
    let bytes = 0;
    // Stream the bounded ZIP so confirming a large package does not block Main or duplicate its bytes in memory.
    for await (const chunk of fs.createReadStream(prepared.archivePath)) {
      bytes += chunk.length;
      if (bytes > prepared.archiveBytes) return changed();
      hash.update(chunk);
    }
    if (hash.digest("hex") !== prepared.sha256) return changed();
    return null;
  } catch (error) {
    return archiveUnavailable(action, prepared.publicArchivePath, error);
  }
}
