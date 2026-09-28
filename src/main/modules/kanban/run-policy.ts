import { randomUUID } from "node:crypto";
import type {
  AssistantNavigationPushEvent,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  KanbanIssue,
  KanbanRunState,
  KanbanStatus
} from "../../../shared/contracts";
import { readPositiveIntegerEnv, readText } from "./protocol-values";

export type KanbanRunFinishedPushResolution = {
  status: KanbanStatus;
  runState: Exclude<KanbanRunState, "running">;
  terminalEventType: "run.completed" | "run.failed" | "run.cancelled";
};

export function resolveKanbanRunFinishedPush(
  event: Pick<AssistantNavigationPushEvent, "frame" | "type" | "status" | "finishReason">
): KanbanRunFinishedPushResolution | null {
  if (event.frame !== "push" || event.type !== "run.finished") {
    return null;
  }
  const status = event.status?.trim() ?? "";
  const finishReason = event.finishReason?.trim() ?? "";
  if (status === "completed" && finishReason === "complete") {
    return { status: "completed", runState: "completed", terminalEventType: "run.completed" };
  }
  if (status === "failed" && finishReason === "error") {
    return { status: "todo", runState: "failed", terminalEventType: "run.failed" };
  }
  if (status === "interrupted" && finishReason === "cancel") {
    return { status: "todo", runState: "cancelled", terminalEventType: "run.cancelled" };
  }
  return null;
}

export const REMOTE_START_RUN_ACK_TIMEOUT_MS = readPositiveIntegerEnv(
  "DESKTOP_KANBAN_REMOTE_START_ACK_TIMEOUT_MS",
  5_000
);

export function parseStructuredReviewText(value: string): { verdict: "approved" | "changes_requested" | "rejected"; summary: string } | undefined {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const verdict = readText(parsed.verdict);
    const summary = readText(parsed.summary);
    if ((verdict === "approved" || verdict === "changes_requested" || verdict === "rejected") && summary) {
      return { verdict, summary };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeRemoteAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

export function stableClientEventId(deviceId: string, parts: Array<string | number | null | undefined>) {
  return [deviceId, ...parts.map((part) => readText(String(part ?? ""))).filter(Boolean)].join(":");
}

export function createKanbanRemoteChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function createKanbanRemoteRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function buildDesktopKanbanRunPrompt(issue: KanbanIssue) {
  return [readText(issue.title), readText(issue.description)].filter(Boolean).join("\n\n");
}

export function waitForRemoteStartRunAck(startRun: Promise<AssistantStartRunResult>, timeoutMs: number) {
  return new Promise<AssistantStartRunResult | null>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    startRun.then((result) => {
      clearTimeout(timeout);
      resolve(result);
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function withTimeout<T>(producer: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(producer),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
