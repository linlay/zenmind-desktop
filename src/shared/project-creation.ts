import type {
  AssistantCreateProjectRequest,
  AssistantCreateProjectType,
  AssistantProjectCreationGroup,
  AssistantProjectCreationOptions,
  AssistantProjectCreationType,
} from "./contracts";

/**
 * Selection rules of the New Project dialog. They are kept free of UI state so
 * Desktop and the web client apply identical behavior to the options that
 * Agent Platform returns.
 */

export type ProjectCreationSelection = {
  typeKey: AssistantCreateProjectType;
  groups: string[];
  /** True once the user changed the groups by hand. */
  groupsTouched: boolean;
  /** Model picked by hand; empty means "use the type's default". */
  modelKey: string;
  acpBridgeId: string;
};

export type ProjectCreationProblem =
  | "typeUnavailable"
  | "directoryRequired"
  | "modelRequired"
  | "acpBridgeRequired";

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
    acpBridgeId: type?.acpBridges?.[0]?.id ?? "",
  };
}

/**
 * Switching type applies the new type's default groups until the user has
 * edited the groups; after that the user's choice is kept, minus anything the
 * new type cannot use. A hand-picked model is kept across native types.
 */
export function changeProjectCreationType(
  options: AssistantProjectCreationOptions,
  selection: ProjectCreationSelection,
  typeKey: AssistantCreateProjectType,
): ProjectCreationSelection {
  const type = findProjectCreationType(options, typeKey);
  const selectable = new Set(selectableProjectCreationGroups(options, typeKey).map((group) => group.key));
  const groups = selection.groupsTouched
    ? selection.groups.filter((key) => selectable.has(key))
    : defaultGroups(options, typeKey);
  const bridges = type?.acpBridges ?? [];
  return {
    ...selection,
    typeKey,
    groups,
    acpBridgeId: bridges.some((bridge) => bridge.id === selection.acpBridgeId)
      ? selection.acpBridgeId
      : bridges[0]?.id ?? "",
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
  if (type.key === "acp" && !selection.acpBridgeId) {
    return "acpBridgeRequired";
  }
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
    capabilityGroups: type?.supportsGroups ? [...selection.groups] : [],
  };
  if (selection.typeKey === "acp") {
    request.acpBridgeId = selection.acpBridgeId;
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
