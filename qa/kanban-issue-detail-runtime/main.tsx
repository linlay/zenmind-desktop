import React from "react";
import { createRoot } from "react-dom/client";
import { KanbanIssueDetailDialog } from "../../src/renderer/pages/kanban/KanbanIssueDetailDialog";
import { createTranslator } from "../../src/shared/i18n";
import type { KanbanCloudDetailData, KanbanIssue, KanbanProject } from "../../src/shared/contracts";
import "../../src/renderer/styles/kanban.css";
import "./preview.css";

const timestamp = "2026-07-19T08:42:00.000Z";
const project: KanbanProject = {
  id: "orders",
  parentId: null,
  slug: "orders",
  name: "订单系统",
  path: "电商平台组 / 后端服务 / 订单系统",
  depth: 0,
  position: 1,
  createdAt: timestamp,
  updatedAt: timestamp
};
const issue: KanbanIssue = {
  id: "local-story-1042",
  remoteIssueId: "ZEN-1042",
  projectId: project.id,
  projectPath: project.path,
  projectName: project.name,
  workflowId: "workflow-story",
  issueTypeKey: "story",
  typeId: "story",
  stageId: "stage-story",
  stageKey: "story-flow",
  stageName: "Story 流转",
  statusId: "status-review",
  statusKey: "in_review",
  statusName: "验收中",
  columnKey: "in_review",
  title: "等待确认需求范围",
  description: "梳理订单服务的需求入口、异常边界与 Story 验收条件，形成可执行的拆分范围。重点覆盖订单创建到支付结果回写的主链路，并补齐异常重试与幂等约束。",
  status: "in_review",
  priority: "high",
  severity: "low",
  assigneeAgentKey: "codeAssistant",
  assigneeId: "user-lin",
  workerType: "agent",
  workerAgent: "codeAssistant",
  reviewerId: "user-pm",
  reviewRequired: true,
  activeReviewId: "review-1",
  activeRunId: "run-1042",
  position: 1,
  chatId: "chat-1042",
  runId: "run-1042",
  runState: "completed",
  runAgentKey: "codeAssistant",
  runStartedAt: "2026-07-19T08:23:00.000Z",
  runFinishedAt: timestamp,
  runResultMessage: "需求边界与验收项已整理完毕，当前运行等待人工确认。",
  automationId: "automation-1042",
  automationEnabled: true,
  automationCron: "30 9 * * 1-5",
  automationMessage: "检查订单服务需求范围是否有新增依赖，并同步 Story 验收条件。",
  automationTimezone: "Asia/Shanghai",
  attachmentChatId: "chat-1042",
  attachments: [{ id: "file-1", name: "order-service-scope.md", mimeType: "text/markdown", sizeBytes: 18432, text: "" }],
  customFields: { businessValue: "medium_high", budget: 120000, targetDate: "2026-08-28", stakeholders: ["team-payment", "team-sre"] },
  syncMode: "private",
  syncState: "local",
  origin: "desktop",
  revision: 1042,
  createdBy: "user-lin",
  updatedByAgent: "codeAssistant",
  createdAt: "2026-07-09T02:00:00.000Z",
  updatedAt: timestamp
};
const childIssue = (id: string, title: string, status: KanbanIssue["status"]): KanbanIssue => ({
  ...issue,
  id: `local-${id}`,
  remoteIssueId: id,
  parentIssueId: "ZEN-1042",
  title,
  status,
  statusName: status === "completed" ? "已完成" : "待办",
  runId: null,
  runState: null,
  position: 2
});
const issues = [issue, childIssue("ZEN-1043", "梳理主链路接口清单", "completed"), childIssue("ZEN-1044", "补齐幂等与重试策略", "completed"), childIssue("ZEN-1045", "评审灰度回滚方案", "todo")];
const cloudDetails: KanbanCloudDetailData = {
  users: [
    { id: "user-lin", email: "lin@example.test", displayName: "林然", status: "active" },
    { id: "user-pm", email: "pm@example.test", displayName: "产品负责人", status: "active" }
  ],
  issueTypes: [{ key: "story", name: "故事", description: "Story", color: "#c2410c", position: 1, isActive: true }],
  issueFieldDefs: [
    { id: "f-value", key: "businessValue", name: "价值度", valueType: "select", description: "用于需求池排序与评审。" },
    { id: "f-budget", key: "budget", name: "预算额", valueType: "number", unit: "CNY" },
    { id: "f-date", key: "targetDate", name: "目标日期", valueType: "date" },
    { id: "f-team", key: "stakeholders", name: "关注团队", valueType: "multi_select" }
  ],
  issueFieldContexts: ["f-value", "f-budget", "f-date", "f-team"].map((fieldId, index) => ({ id: `c-${fieldId}`, fieldId, projectId: "orders", issueTypeKey: "story", workflowId: "workflow-story", required: index < 2, position: index + 1, isActive: true })),
  issueFieldOptions: [
    { id: "o-value", fieldId: "f-value", key: "medium_high", name: "中高", position: 1, isActive: true, color: "#3370ff" },
    { id: "o-pay", fieldId: "f-team", key: "team-payment", name: "支付", position: 1, isActive: true },
    { id: "o-sre", fieldId: "f-team", key: "team-sre", name: "SRE", position: 2, isActive: true }
  ],
  workflows: [{ id: "workflow-story", issueTypeKey: "story", key: "standard_story", name: "标准 Story" }],
  workflowStages: [{ id: "stage-story", workflowId: "workflow-story", key: "story-flow", name: "Story 流转" }],
  workflowStatuses: [{ id: "status-review", workflowId: "workflow-story", stageId: "stage-story", key: "in_review", name: "验收中", columnKey: "in_review" }],
  issueLabels: [{ id: "label-backend", projectId: "orders", key: "backend", name: "backend", color: "#3370ff" }, { id: "label-review", projectId: "orders", key: "needs-review", name: "needs-review", color: "#d46b08" }],
  issueLabelLinks: [{ issueId: "ZEN-1042", labelId: "label-backend" }, { issueId: "ZEN-1042", labelId: "label-review" }],
  issueDependencies: [{ id: "dep-1", fromIssueId: "ZEN-1042", toIssueId: "ZEN-1031", type: "阻塞于", createdAt: timestamp }],
  reviews: [{ id: "review-1", issueId: "ZEN-1042", runId: "run-1042", reviewType: "acceptance", reviewerId: "user-pm", status: "pending", requestedBy: "codeAssistant", requestedAt: timestamp, summary: "验收边界已补齐，请产品确认", createdAt: timestamp, updatedAt: timestamp }],
  issueComments: [{ id: "comment-1", issueId: "ZEN-1042", authorUserId: "user-lin", body: "请把旧版订单只读兼容补进非目标说明。", createdAt: timestamp, updatedAt: timestamp }, { id: "comment-2", issueId: "ZEN-1042", authorAgent: "codeAssistant", body: "已补充存量数据处理边界和灰度回滚条件。", createdAt: timestamp, updatedAt: timestamp }],
  recentEvents: [{ id: 1, issueId: "ZEN-1042", projectId: "orders", revision: 1042, eventType: "issue.updated", actorAgent: "codeAssistant", payload: { status: "in_review" }, createdAt: timestamp }, { id: 2, issueId: "ZEN-1042", projectId: "orders", revision: 1041, eventType: "run.completed", actorAgent: "codeAssistant", payload: {}, createdAt: timestamp }]
};

const previewParams = new URLSearchParams(location.search);
document.documentElement.dataset.theme = previewParams.get("theme") === "dark" ? "dark" : "light";
const previewIssue: KanbanIssue = previewParams.get("origin") === "cloud"
  ? { ...issue, id: "cloud-story-1042", syncMode: "cloud", syncState: "synced", origin: "cloud" }
  : issue;

createRoot(document.getElementById("root")!).render(<React.StrictMode><KanbanIssueDetailDialog issue={previewIssue} issues={issues} projects={[project]} cloudDetails={cloudDetails} agents={[{ agentKey: "codeAssistant", displayName: "Codex Agent" }]} locale="zh-CN" t={createTranslator("zh-CN")} onClose={() => undefined} onSave={async () => true} onDelete={async () => true} onOpenChat={() => undefined} onFeedback={() => undefined} /></React.StrictMode>);
