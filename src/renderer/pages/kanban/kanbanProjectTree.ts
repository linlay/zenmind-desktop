import type { KanbanProject } from "../../../shared/contracts";

export const KANBAN_AGGREGATE_PROJECT_ID = "default";

export type KanbanProjectTreeItem = {
  project: KanbanProject;
  level: number;
};

export function isKanbanAggregateProject(project: Pick<KanbanProject, "id">): boolean {
  return project.id.trim() === KANBAN_AGGREGATE_PROJECT_ID;
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
