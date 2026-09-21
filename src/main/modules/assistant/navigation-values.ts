import { requireEpochMillis, isAgentPlatformEpochMilliseconds, parseOptionalNullableAgentPlatformEpochMillis } from "../../../shared/time-contract";
import { type AssistantAwaitingMode } from "../../../shared/contracts";
import { FINISHED_AWAITING_STATUSES, STRUCTURED_PUSH_TIME_FIELDS } from "./navigation-contracts";

export function nowEpochMillis() {
  return requireEpochMillis(Date.now(), "desktop.assistantNavigation.now");
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toAwaitingMode(value: unknown): AssistantAwaitingMode | undefined {
  const mode = toText(value).toLowerCase();
  return mode === "approval" ||
    mode === "question" ||
    mode === "form" ||
    mode === "planning"
    ? mode
    : undefined;
}

export function toFiniteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function toNonNegativeInteger(value: unknown) {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

export function toOptionalNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.round(numeric))
    : undefined;
}

export function isFinishedAwaitingStatus(value: string) {
  return FINISHED_AWAITING_STATUSES.has(value);
}

export function hasPendingAwaitingPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasPendingAwaitingPayload(item));
  }
  if (!isObjectRecord(value)) {
    return false;
  }

  const type = toText(value.type).toLowerCase();
  if (type === "awaiting.answered") {
    return false;
  }

  const status = toText(value.status).toLowerCase();
  if (isFinishedAwaitingStatus(status)) {
    return false;
  }

  if (isObjectRecord(value.answer)) {
    const answerType = toText(value.answer.type).toLowerCase();
    const answerStatus = toText(value.answer.status).toLowerCase();
    if (
      answerType === "awaiting.answered" ||
      isFinishedAwaitingStatus(answerStatus)
    ) {
      return false;
    }
  }

  if (value.hasPendingAwaiting === true) {
    return true;
  }
  if (value.hasPendingAwaiting === false) {
    return false;
  }
  if (toNonNegativeInteger(value.awaitingCount) > 0) {
    return true;
  }
  if (
    type === "awaiting.asking" ||
    status === "awaiting" ||
    status === "pending" ||
    toText(value.awaitingId)
  ) {
    return true;
  }
  return hasPendingAwaitingPayload(value.awaiting);
}

export function countPendingAwaitingPayload(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countPendingAwaitingPayload(item), 0);
  }
  if (!isObjectRecord(value) || !hasPendingAwaitingPayload(value)) {
    return 0;
  }

  const explicitCount = toNonNegativeInteger(value.awaitingCount);
  if (explicitCount > 0) {
    return explicitCount;
  }
  const nestedCount = countPendingAwaitingPayload(value.awaiting);
  return nestedCount > 0 ? nestedCount : 1;
}

export function toTimestampMs(value: unknown) {
  return isAgentPlatformEpochMilliseconds(value) ? value : undefined;
}

export function validatePresentNavigationTimes(record: Record<string, unknown>, path: string) {
  for (const field of STRUCTURED_PUSH_TIME_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) {
      parseOptionalNullableAgentPlatformEpochMillis(record[field], `${path}.${field}`);
    }
  }
}

export function validateNavigationPayloadTimes(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNavigationPayloadTimes(item, `${path}[${index}]`));
    return;
  }
  if (!isObjectRecord(value)) {
    return;
  }
  validatePresentNavigationTimes(value, path);
  if (value.awaiting !== undefined) {
    validateNavigationPayloadTimes(value.awaiting, `${path}.awaiting`);
  }
}
