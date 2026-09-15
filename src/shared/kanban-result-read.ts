import type { KanbanCloudDetailData, KanbanIssue } from "./contracts/kanban";

/** Completion belongs to an issue run, never to the Chat for its entire lifetime. */
export function resolveKanbanResultIdentity(issue: KanbanIssue, details?: KanbanCloudDetailData) {
  const cloud = issue.syncMode === "cloud";
  const status = details?.workflowStatuses.find((item) => item.id === issue.statusId);
  const stage = details?.workflowStages.find((item) => item.id === issue.stageId);
  const localStages = issue.localWorkflow?.stages;
  const terminal = cloud
    ? (status?.isTerminal ?? issue.status === "completed") && stage?.isEnd !== false
    : issue.status === "completed" && (!localStages?.length || localStages.at(-1)?.id === issue.stageId);
  if (!terminal) return null;
  const externalId = issue.remoteIssueId || issue.id;
  const run = cloud ? details?.issueRuns.filter((item) => item.issueId === externalId)
    .sort((a, b) => Date.parse(b.startedAt || b.createdAt) - Date.parse(a.startedAt || a.createdAt))[0] : undefined;
  if (run?.state === "running" || run?.state === "queued" || (!cloud && issue.runState === "running")) return null;
  const chat = run ? details?.issueChats.find((item) => item.id === run.issueChatId && item.issueId === externalId && item.deviceId === run.deviceId) : undefined;
  const chatId = cloud ? chat?.chatId || "" : (issue.runId || issue.activeRunId ? issue.chatId : issue.lastRunChatId || issue.chatId) || "";
  const runId = cloud ? run?.externalRunId || "" : issue.runId || issue.activeRunId || issue.lastRunId || "";
  return {
    key: JSON.stringify([issue.id, chatId, runId || run?.id || issue.runFinishedAt || issue.updatedAt]),
    chatId,
    runId,
    deviceId: cloud ? run?.deviceId || "" : "",
    cloud
  };
}
