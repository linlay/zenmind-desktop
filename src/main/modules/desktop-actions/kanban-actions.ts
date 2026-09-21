import { type DesktopActionBridgeOptions } from "./action-contracts";
import { fail, ok, readKanbanIssueId, readKanbanInput, readKanbanMoveInput } from "./action-values";
import { validateKanbanActionArgs } from "./kanban-validation";
import { type DesktopKanbanIssueResult, type DesktopKanbanDeleteResult } from "../../../shared/desktop-actions";
import { type KanbanIssueInput, type KanbanIssueUpdateInput } from "../../../shared/contracts";

export async function executeKanbanAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const runtime = options.getKanbanRuntime?.() ?? null;
  if (!runtime) {
    return fail(action, "kanban_unavailable", "Kanban runtime is not initialized.");
  }
  const invalid = validateKanbanActionArgs(action, args);
  if (invalid) return fail(action, "invalid_args", invalid.message, invalid.details);
  if (action === "desktop.kanban.listIssues") {
    return ok(action, runtime.listIssues());
  }
  if (action === "desktop.kanban.getIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    const list = runtime.listIssues();
    const issue = list.issues.find((candidate) => candidate.id === id);
    return issue
      ? ok(action, { issue } satisfies DesktopKanbanIssueResult)
      : fail(action, "not_found", `Kanban issue not found: ${id}`, { issueId: id });
  }
  if (action === "desktop.kanban.createIssue") {
    const input = readKanbanInput(args);
    if (!input) {
      return fail(action, "invalid_args", "input object is required.");
    }
    const result = await runtime.createIssue(input as unknown as KanbanIssueInput);
    if (!result.ok) {
      return fail(action, "kanban_create_failed", result.message);
    }
    if (!result.issue) {
      return fail(action, "invalid_action_result", "Kanban create succeeded without an issue.");
    }
    return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
  }
  if (action === "desktop.kanban.updateIssue") {
    const id = readKanbanIssueId(args);
    const input = readKanbanInput(args);
    if (!id || !input) {
      return fail(action, "invalid_args", "id and input object are required.");
    }
    const result = await runtime.updateIssue(id, input as unknown as KanbanIssueUpdateInput);
    if (!result.ok) {
      return fail(action, "kanban_update_failed", result.message, { issueId: id });
    }
    if (!result.issue) {
      return fail(action, "invalid_action_result", "Kanban update succeeded without an issue.");
    }
    return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
  }
  if (action === "desktop.kanban.deleteIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    const result = await runtime.deleteIssueWithAutomation(id);
    if (!result.ok) {
      return fail(action, "kanban_delete_failed", result.message, { issueId: id });
    }
    if (!result.deletedIssueId) {
      return fail(action, "invalid_action_result", "Kanban delete succeeded without a deletedIssueId.");
    }
    return ok(action, { deletedIssueId: result.deletedIssueId } satisfies DesktopKanbanDeleteResult);
  }
  const input = readKanbanMoveInput(args);
  if (!input) {
    return fail(action, "invalid_args", "id, status, and numeric position are required.");
  }
  const result = await runtime.moveIssue(input);
  if (!result.ok) {
    return fail(action, "kanban_move_failed", result.message, { issueId: input.id });
  }
  if (!result.issue) {
    return fail(action, "invalid_action_result", "Kanban move succeeded without an issue.");
  }
  return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
}
