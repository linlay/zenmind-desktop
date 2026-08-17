import type {
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
} from "../../shared/contracts";
import { requireEpochMillis } from "../../shared/time-contract";
import type { SurfaceInteraction, SurfaceLevel, SurfaceRole } from "../../shared/surface-identity";

const DEFAULT_MAX_ENTRIES = 500;
const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_NODES = 2_000;
const MAX_TRACE_STRING_CHARS = 64 * 1024;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const REDACTED_VALUE = "<REDACTED>";
const TRUNCATED_VALUE = "<TRUNCATED>";

const SENSITIVE_FIELD_NAMES = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "cookie",
  "id_token",
  "idtoken",
  "password",
  "refresh_token",
  "refreshtoken",
  "secret",
  "set_cookie",
  "setcookie",
  "token",
]);

type SanitizeState = {
  nodes: number;
  remainingStringChars: number;
  seen: WeakSet<object>;
};

function normalizeFieldName(value: string) {
  return value.trim().toLowerCase().replace(/[.-]/gu, "_");
}

function isSensitiveFieldName(value: string) {
  const normalized = normalizeFieldName(value);
  return SENSITIVE_FIELD_NAMES.has(normalized) ||
    SENSITIVE_FIELD_NAMES.has(normalized.replace(/_/gu, ""));
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <REDACTED>")
    .replace(
      /([?&#](?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|id[_-]?token|refresh[_-]?token|secret|token)=)[^&#\s]*/giu,
      "$1<REDACTED>",
    );
}

function sanitizeString(value: string, state: SanitizeState) {
  const redacted = redactSensitiveText(value);
  if (state.remainingStringChars <= 0) return TRUNCATED_VALUE;
  const allowed = Math.min(redacted.length, state.remainingStringChars);
  state.remainingStringChars -= allowed;
  return allowed === redacted.length
    ? redacted
    : `${redacted.slice(0, allowed)}…<TRUNCATED ${redacted.length - allowed} chars>`;
}

function sanitizeValue(
  value: unknown,
  state: SanitizeState,
  depth: number,
  fieldName = "",
): unknown {
  if (fieldName && isSensitiveFieldName(fieldName)) return REDACTED_VALUE;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value, state);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "<UNDEFINED>";
  if (typeof value === "function") return "<FUNCTION>";
  if (typeof value === "symbol") return String(value);
  if (depth >= MAX_TRACE_DEPTH || state.nodes >= MAX_TRACE_NODES) return TRUNCATED_VALUE;
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) return "<CIRCULAR>";

  state.nodes += 1;
  state.seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength} bytes>`;
    if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`;
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, state, depth + 1));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`<TRUNCATED ${value.length - MAX_ARRAY_ITEMS} items>`);
      }
      return items;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      output[key] = sanitizeValue(item, state, depth + 1, key);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      output.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

export function sanitizeAgentRealtimeDebugValue(value: unknown) {
  return sanitizeValue(value, {
    nodes: 0,
    remainingStringChars: MAX_TRACE_STRING_CHARS,
    seen: new WeakSet(),
  }, 0);
}

export class RealtimeDebugTraceBuffer {
  private readonly entries: AgentRealtimeDebugTraceEntry[] = [];
  private sequence = 0;

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  append(input: {
    layer: AgentRealtimeDebugTraceLayer;
    direction: AgentRealtimeDebugTraceDirection;
    data: unknown;
    surfaceId?: string;
    webContentsId?: number;
    surfaceKind?: string;
    surfaceRole?: SurfaceRole;
    surfaceLevel?: SurfaceLevel;
    parentSurfaceId?: string;
    interaction?: SurfaceInteraction;
    route?: string;
  }) {
    this.sequence += 1;
    const entry: AgentRealtimeDebugTraceEntry = {
      sequence: this.sequence,
      recordedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugTrace.recordedAt"),
      layer: input.layer,
      direction: input.direction,
      data: sanitizeAgentRealtimeDebugValue(input.data),
      ...(input.surfaceId?.trim() ? { surfaceId: input.surfaceId.trim() } : {}),
      ...(Number.isSafeInteger(input.webContentsId) ? { webContentsId: input.webContentsId } : {}),
      ...(input.surfaceKind?.trim() ? { surfaceKind: input.surfaceKind.trim() } : {}),
      ...(input.surfaceRole ? { surfaceRole: input.surfaceRole } : {}),
      ...(input.surfaceLevel ? { surfaceLevel: input.surfaceLevel } : {}),
      ...(input.parentSurfaceId?.trim() ? { parentSurfaceId: input.parentSurfaceId.trim() } : {}),
      ...(input.interaction ? { interaction: input.interaction } : {}),
      ...(input.route?.trim() ? { route: redactSensitiveText(input.route.trim()) } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return entry;
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear() {
    this.entries.length = 0;
  }
}
