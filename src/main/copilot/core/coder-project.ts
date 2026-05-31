export function workspaceNameFromPath(workspaceDir: string): string {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
}

export function buildCoderProjectAgentCreateRequest(workspaceDir: string) {
  return {
    definition: {
      name: workspaceNameFromPath(workspaceDir),
      mode: "CODER",
      icon: {
        name: "folder"
      },
      workspace: {
        root: workspaceDir
      },
      runtimeConfig: {
        workspaceRoot: workspaceDir
      },
      visibility: {
        scopes: ["nav", "copilot"]
      }
    }
  };
}
