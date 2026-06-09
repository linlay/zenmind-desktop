export function workspaceNameFromPath(workspaceDir: string): string {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { name?: string; acpProxyId?: string } = {}
) {
  const name = String(options.name || "").trim() || workspaceNameFromPath(workspaceDir);
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
      name,
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
