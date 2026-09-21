import type { KanbanEnvelope } from "./ws-model";
import { isRecord, readText } from "./ws-values";
import { t } from "../../support/i18n/main-i18n";

export const PROTOCOL_VERSION = 1;

export const CONTRACT_VERSION = "1.0";

export const REQUEST_TIMEOUT_MS = 30_000;

export const RECONNECT_MS = 5_000;

export const WS_OPEN_STATE = 1;

export class KanbanDesktopRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KanbanDesktopRequestError";
  }
}

export const ISSUE_EVENT_TYPES = new Set([
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.moved",
  "issue.claimed"
]);

export function assertCloudPayloadPrivacy(env: KanbanEnvelope) {
  if (env.frame !== "request") return;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!isRecord(value)) return false;
    if ("syncMode" in value && value.syncMode !== "cloud") return true;
    if ("filePath" in value || "localFilePath" in value) return true;
    if (typeof value.path === "string" && (/^\//u.test(value.path) || /^[A-Za-z]:[\\/]/u.test(value.path))) return true;
    if (Array.isArray(value.attachments) && value.attachments.some((attachment) =>
      isRecord(attachment) && ("text" in attachment || "data" in attachment || "filePath" in attachment || "path" in attachment)
    )) return true;
    if (value.origin === "desktop" && ("title" in value || "attachments" in value || "filePath" in value || "path" in value)) return true;
    return Object.values(value).some(visit);
  };
  if (visit(env.payload)) {
    throw new Error("local kanban payload must never be sent to cloud");
  }
}

export function normalizeMessageType(messageType: string) {
  const trimmed = messageType.trim();
  if (!trimmed) {
    throw new Error(t("kanban.ws.messageTypeRequired"));
  }
  const blockedKanbanPrefix = `kanban${"."}`;
  const blockedDesktopHello = `desktop${"."}hello`;
  const blockedDesktopKanbanPrefix = `desktop${"."}kanban${"."}`;
  if (trimmed.startsWith(blockedKanbanPrefix) || trimmed === blockedDesktopHello || trimmed.startsWith(blockedDesktopKanbanPrefix)) {
    throw new Error(t("kanban.ws.legacyDisabled", { type: trimmed }));
  }
  return trimmed;
}

export function isV1Envelope(env: KanbanEnvelope) {
  return env.v === PROTOCOL_VERSION && readText(env.frame) !== "" && readText(env.type) !== "";
}

export function envelopeBusinessType(env: KanbanEnvelope) {
  return readText(env.type);
}

export function isResponseEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "response";
}

export function isRequestEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "request";
}

export function isSnapshotPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "snapshot.updated";
}

export function isProjectEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && [
    "project.created",
    "project.updated",
    "project.deleted",
    "project.restored",
    "project.accessRevoked"
  ].includes(envelopeBusinessType(env));
}

export function isSyncDeliverPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && envelopeBusinessType(env) === "sync.deliver";
}

export function isIssueEventPushEnvelope(env: KanbanEnvelope) {
  return isV1Envelope(env) && env.frame === "push" && ISSUE_EVENT_TYPES.has(envelopeBusinessType(env));
}
