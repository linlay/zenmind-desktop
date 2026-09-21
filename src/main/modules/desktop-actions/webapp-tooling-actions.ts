import { type DesktopActionCallRequest, type DesktopActionCallResponse, type DesktopWebappToolingResult } from "../../../shared/desktop-actions";
import { fail, readString, ok } from "./action-values";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { normalizeWorkspaceRelativePath, type WebappToolingTask, executeWebappToolingInWorker, WebappToolingError } from "../webs";
import path from "node:path";
import { sanitizeWebappDiagnosticValue, sanitizeWebappErrorText } from "./webapp-action-results";

export function trustedWebappWorkspaceSource(
  action: string,
  request: DesktopActionCallRequest,
): { ok: true; workspaceRoot: string } | { ok: false; response: DesktopActionCallResponse } {
  const source = request.source;
  const runId = typeof source?.runId === "string" ? source.runId.trim() : "";
  const chatId = typeof source?.chatId === "string" ? source.chatId.trim() : "";
  const workspaceRoot = typeof source?.workspaceRoot === "string" ? source.workspaceRoot.trim() : "";
  if (!runId || !chatId || Boolean(source?.agentKey && source?.teamId)) {
    return {
      ok: false,
      response: fail(action, "forbidden", "This action requires a trusted Agent Platform Run workspace."),
    };
  }
  if (!workspaceRoot) {
    return {
      ok: false,
      response: fail(action, "workspace_unavailable", "This Run has no project Workspace bound for WebApp files.", {
        stage: "arguments", category: "unavailable", executionState: "not_started",
        recovery: { strategy: "user_action", message: "Bind a project Workspace for the Agent and continue in a Run using that Workspace. A Chat resource directory is not automatically the project Workspace." },
      }),
    };
  }
  return { ok: true, workspaceRoot };
}

export function rejectUnexpectedArgs(
  action: string,
  args: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const allowed = new Set(allowedKeys);
  const rejected = Object.keys(args).filter((key) => !allowed.has(key));
  return rejected.length > 0
    ? fail(action, "invalid_args", `${action} does not accept: ${rejected.join(", ")}.`)
    : null;
}

export async function executeWebappToolingAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const trusted = trustedWebappWorkspaceSource(action, request);
  if (!trusted.ok) return trusted.response;

  for (const field of ["projectPath", "archivePath", "outputPath"]) {
    if (Object.hasOwn(args, field) && !normalizeWorkspaceRelativePath(args[field])) {
      return fail(action, "invalid_path", `${field} must be relative to the current Run workspace.`, {
        stage: "arguments", category: "validation", executionState: "not_started",
        issues: [{ path: `args.${field}`, code: "invalid_path", expected: "workspace-relative path without URI or parent traversal", actual: typeof args[field] }],
        recovery: { strategy: "fix_input", message: `Use a relative ${field} in the current Run workspace. Do not pass an absolute host path.` },
      });
    }
  }

  let task: WebappToolingTask;
  if (action === "desktop.webapp.package.init") {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "key", "label", "target"]);
    if (invalid) return invalid;
    const projectPath = readString(args, "projectPath");
    const key = readString(args, "key");
    const label = readString(args, "label");
    if (!projectPath || !key || !label || (args.target !== undefined && typeof args.target !== "string")) {
      return fail(action, "invalid_args", "projectPath, key, and label are required; target must be a string when provided.");
    }
    task = {
      operation: "package.init",
      workspaceRoot: trusted.workspaceRoot,
      projectPath,
      key,
      label,
      ...(readString(args, "target") ? { target: readString(args, "target") } : {}),
    };
  } else if (action === "desktop.webapp.package.validate") {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "archivePath"]);
    if (invalid) return invalid;
    const hasProjectPath = Object.hasOwn(args, "projectPath");
    const hasArchivePath = Object.hasOwn(args, "archivePath");
    if (hasProjectPath === hasArchivePath) {
      return fail(action, "invalid_args", "Provide exactly one of projectPath or archivePath.");
    }
    const projectPath = readString(args, "projectPath");
    const archivePath = readString(args, "archivePath");
    if ((hasProjectPath && !projectPath) || (hasArchivePath && !archivePath)) {
      return fail(action, "invalid_args", "The selected projectPath or archivePath must be a non-empty string.");
    }
    task = projectPath
      ? { operation: "package.validate", workspaceRoot: trusted.workspaceRoot, projectPath }
      : { operation: "package.validate", workspaceRoot: trusted.workspaceRoot, archivePath };
  } else {
    const invalid = rejectUnexpectedArgs(action, args, ["projectPath", "outputPath"]);
    if (invalid) return invalid;
    const projectPath = readString(args, "projectPath");
    const outputPath = readString(args, "outputPath");
    if (!projectPath || !outputPath) {
      return fail(action, "invalid_args", "projectPath and outputPath are required.");
    }
    task = { operation: "package.build", workspaceRoot: trusted.workspaceRoot, projectPath, outputPath };
  }

  try {
    const result = await executeWebappToolingInWorker(task, {
      // Dev and packaged Main have different module layouts. Resolve from the
      // application root, never from the directory of an imported module.
      workerPath: options.webappToolingWorkerPath || path.join(options.app.getAppPath(), "dist-electron", "main", "webapp-tooling-worker.js"),
    });
    return ok(action, result as DesktopWebappToolingResult);
  } catch (error) {
    if (error instanceof WebappToolingError) {
      const details = sanitizeWebappDiagnosticValue(error.details, "", 0, trusted.workspaceRoot) as Record<string, unknown>;
      return fail(action, error.code, sanitizeWebappErrorText(error.message, trusted.workspaceRoot), {
        stage: error.stage,
        ...details,
      });
    }
    return fail(action, "tooling_failed", "Desktop WebApp Tooling failed.", { stage: "internal" });
  }
}
