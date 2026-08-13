import type { KanbanIssue, KanbanProject } from "../../../shared/contracts";

export const KANBAN_AGGREGATE_PROJECT_ID = "default";

export type KanbanProjectTreeItem = {
  project: KanbanProject;
  level: number;
};

export function isKanbanAggregateProject(project: Pick<KanbanProject, "id">): boolean {
  return project.id.trim() === KANBAN_AGGREGATE_PROJECT_ID;
}

export function matchesKanbanProjectSelection(
  issue: Pick<KanbanIssue, "projectId" | "syncMode">,
  projectFilterIds: ReadonlySet<string> | null,
  includeLocalIssues: boolean
): boolean {
  if (!projectFilterIds && !includeLocalIssues) {
    return true;
  }
  if (issue.syncMode !== "cloud") {
    return includeLocalIssues;
  }
  return projectFilterIds?.has(issue.projectId ?? "") ?? false;
}

export function getKanbanPartiallySelectedProjectIds(
  projects: KanbanProject[],
  selectedProjectIds: string[]
): Set<string> {
  const selectedIds = new Set(selectedProjectIds.filter(Boolean));
  const parentByProjectId = new Map(
    projects.map((project) => [project.id, project.parentId?.trim() ?? ""] as const)
  );
  const partiallySelectedIds = new Set<string>();
  for (const selectedProjectId of selectedIds) {
    const visited = new Set<string>([selectedProjectId]);
    let parentId = parentByProjectId.get(selectedProjectId) ?? "";
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!selectedIds.has(parentId) && parentId !== KANBAN_AGGREGATE_PROJECT_ID) {
        partiallySelectedIds.add(parentId);
      }
      parentId = parentByProjectId.get(parentId) ?? "";
    }
  }
  return partiallySelectedIds;
}

export function toggleKanbanProjectTreeSelection(
  projects: KanbanProject[],
  selectedProjectIds: string[],
  projectId: string
): string[] {
  const validProjects = projects.filter((project) => project.id.trim());
  const projectIds = new Set(validProjects.map((project) => project.id));
  if (!projectIds.has(projectId) || projectId === KANBAN_AGGREGATE_PROJECT_ID) {
    return selectedProjectIds.filter(Boolean);
  }

  const parentByProjectId = new Map<string, string>();
  const childrenByParentId = new Map<string, string[]>();
  for (const project of validProjects) {
    const parentId = project.parentId?.trim() ?? "";
    parentByProjectId.set(project.id, parentId);
    if (!parentId || !projectIds.has(parentId)) {
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(project.id);
    childrenByParentId.set(parentId, children);
  }

  const selectedIds = new Set(selectedProjectIds.filter((id) => projectIds.has(id)));
  const subtreeIds = new Set<string>();
  const collectSubtree = (id: string) => {
    if (subtreeIds.has(id)) {
      return;
    }
    subtreeIds.add(id);
    for (const childId of childrenByParentId.get(id) ?? []) {
      collectSubtree(childId);
    }
  };
  collectSubtree(projectId);

  if (selectedIds.has(projectId)) {
    for (const id of subtreeIds) {
      selectedIds.delete(id);
    }
  } else {
    for (const id of subtreeIds) {
      selectedIds.add(id);
    }
  }

  const visitedAncestors = new Set<string>();
  let ancestorId = parentByProjectId.get(projectId) ?? "";
  while (ancestorId && !visitedAncestors.has(ancestorId)) {
    visitedAncestors.add(ancestorId);
    if (ancestorId !== KANBAN_AGGREGATE_PROJECT_ID) {
      const children = childrenByParentId.get(ancestorId) ?? [];
      if (children.length > 0 && children.every((childId) => selectedIds.has(childId))) {
        selectedIds.add(ancestorId);
      } else {
        selectedIds.delete(ancestorId);
      }
    }
    ancestorId = parentByProjectId.get(ancestorId) ?? "";
  }

  return validProjects
    .filter((project) => project.id !== KANBAN_AGGREGATE_PROJECT_ID && selectedIds.has(project.id))
    .map((project) => project.id);
}

function compareKanbanProjects(left: KanbanProject, right: KanbanProject) {
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  const leftLabel = left.path || left.name || left.id;
  const rightLabel = right.path || right.name || right.id;
  return leftLabel.localeCompare(rightLabel, "zh-Hans-CN");
}

export function flattenKanbanProjectTree(projects: KanbanProject[]): KanbanProjectTreeItem[] {
  const validProjects = projects.filter((project) => project.id.trim());
  const projectIds = new Set(validProjects.map((project) => project.id));
  const childrenByParentId = new Map<string, KanbanProject[]>();
  const roots: KanbanProject[] = [];
  for (const project of validProjects) {
    const parentId = project.parentId?.trim() ?? "";
    if (!parentId || !projectIds.has(parentId)) {
      roots.push(project);
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(project);
    childrenByParentId.set(parentId, children);
  }
  const items: KanbanProjectTreeItem[] = [];
  const visited = new Set<string>();
  const visit = (project: KanbanProject, level: number) => {
    if (visited.has(project.id)) {
      return;
    }
    visited.add(project.id);
    if (isKanbanAggregateProject(project)) {
      const children = (childrenByParentId.get(project.id) ?? []).sort(compareKanbanProjects);
      for (const child of children) {
        visit(child, level);
      }
      return;
    }
    items.push({ project, level });
    const children = (childrenByParentId.get(project.id) ?? []).sort(compareKanbanProjects);
    for (const child of children) {
      visit(child, level + 1);
    }
  };
  for (const root of roots.sort(compareKanbanProjects)) {
    visit(root, 0);
  }
  for (const project of validProjects.sort(compareKanbanProjects)) {
    if (!visited.has(project.id)) {
      visit(project, Math.max(0, project.depth));
    }
  }
  return items;
}
