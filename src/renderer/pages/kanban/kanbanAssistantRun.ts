import type { KanbanIssue } from "../../../shared/contracts";

export function resolvePrivateKanbanRunChatId(
  issue: Pick<KanbanIssue, "attachments" | "attachmentChatId" | "chatId">
): string | undefined {
  const existingChatId = issue.chatId?.trim();
  if (existingChatId) {
    return existingChatId;
  }
  const attachmentChatId = issue.attachmentChatId?.trim();
  return issue.attachments.length > 0 && attachmentChatId ? attachmentChatId : undefined;
}
