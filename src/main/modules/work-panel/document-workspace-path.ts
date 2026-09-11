import path from "node:path";
import { normalizeWorkPanelLocalFileRelativePath, resolveWorkPanelLocalFileFromWorkspace } from "./local-files";

// Markdown links carry absolute paths; native document handles still use workspace-relative identity.
export function normalizeDocumentWorkspaceRequestPath(workspaceDir: string, value: unknown, platform = process.platform) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) return normalizeWorkPanelLocalFileRelativePath(value);
  // Windows requires a drive or UNC share, not a current-drive rooted path.
  if (platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(value)) return "";
  const relativePath = pathApi.relative(workspaceDir, value);
  return normalizeWorkPanelLocalFileRelativePath(relativePath);
}

export function resolveWorkPanelDocumentFromWorkspace(workspaceDir: string, requestedPath: unknown, platform = process.platform) {
  return resolveWorkPanelLocalFileFromWorkspace(
    workspaceDir,
    normalizeDocumentWorkspaceRequestPath(workspaceDir, requestedPath, platform),
    platform,
  );
}
