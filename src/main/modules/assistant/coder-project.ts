export type ProjectCreateType = "general" | "coder" | "kbase" | "acp";

export const PROJECT_CREATE_TYPES: readonly ProjectCreateType[] = ["general", "coder", "kbase", "acp"];

export type ProjectAgentCreateOptions = {
  acpBridgeId?: string;
  modelKey?: string;
  definition?: Record<string, unknown>;
};

const PROJECT_MODES: Record<Exclude<ProjectCreateType, "acp">, string> = {
  general: "GENERAL",
  coder: "CODER",
  kbase: "KBASE"
};

export function buildProjectAgentCreateRequest(
  projectType: ProjectCreateType,
  workspaceDir: string,
  options: ProjectAgentCreateOptions = {}
) {
  const acpBridgeId = String(options.acpBridgeId || "").trim();
  const modelKey = String(options.modelKey || "").trim();
  const runtimeConfig: Record<string, string> = {
    workspaceRoot: workspaceDir
  };
  // A coder project with a bridge is the external engine; older callers
  // express it that way instead of the explicit "acp" type.
  const useAcp = projectType === "acp" || (projectType === "coder" && Boolean(acpBridgeId));
  if (useAcp && acpBridgeId) {
    runtimeConfig.acpBridgeId = acpBridgeId;
  }

  const definition: Record<string, unknown> = useAcp
    // Platform never infers the engine from acpBridgeId; it must be explicit.
    // The external engine has no mode of its own; CODER is kept for clarity.
    ? { mode: "CODER", engine: "acp", runtimeConfig }
    : { ...options.definition, mode: PROJECT_MODES[projectType as Exclude<ProjectCreateType, "acp">], runtimeConfig };
  if (modelKey && !useAcp) {
    definition.modelConfig = { modelKey };
  }

  return { definition };
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { acpBridgeId?: string } = {}
) {
  return buildProjectAgentCreateRequest("coder", workspaceDir, options);
}
