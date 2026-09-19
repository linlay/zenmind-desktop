import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./runtime.part-1";
import { ConnectorError, captureWebappContext } from "./webapp-platform-client";
export async function executeWebappKanban(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, invocation: DesktopActionInvocationContext) {
  try {
    if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") throw new ConnectorError("forbidden");
    const context = await captureWebappContext(options, invocation.webappId, invocation.signal);
    const allowed = action === "kanban.boards.list" ? [] : action === "kanban.issues.get" ? ["issueId"] : ["projectId", "cursor", "limit"];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new ConnectorError("invalid_arguments");
    const runtime = options.getKanbanRuntime?.();
    if (!runtime) throw new ConnectorError("kanban_unavailable");
    const snapshot = runtime.listIssues();
    if (!snapshot.ok) throw new ConnectorError("kanban_unavailable");
    await context.check();
    const cloudAvailable = snapshot.connectionState === "open";
    if (action === "kanban.boards.list") return { ok: true, action, result: {
      items: cloudAvailable && snapshot.boardId ? [{ id: snapshot.boardId }] : [],
      projects: (snapshot.projects ?? []).filter(item => item.syncMode !== "cloud" || cloudAvailable)
        .map(item => ({ id: item.id, name: item.name, parentId: item.parentId, syncMode: item.syncMode ?? "local" })),
      cloudAvailable
    } };
    // Never return runtime paths, attachments, Chat grants, custom fields or the full cache.
    const issues = snapshot.issues.filter(item => item.syncMode !== "cloud" || cloudAvailable);
    const project = (item: typeof issues[number], detail = false) => ({
      id: item.id, projectId: item.projectId ?? null, title: item.title, status: item.status,
      statusName: item.statusName ?? null, priority: item.priority, syncMode: item.syncMode ?? "local",
      ...(detail ? { description: item.description } : {})
    });
    if (action === "kanban.issues.get") {
      if (typeof args.issueId !== "string" || !args.issueId || args.issueId.length > 256) throw new ConnectorError("invalid_arguments");
      const issue = issues.find(item => item.id === args.issueId);
      if (!issue) throw new ConnectorError("issue_not_found");
      return { ok: true, action, result: { issue: project(issue, true) } };
    }
    if (args.projectId !== undefined && typeof args.projectId !== "string") throw new ConnectorError("invalid_arguments");
    const cursor = args.cursor ?? 0, limit = args.limit ?? 50;
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ConnectorError("invalid_arguments");
    const filtered = issues.filter(item => args.projectId === undefined || item.projectId === args.projectId);
    const end = (cursor as number) + (limit as number);
    return { ok: true, action, result: { items: filtered.slice(cursor as number, end).map(item => project(item)), ...(end < filtered.length ? { nextCursor: end } : {}), cloudAvailable } };
  } catch (error) { return { ok: false, action, error: { code: error instanceof ConnectorError ? error.code : "kanban_unavailable", message: "Kanban request failed." } }; }
}
