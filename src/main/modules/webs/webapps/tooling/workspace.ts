import fs from "node:fs";
import path from "node:path";
import { WebappToolingError, type WebappToolingStage } from "./errors";

export type ResolvedWorkspacePath = {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
};

export function normalizeWorkspaceRelativePath(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !raw ||
    raw.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    /^[a-z][a-z\d+.-]*:/iu.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    /^[a-z]:[\\/]/iu.test(raw)
  ) {
    return "";
  }
  const segments = raw.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => segment === "..")) return "";
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  return normalized || (segments.every((segment) => !segment || segment === ".") ? "." : "");
}

function isInsideOrEqual(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readWorkspaceRoot(workspaceRoot: unknown, stage: WebappToolingStage) {
  const raw = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!raw || !path.isAbsolute(raw)) {
    throw new WebappToolingError(stage, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
  }
  try {
    const realRoot = fs.realpathSync.native(raw);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error("not a directory");
    return realRoot;
  } catch {
    throw new WebappToolingError(stage, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
  }
}

function requestedCandidate(workspaceRoot: string, requestedPath: unknown, stage: WebappToolingStage) {
  const relativePath = normalizeWorkspaceRelativePath(requestedPath);
  if (!relativePath) {
    throw new WebappToolingError(stage, "invalid_path", "path must be relative to the current Agent workspace.");
  }
  const candidate = relativePath === "."
    ? workspaceRoot
    : path.resolve(workspaceRoot, ...relativePath.split("/"));
  if (!isInsideOrEqual(workspaceRoot, candidate)) {
    throw new WebappToolingError(stage, "path_outside_workspace", "The requested path is outside the Agent workspace.");
  }
  return { candidate, relativePath };
}

export function resolveExistingWorkspacePath(
  workspaceRoot: unknown,
  requestedPath: unknown,
  expectedType: "file" | "directory",
  stage: WebappToolingStage,
): ResolvedWorkspacePath {
  const realRoot = readWorkspaceRoot(workspaceRoot, stage);
  const { candidate, relativePath } = requestedCandidate(realRoot, requestedPath, stage);
  let realPath = "";
  try {
    realPath = fs.realpathSync.native(candidate);
    const stat = fs.statSync(realPath);
    if (expectedType === "file" ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`not a ${expectedType}`);
    }
  } catch {
    throw new WebappToolingError(
      stage,
      expectedType === "file" ? "file_unavailable" : "project_missing",
      expectedType === "file"
        ? "The requested file is unavailable."
        : "The WebApp project directory does not exist.",
      { path: relativePath },
    );
  }
  if (!isInsideOrEqual(realRoot, realPath)) {
    throw new WebappToolingError(stage, "path_outside_workspace", "The requested path is outside the Agent workspace.");
  }
  return { workspaceRoot: realRoot, absolutePath: realPath, relativePath };
}

export function resolveCreatableWorkspacePath(
  workspaceRoot: unknown,
  requestedPath: unknown,
  stage: WebappToolingStage,
): ResolvedWorkspacePath {
  const realRoot = readWorkspaceRoot(workspaceRoot, stage);
  const { candidate, relativePath } = requestedCandidate(realRoot, requestedPath, stage);
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new WebappToolingError(stage, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
    }
    ancestor = parent;
  }
  let realAncestor = "";
  try {
    realAncestor = fs.realpathSync.native(ancestor);
  } catch {
    throw new WebappToolingError(stage, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
  }
  if (!isInsideOrEqual(realRoot, realAncestor)) {
    throw new WebappToolingError(stage, "path_outside_workspace", "The requested path is outside the Agent workspace.");
  }
  if (fs.existsSync(candidate)) {
    const existing = fs.realpathSync.native(candidate);
    if (!isInsideOrEqual(realRoot, existing)) {
      throw new WebappToolingError(stage, "path_outside_workspace", "The requested path is outside the Agent workspace.");
    }
    return { workspaceRoot: realRoot, absolutePath: existing, relativePath };
  }
  return { workspaceRoot: realRoot, absolutePath: candidate, relativePath };
}
