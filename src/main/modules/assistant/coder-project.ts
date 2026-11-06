export type ProjectCreateType = "general" | "coder" | "kbase" | "acp";

export const PROJECT_CREATE_TYPES: readonly ProjectCreateType[] = ["general", "coder", "kbase", "acp"];

export type ProjectAgentCreateOptions = {
  engineId?: string;
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
  const engineId = String(options.engineId || "").trim();
  const modelKey = String(options.modelKey || "").trim();
  const runtimeConfig: Record<string, string> = {
    workspaceRoot: workspaceDir
  };
  if ("acpBridgeId" in options) throw new Error("acpBridgeId was removed; use engineId with projectType acp");
  const useAcp = projectType === "acp";
  if (!useAcp && engineId) throw new Error("engineId requires projectType acp");
  if (useAcp) runtimeConfig.engineId = engineId;
  const definition: Record<string, unknown> = useAcp
    ? { engine: "acp", runtimeConfig }
    : { ...options.definition, mode: PROJECT_MODES[projectType as Exclude<ProjectCreateType, "acp">], runtimeConfig };
  if (modelKey && !useAcp) {
    definition.modelConfig = { modelKey };
  }

  return { isProject: true, definition };
}

export function buildCoderProjectAgentCreateRequest(
  workspaceDir: string,
  options: { engineId?: string } = {}
) {
  return buildProjectAgentCreateRequest("coder", workspaceDir, options);
}
