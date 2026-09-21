import { t } from "../../support/i18n/main-i18n";
import { type DesktopActionSource, type DesktopActionCallRequest } from "../../../shared/desktop-actions";
import {
  type DesktopPageContextSnapshot,
  type DesktopActionConfirmationRequest,
  type DesktopActionConfirmationDecision
} from "../../../shared/contracts";
import { readSnapshotUrl } from "./page-context-values";
import { readRequestPermissionMode } from "./action-permissions";
import { randomUUID } from "node:crypto";

export const CONFIRMATION_ARG_MAX_KEYS = 8;

export const CONFIRMATION_ARG_MAX_NESTED_KEYS = 6;

export const CONFIRMATION_ARG_MAX_ARRAY_ITEMS = 4;

export const CONFIRMATION_ARG_VALUE_MAX_CHARS = 160;

export const CONFIRMATION_ARG_SUMMARY_MAX_CHARS = 1200;

export const CONFIRMATION_COMPACT_VALUE_MAX_CHARS = 280;

export function truncateConfirmationText(value: string, maxChars: number) {
  const chars = Array.from(value.replace(/\s+/gu, " ").trim());
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}...`;
}

export function isSensitiveConfirmationKey(key: string) {
  const normalized = key.replace(/[\s._-]+/gu, "").toLowerCase();
  return normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("desktopauthcontext");
}

export function sanitizeConfirmationUrl(value: string) {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return value;
  }
  try {
    const url = new URL(trimmed);
    if (url.origin && url.origin !== "null") {
      return `${url.origin}${url.pathname}`;
    }
    if (url.protocol === "file:") {
      return `file://${url.host}${url.pathname}`;
    }
    if (url.host) {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    return `${url.protocol}${url.pathname}`;
  } catch {
    return value;
  }
}

export function sanitizeConfirmationUrlText(value: string) {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, (match) => sanitizeConfirmationUrl(match));
}

export function sanitizeConfirmationValue(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveConfirmationKey(key)) {
    return t("desktopAction.confirmDetailRedacted");
  }
  if (typeof value === "string") {
    return sanitizeConfirmationUrlText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, CONFIRMATION_ARG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeConfirmationValue(item, key, depth + 1));
    return value.length > CONFIRMATION_ARG_MAX_ARRAY_ITEMS ? [...items, "..."] : items;
  }
  if (!value || typeof value !== "object") {
    return String(value);
  }
  if (depth >= 2) {
    return "[object]";
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).slice(0, CONFIRMATION_ARG_MAX_NESTED_KEYS);
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries) {
    output[entryKey] = sanitizeConfirmationValue(entryValue, entryKey, depth + 1);
  }
  const hiddenCount = Object.keys(record).length - entries.length;
  if (hiddenCount > 0) {
    output["..."] = t("desktopAction.confirmDetailMore", { count: hiddenCount });
  }
  return output;
}

export function stringifyConfirmationArgValue(key: string, value: unknown) {
  const sanitized = sanitizeConfirmationValue(value, key);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return truncateConfirmationText(text ?? "", CONFIRMATION_ARG_VALUE_MAX_CHARS);
}

export function summarizeConfirmationArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return t("desktopAction.confirmDetailArgsEmpty");
  }
  const displayedEntries = entries.slice(0, CONFIRMATION_ARG_MAX_KEYS);
  const lines = displayedEntries.map(([key, value]) => `${key}=${stringifyConfirmationArgValue(key, value)}`);
  const hiddenCount = entries.length - displayedEntries.length;
  if (hiddenCount > 0) {
    lines.push(t("desktopAction.confirmDetailMore", { count: hiddenCount }));
  }
  const summary = lines.join("\n");
  return Array.from(summary).length > CONFIRMATION_ARG_SUMMARY_MAX_CHARS
    ? truncateConfirmationText(summary, CONFIRMATION_ARG_SUMMARY_MAX_CHARS)
    : summary;
}

export function summarizeConfirmationSource(source: DesktopActionSource | undefined) {
  return [
    `runId=${source?.runId?.trim() || "-"}`,
    `chatId=${source?.chatId?.trim() || "-"}`,
    `agentKey=${source?.agentKey?.trim() || "-"}`,
    `teamId=${source?.teamId?.trim() || "-"}`
  ].join(", ");
}

export function describeDesktopActionSnapshotTarget(snapshot: DesktopPageContextSnapshot | null) {
  if (!snapshot) {
    return "-";
  }
  const url = readSnapshotUrl(snapshot);
  const safeUrl = url ? sanitizeConfirmationUrl(url) : "";
  return [
    snapshot.pageKind,
    snapshot.surfaceLabel,
    snapshot.pageContext?.title,
    safeUrl
  ].filter(Boolean).join(" | ") || "-";
}

export function buildDesktopActionConfirmationDetail(
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
  options: { permissionMode?: string; target?: string; prefixLines?: string[] } = {}
) {
  const action = request.action || "unknown";
  const permissionMode = options.permissionMode || readRequestPermissionMode(request, args);
  return [
    ...(options.prefixLines?.filter(Boolean) ?? []),
    ...(options.prefixLines?.length ? [""] : []),
    t("desktopAction.confirmDetailIntro"),
    t("desktopAction.confirmDetailAction", { action, permissionMode }),
    t("desktopAction.confirmDetailRequest", { requestId: request.requestId?.trim() || "-" }),
    t("desktopAction.confirmDetailSource", { source: summarizeConfirmationSource(request.source) }),
    t("desktopAction.confirmDetailTarget", { target: sanitizeConfirmationUrlText(options.target?.trim() || "-") }),
    t("desktopAction.confirmDetailArgs", { args: summarizeConfirmationArgs(args) }),
    t("desktopAction.confirmDetailFooter")
  ].join("\n");
}

export function compactConfirmationValue(value: string) {
  return truncateConfirmationText(value, CONFIRMATION_COMPACT_VALUE_MAX_CHARS);
}

export function getConfirmationRequestId(request: DesktopActionCallRequest) {
  return request.requestId?.trim() || randomUUID();
}

export function buildNativeConfirmationDetail(payload: DesktopActionConfirmationRequest) {
  return [
    payload.description,
    "",
    ...payload.fields.map((field) => `${field.label}: ${field.value}`)
  ].filter((line) => line !== undefined).join("\n");
}

export function findConfirmationButtonIndex(
  payload: DesktopActionConfirmationRequest,
  decision: DesktopActionConfirmationDecision
) {
  const index = payload.buttons.findIndex((button) => button.decision === decision);
  return index === -1 ? 0 : index;
}

export function normalizeConfirmationDecision(
  value: unknown,
  fallback: DesktopActionConfirmationDecision
): DesktopActionConfirmationDecision {
  return value === "confirm" || value === "grant" || value === "once" || value === "cancel"
    ? value
    : fallback;
}
