import { KANBAN_STATUSES, type KanbanStatus } from "../../../shared/contracts";

type Issue = { path: string; code: string; expected: string; actual: string };
const reference = "Read desktop-action/references/kanban.md before retrying with corrected args. Do not reuse another action's argument shape.";

export function validateKanbanActionArgs(action: string, args: Record<string, unknown>) {
  const issues: Issue[] = [];
  const add = (path: string, value: unknown, expected: string, valid: boolean) => {
    if (!valid) issues.push({ path, code: value === undefined ? "required" : "invalid_type_or_value", expected,
      actual: value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value });
  };
  const text = (path: string, value: unknown) => add(path, value, "non-empty string", typeof value === "string" && value.trim().length > 0);
  const create = action === "desktop.kanban.createIssue";
  const update = action === "desktop.kanban.updateIssue";
  const move = action === "desktop.kanban.moveIssue";
  if (update || move || action === "desktop.kanban.getIssue" || action === "desktop.kanban.deleteIssue") text("args.id", args.id);
  if (create || update) {
    const input = args.input;
    const valid = !!input && typeof input === "object" && !Array.isArray(input);
    add("args.input", input, "object", valid);
    if (valid) {
      const fields = input as Record<string, unknown>;
      if (create || fields.title !== undefined) text("args.input.title", fields.title);
      if (fields.status !== undefined) add("args.input.status", fields.status, KANBAN_STATUSES.join(" | "), KANBAN_STATUSES.includes(fields.status as KanbanStatus));
      for (const key of ["workflowId", "typeId", "position"]) {
        if (key in fields) issues.push({ path: `args.input.${key}`, code: "unsupported_field",
          expected: key === "workflowId" ? "use localWorkflowId from listIssues.localWorkflows if needed" : key === "position" ? "use moveIssue to set position" : "omit this server-owned field", actual: "present" });
      }
    }
  }
  if (move) {
    add("args.status", args.status, KANBAN_STATUSES.join(" | "), KANBAN_STATUSES.includes(args.status as KanbanStatus));
    add("args.position", args.position, "finite number", typeof args.position === "number" && Number.isFinite(args.position));
    if (args.baseIssueRevision !== undefined) add("args.baseIssueRevision", args.baseIssueRevision, "non-negative integer", Number.isSafeInteger(args.baseIssueRevision) && (args.baseIssueRevision as number) >= 0);
  }
  if (!issues.length) return null;
  const shape = create ? 'Use args: {input: {title, status?, assigneeAgentKey?, ...}}; not args.issue or flat issue fields.'
    : update ? 'Use args: {id, input: {...}}.' : move ? 'Use args: {id, status, position}; do not wrap these fields in input.' : 'Use args: {id}.';
  return { message: `${action}: ${issues.map(issue => `${issue.path} requires ${issue.expected} (actual: ${issue.actual})`).join("; ")}. ${shape}`,
    details: { issues, recovery: reference } };
}
