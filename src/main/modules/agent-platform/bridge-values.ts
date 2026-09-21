import { randomUUID } from "node:crypto";
import { requireEpochMillis } from "../../../shared/time-contract";
import { type AssistantStartRunRequest } from "../../../shared/contracts";

export function createChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistant.now");
}

export function createRunId() {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function createMessageId(role: string, runId: string) {
  return `msg_${role}_${runId}_${randomUUID().slice(0, 8)}`;
}

export function createApiUrl(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

export function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function readNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function normalizeAssistantPermissionMode(value: unknown): AssistantStartRunRequest["permissionMode"] {
  return value === "full_access" || value === "page_control" ? value : "default";
}

export function normalizeAssistantAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  return value === "default" || value === "auto_approve" || value === "full_access" ? value : undefined;
}
