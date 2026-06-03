export function workspaceNameFromPath(workspaceDir: string): string {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { acpProxyId?: string } = {}
) {
  const acpProxyId = String(options.acpProxyId || "").trim();
  const runtimeConfig: Record<string, string> = {
    workspaceRoot: workspaceDir
  };
  if (acpProxyId) {
    runtimeConfig.coderBackend = "acp";
    runtimeConfig.acpProxyId = acpProxyId;
  }

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
      runtimeConfig,
      visibility: {
        scopes: ["nav", "copilot"]
      }
    }
  };
}
