import type {
  KanbanIssue
} from "../../../shared/contracts";
import { isRecord, readText } from "./protocol-values";
import {
  type KanbanDesktopDelivery,
  type KanbanDesktopIssueEvent
} from "./ws-client";

export function issueSyncMode(issue: KanbanIssue | null | undefined) {
  return issue?.syncMode === "cloud" ? "cloud" : "local";
}

export function getRemoteIssueId(issue: KanbanIssue) {
  return readText(issue.remoteIssueId) || readText(issue.id);
}

export function deliveryPayloadRecord(delivery: KanbanDesktopDelivery): Record<string, unknown> {
  return isRecord(delivery.payload) ? delivery.payload : {};
}

export function deliverySourceRevision(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const revision = typeof delivery.sourceRevision === "number" && Number.isFinite(delivery.sourceRevision)
    ? delivery.sourceRevision
    : typeof payload.revision === "number" && Number.isFinite(payload.revision)
      ? payload.revision
      : 0;
  return Math.max(0, Math.floor(revision));
}

export function deliveryIssuePayload(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  return "issue" in payload ? payload.issue : null;
}

export function deliveryIssueId(delivery: KanbanDesktopDelivery) {
  const payload = deliveryPayloadRecord(delivery);
  const issue = deliveryIssuePayload(delivery);
  return readText(payload.issueId) ||
    readText(payload.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}

export function issueEventIssuePayload(event: KanbanDesktopIssueEvent) {
  const payload = isRecord(event.payload) ? event.payload : {};
  return event.issue ?? ("issue" in payload ? payload.issue : null);
}

export function issueEventIssueId(event: KanbanDesktopIssueEvent) {
  const issue = issueEventIssuePayload(event);
  return readText(event.issueId) ||
    readText(event.deletedIssueId) ||
    (isRecord(issue) ? readText(issue.id) : "");
}
