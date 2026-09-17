import type { KanbanIssue, KanbanProject } from "../../../shared/contracts";

export const KANBAN_AGGREGATE_PROJECT_ID = "default";

export type KanbanProjectTreeItem = {
  project: KanbanProject;
  level: number;
};

export function isKanbanAggregateProject(project: Pick<KanbanProject, "id">): boolean {
  return project.id.trim() === KANBAN_AGGREGATE_PROJECT_ID;
}

export type KanbanProjectSource = "all" | "local" | "cloud";

export function getKanbanIssueProjectName(issue: Pick<KanbanIssue, "syncMode" | "projectId" | "projectName">, project: KanbanProject | undefined, defaultLocalName: string) {
  const projectId = issue.projectId?.trim() || "";
  // The built-in local project has a fixed, localized identity, like the project picker.
  if (issue.syncMode !== "cloud" && (!projectId || projectId === "default")) return defaultLocalName;
  return project?.name.trim() || issue.projectName?.trim() || projectId || "—";
}

export function listKanbanLocalProjectOptions(issues: KanbanIssue[], defaultName: string, catalog: KanbanProject[] = []) {
  const projects = new Map<string, { id: string; name: string; count: number }>();
  projects.set("default", { id: "default", name: defaultName, count: 0 });
  for (const issue of issues) {
    if (issue.syncMode === "cloud") continue;
    const id = issue.projectId?.trim() || "default";
    const current = projects.get(id) || { id, name: issue.projectName?.trim() || id, count: 0 };
    if (id !== "default" && issue.projectName?.trim()) current.name = issue.projectName.trim();
    current.count += 1;
    projects.set(id, current);
  }
  for (const project of catalog) {
    if (project.syncMode !== "local") continue;
    const id = project.id.trim();
    if (!id) continue;
    projects.set(id, {
      id,
      name: id === "default" ? defaultName : project.name.trim() || projects.get(id)?.name || id,
      count: projects.get(id)?.count ?? 0
    });
  }
  return [...projects.values()].sort((a, b) => a.id === b.id ? 0 : a.id === "default" ? -1 : b.id === "default" ? 1 : a.name.localeCompare(b.name));
}

export function matchesKanbanProjectSelection(
  issue: Pick<KanbanIssue, "projectId" | "syncMode">,
  projectFilterIds: ReadonlySet<string> | null,
  includeLocalIssues: boolean,
  selectedLocalProjectIds: readonly string[] = [],
  source: KanbanProjectSource = "all"
): boolean {
  const local = issue.syncMode !== "cloud";
  if ((source === "local" && !local) || (source === "cloud" && local)) return false;
  const hasSelection = source === "local"
    ? includeLocalIssues || selectedLocalProjectIds.length > 0
    : source === "cloud" ? Boolean(projectFilterIds)
    : Boolean(projectFilterIds) || includeLocalIssues || selectedLocalProjectIds.length > 0;
  if (!hasSelection) return true;
  if (local) return includeLocalIssues || selectedLocalProjectIds.includes(issue.projectId?.trim() || "default");
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
