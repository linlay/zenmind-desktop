import { selectedCreationDefinition } from "./creation-profile";
import type {
  AssistantCreateProjectRequest,
  AssistantCreateProjectType,
  AssistantProjectCreationGroup,
  AssistantProjectCreationOptions,
  AssistantProjectCreationType,
} from "./contracts";

/**
 * Selection rules of the New Project dialog. They are kept free of UI state so
 * Desktop applies the brand profile defaults on every type switch.
 */

export type ProjectCreationSelection = {
  typeKey: AssistantCreateProjectType;
  groups: string[];
  /** True once the user changed the groups by hand. */
  groupsTouched: boolean;
  /** Model picked by hand; empty means "use the type's default". */
  modelKey: string;
  engineId: string;
};

export type ProjectCreationProblem =
  | "typeUnavailable"
  | "directoryRequired"
  | "modelRequired"
  | "engineRequired"
  | "engineUnavailable";

export function findProjectCreationType(
  options: AssistantProjectCreationOptions,
  typeKey: string,
): AssistantProjectCreationType | undefined {
  return options.types.find((item) => item.key === typeKey);
}

export function selectableProjectCreationGroups(
  options: AssistantProjectCreationOptions,
  typeKey: string,
): AssistantProjectCreationGroup[] {
  const type = findProjectCreationType(options, typeKey);
  if (!type?.supportsGroups) {
    return [];
  }
  return options.groups.filter((group) => group.available);
}

function defaultGroups(options: AssistantProjectCreationOptions, typeKey: string): string[] {
  const type = findProjectCreationType(options, typeKey);
  if (!type?.supportsGroups) {
    return [];
  }
  const selectable = new Set(selectableProjectCreationGroups(options, typeKey).map((group) => group.key));
  return type.defaultGroups.filter((key) => selectable.has(key));
}

export function initialProjectCreationSelection(
  options: AssistantProjectCreationOptions,
): ProjectCreationSelection {
  const type = options.types.find((item) => item.available) ?? options.types[0];
  const typeKey = (type?.key ?? "general") as AssistantCreateProjectType;
  return {
    typeKey,
    groups: defaultGroups(options, typeKey),
    groupsTouched: false,
    modelKey: "",
    engineId: type?.engineDirectory?.engines.find(engine => engine.enabled && engine.syncState === "applied" && engine.dependencyState === "ready")?.engineId ?? "",
  };
}

/** Every type switch reapplies its capability and model defaults. */
export function changeProjectCreationType(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
  typeKey: AssistantCreateProjectType,
): ProjectCreationSelection {
  const type = findProjectCreationType(options, typeKey);
  const engines = type?.engineDirectory?.engines ?? [];
  return {
    ...selection,
    typeKey,
    groups: defaultGroups(options, typeKey),
    groupsTouched: false,
    modelKey: "",
    engineId: selection.engineId || engines.find(engine => engine.enabled && engine.syncState === "applied" && engine.dependencyState === "ready")?.engineId || "",
  };
}

export function toggleProjectCreationGroup(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
  groupKey: string,
): ProjectCreationSelection {
  if (!selectableProjectCreationGroups(options, selection.typeKey).some((group) => group.key === groupKey)) {
    return selection;
  }
  const groups = selection.groups.includes(groupKey)
    ? selection.groups.filter((key) => key !== groupKey)
    : [...selection.groups, groupKey];
  // Keep the configured display order regardless of click order.
  const order = options.groups.map((group) => group.key);
  groups.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  return { ...selection, groups, groupsTouched: true };
}

/**
 * The model that will be used: the hand-picked one, else the type default when
 * Agent Platform reports it as available. An unavailable default is never
 * replaced by an arbitrary model; the user must choose.
 */
export function resolveProjectCreationModel(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
): string {
  const type = findProjectCreationType(options, selection.typeKey);
  if (!type?.modelRequired) {
    return "";
  }
  if (selection.modelKey && options.models.some((model) => model.key === selection.modelKey)) {
    return selection.modelKey;
  }
  return type.defaultModelAvailable && type.defaultModelKey ? type.defaultModelKey : "";
}

export function projectCreationProblem(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
  workspaceDir: string,
): ProjectCreationProblem | null {
  const type = findProjectCreationType(options, selection.typeKey);
  if (!type || !type.available) {
    return "typeUnavailable";
  }
  if (!workspaceDir.trim()) {
    return "directoryRequired";
  }
  if (type.key === "acp" && !selection.engineId) {
    return "engineRequired";
  }
  if (type.key === "acp" && (!type.engineDirectory?.ready || !type.engineDirectory.engines.some(engine => engine.engineId === selection.engineId && engine.enabled && engine.syncState === "applied" && engine.dependencyState === "ready"))) return "engineUnavailable";
  if (type.modelRequired && !resolveProjectCreationModel(options, selection)) {
    return "modelRequired";
  }
  return null;
}

export function buildProjectCreationRequest(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
  workspaceDir: string,
): AssistantCreateProjectRequest {
  const type = findProjectCreationType(options, selection.typeKey);
  const request: AssistantCreateProjectRequest = {
    projectType: selection.typeKey,
    workspaceDir: workspaceDir.trim(),
    definition: selectedCreationDefinition(options, selection.typeKey, selection.groups),
  };
  if (selection.typeKey === "acp") {
    request.engineId = selection.engineId;
    return request;
  }
  // Only a model that differs from the type default is sent; otherwise Agent
  // Platform applies its own configured default.
  const modelKey = resolveProjectCreationModel(options, selection);
  if (modelKey && modelKey !== type?.defaultModelKey) {
    request.modelKey = modelKey;
  }
  return request;
}

/** Directory states are observations from Platform; unknown authentication is not a failure. */
export function projectEngineStatus(engine: {enabled: boolean; syncState: string; dependencyState: string; runtimeState: string; authState: string}) {
  if (!engine.enabled) return "disabled";
  if (engine.syncState !== "applied") return "syncPending";
  if (engine.dependencyState === "missing") return "dependencyMissing";
  if (engine.dependencyState !== "ready") return "dependencyUnknown";
  if (engine.runtimeState === "failed" || engine.authState === "error") return "runtimeError";
  if (engine.authState === "required") return "authRequired";
  if (engine.authState === "authenticating") return "authPending";
  return engine.authState === "authenticated" ? "ready" : "authUnknown";
}
