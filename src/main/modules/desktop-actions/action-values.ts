import { type DesktopActionError, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { sanitizeActionErrorText, normalizeActionDiagnostics } from "./diagnostics";
import { type DesktopCdpCallResponse } from "./action-contracts";
import { type ServiceId, type KanbanIssueMoveInput, type MarketListOptions } from "../../../shared/contracts";
import { WEBAPP_ID_PATTERN } from "../../../shared/webapp-manifest";

export function actionError(code: string, message: string, details?: unknown): DesktopActionError {
  return {
    code,
    message: sanitizeActionErrorText(message),
    details: normalizeActionDiagnostics(code, details)
  };
}

export function ok(action: string, result?: unknown): DesktopActionCallResponse {
  return { ok: true, action, result };
}

export function preview(action: string, value: unknown): DesktopActionCallResponse {
  return { ok: true, action, preview: value };
}

export function fail(action: string, code: string, message: string, details?: unknown): DesktopActionCallResponse {
  return { ok: false, action, error: actionError(code, message, details) };
}

export function cdpFail(method: string, code: string, message: string, details?: unknown): DesktopCdpCallResponse {
  // CDP owns its existing diagnostic contract independently of Action errors.
  return { ok: false, method, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readString(args: Record<string, unknown>, key: string) {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

export function hasObjectKeys(value: Record<string, unknown>) {
  return Object.keys(value).length > 0;
}

export function readServiceId(args: Record<string, unknown>) {
  const serviceId = readString(args, "serviceId");
  if (!serviceId) {
    throw new Error("serviceId is required");
  }
  return serviceId as ServiceId;
}

export function readWebappId(args: Record<string, unknown>) {
  const raw = typeof args.webappId === "string"
    ? args.webappId
    : typeof args.id === "string" ? args.id : "";
  if (!WEBAPP_ID_PATTERN.test(raw)) {
    throw new Error("webappId must be present and already valid");
  }
  return raw;
}

export function readWebsiteId(args: Record<string, unknown>) {
  const websiteId = readString(args, "websiteId") || readString(args, "id");
  if (!websiteId) {
    throw new Error("website id is required");
  }
  return websiteId;
}

export function readItemId(args: Record<string, unknown>) {
  const itemId = readString(args, "itemId");
  if (!itemId) {
    throw new Error("itemId is required");
  }
  return itemId;
}

export function readActionInput(args: Record<string, unknown>) {
  const input = asRecord(args.input);
  const patch = asRecord(args.patch);
  return hasObjectKeys(input) ? input : hasObjectKeys(patch) ? patch : args;
}

export function firstRecordItem(value: unknown) {
  return Array.isArray(value) ? asRecord(value[0]) : {};
}

export function hasWebsiteInputFields(value: Record<string, unknown>) {
  return ["id", "url", "label", "name", "copilotAgentKey", "agentKey"].some((field) => field in value);
}

export function normalizeWebsiteInputAliases(input: Record<string, unknown>) {
  const normalized = { ...input };
  if (typeof normalized.label !== "string" && typeof normalized.name === "string") {
    normalized.label = normalized.name;
  }
  if (
    (typeof normalized.copilotAgentKey !== "string" || !normalized.copilotAgentKey.trim()) &&
    typeof normalized.agentKey === "string"
  ) {
    normalized.copilotAgentKey = normalized.agentKey;
  }
  delete normalized.agentKey;
  return normalized;
}

export function selectWebsiteInputCandidate(value: Record<string, unknown>) {
  if (hasWebsiteInputFields(value)) {
    return value;
  }
  const item = asRecord(value.item);
  if (hasObjectKeys(item)) {
    return item;
  }
  const website = asRecord(value.website);
  if (hasObjectKeys(website)) {
    return website;
  }
  const firstItem = firstRecordItem(value.items);
  if (hasObjectKeys(firstItem)) {
    return firstItem;
  }
  return value;
}

export function readWebsiteActionInput(args: Record<string, unknown>) {
  const input = asRecord(args.input);
  if (hasObjectKeys(input)) {
    return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(input));
  }
  const patch = asRecord(args.patch);
  if (hasObjectKeys(patch)) {
    return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(patch));
  }
  return normalizeWebsiteInputAliases(selectWebsiteInputCandidate(args));
}

export function readKanbanIssueId(args: Record<string, unknown>) {
  return readString(args, "id");
}

export function readKanbanInput(args: Record<string, unknown>) {
  const input = args.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

export function readKanbanMoveInput(args: Record<string, unknown>): KanbanIssueMoveInput | null {
  const id = readKanbanIssueId(args);
  const status = readString(args, "status");
  const position = typeof args.position === "number" ? args.position : Number.NaN;
  if (!id || !status || !Number.isFinite(position)) {
    return null;
  }
  return {
    id,
    status: status as KanbanIssueMoveInput["status"],
    position,
    ...(typeof args.baseIssueRevision === "number" ? { baseIssueRevision: args.baseIssueRevision } : {})
  };
}

export function isMarketSection(value: unknown): value is NonNullable<MarketListOptions["sections"]>[number] {
  return value === "plugins" ||
    value === "skills" ||
    value === "agents" ||
    value === "sandboxImages" ||
    value === "pets" ||
    value === "cli" ||
    value === "connectors" ||
    value === "websiteApps";
}

export function readMarketListOptions(args: Record<string, unknown>): MarketListOptions {
  const rawOptions = asRecord(args.options);
  const rawSections = Array.isArray(args.sections)
    ? args.sections
    : Array.isArray(rawOptions.sections)
      ? rawOptions.sections
      : [];
  const sections = rawSections.filter(isMarketSection);
  return sections.length > 0 ? { sections } : {};
}
