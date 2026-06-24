const LEGACY_PAN_WEBCLIENT_PROJECT_NAME_PREFIX = "pan-webclient";
const AGENT_WEBCLIENT_PROJECT_NAME_PREFIX = "agent-webclient";

export function workspaceNameFromPath(workspaceDir: string): string {
  const normalized = String(workspaceDir || "").trim();
  return normalized.split(/[\\/]+/).filter(Boolean).pop() || "project";
}

export function normalizeCoderProjectName(name: string): string {
  const normalized = String(name || "").trim();
  if (normalized.startsWith(LEGACY_PAN_WEBCLIENT_PROJECT_NAME_PREFIX)) {
    return `${AGENT_WEBCLIENT_PROJECT_NAME_PREFIX}${normalized.slice(LEGACY_PAN_WEBCLIENT_PROJECT_NAME_PREFIX.length)}`;
  }
  return normalized;
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { name?: string; acpProxyId?: string } = {}
) {
  const requestedName = String(options.name || "").trim();
  const name = normalizeCoderProjectName(requestedName || workspaceNameFromPath(workspaceDir));
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
