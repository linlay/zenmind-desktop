export type ProjectCreateType = "coder" | "kbase";

export function buildProjectAgentCreateRequest(
  projectType: ProjectCreateType,
  workspaceDir: string,
  options: { acpProxyId?: string } = {}
) {
  const mode = projectType === "kbase" ? "KBASE" : "CODER";
  const acpProxyId = String(options.acpProxyId || "").trim();
  const runtimeConfig: Record<string, string> = {
    workspaceRoot: workspaceDir
  };
  if (projectType === "coder" && acpProxyId) {
    runtimeConfig.acpProxyId = acpProxyId;
  }

  return {
    definition: {
      mode,
      runtimeConfig
    }
  };
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { acpProxyId?: string } = {}
) {
  return buildProjectAgentCreateRequest("coder", workspaceDir, options);
}
