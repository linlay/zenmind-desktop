export function getAssistantWorkspaceName(
  workspaceDir: string | undefined,
  workspaceDirExists: boolean | undefined,
) {
  const trimmed = workspaceDir?.trim() ?? "";
  if (!trimmed || trimmed === "@chat" || workspaceDirExists === false) {
    return "";
  }

  const normalized = trimmed.replace(/[\\/]+$/u, "");
  if (!normalized || /^[A-Za-z]:$/u.test(normalized)) {
    return "";
  }

  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}
