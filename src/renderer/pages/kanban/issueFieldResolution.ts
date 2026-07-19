import type {
  KanbanIssueFieldContext,
  KanbanIssueFieldDef,
  KanbanIssueFieldOption,
  KanbanProject,
  KanbanResolvedIssueField
} from "../../../shared/contracts";

export function resolveKanbanIssueFields(
  defs: KanbanIssueFieldDef[],
  contexts: KanbanIssueFieldContext[],
  options: KanbanIssueFieldOption[],
  projects: KanbanProject[],
  projectId: string,
  issueTypeKey: string,
  workflowId: string
): KanbanResolvedIssueField[] {
  const defsById = new Map(defs.map((def) => [def.id, def]));
  const optionsByFieldId = new Map<string, KanbanIssueFieldOption[]>();
  for (const option of options) {
    if (option.isActive === false) continue;
    const fieldOptions = optionsByFieldId.get(option.fieldId) ?? [];
    fieldOptions.push(option);
    optionsByFieldId.set(option.fieldId, fieldOptions);
  }
  for (const fieldOptions of optionsByFieldId.values()) {
    fieldOptions.sort((left, right) => left.position - right.position || left.key.localeCompare(right.key));
  }

  const projectDistances = buildKanbanProjectDistances(projects, projectId);
  const contextByFieldId = new Map<string, KanbanIssueFieldContext>();
  for (const context of contexts) {
    if (!context.isActive) continue;
    if (context.projectId && !projectDistances.has(context.projectId)) continue;
    if (context.issueTypeKey && context.issueTypeKey !== issueTypeKey) continue;
    if (context.workflowId && context.workflowId !== workflowId) continue;
    const current = contextByFieldId.get(context.fieldId);
    if (!current || contextWins(context, current, projectDistances)) {
      contextByFieldId.set(context.fieldId, context);
    }
  }

  const resolved: KanbanResolvedIssueField[] = [];
  for (const context of contextByFieldId.values()) {
    const def = defsById.get(context.fieldId);
    if (!def) continue;
    resolved.push({
      def,
      context,
      options: optionsByFieldId.get(context.fieldId) ?? [],
      projectDistance: context.projectId ? projectDistances.get(context.projectId) : undefined
    });
  }
  return resolved.sort((left, right) => left.context.position - right.context.position || left.def.key.localeCompare(right.def.key));
}

export function buildKanbanProjectDistances(projects: KanbanProject[], projectId: string) {
  const parents = new Map(projects.map((project) => [project.id, project.parentId ?? ""]));
  const distances = new Map<string, number>();
  let current = projectId;
  let distance = 0;
  while (current && !distances.has(current)) {
    distances.set(current, distance);
    current = parents.get(current) ?? "";
    distance += 1;
  }
  return distances;
}

function contextWins(
  candidate: KanbanIssueFieldContext,
  current: KanbanIssueFieldContext,
  projectDistances: Map<string, number>
) {
  const candidateRank = contextRank(candidate);
  const currentRank = contextRank(current);
  if (candidateRank.specificity !== currentRank.specificity) {
    return candidateRank.specificity > currentRank.specificity;
  }
  const candidateDistance = contextDistance(candidate, projectDistances);
  const currentDistance = contextDistance(current, projectDistances);
  if (candidateDistance !== currentDistance) {
    return candidateDistance < currentDistance;
  }
  if (candidateRank.dimension !== currentRank.dimension) {
    return candidateRank.dimension > currentRank.dimension;
  }
  return candidate.id.localeCompare(current.id) < 0;
}

function contextRank(context: KanbanIssueFieldContext) {
  let specificity = 0;
  let dimension = 0;
  if (context.projectId) {
    specificity += 1;
    dimension += 4;
  }
  if (context.workflowId) {
    specificity += 1;
    dimension += 2;
  }
  if (context.issueTypeKey) {
    specificity += 1;
    dimension += 1;
  }
  return { specificity, dimension };
}

function contextDistance(context: KanbanIssueFieldContext, projectDistances: Map<string, number>) {
  if (!context.projectId) return Number.MAX_SAFE_INTEGER;
  return projectDistances.get(context.projectId) ?? Number.MAX_SAFE_INTEGER;
}
