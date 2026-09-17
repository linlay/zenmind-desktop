import type {
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
} from "../../../../shared/contracts";
import type { SurfaceInteraction, SurfaceLevel, SurfaceRole } from "../../../../shared/surface-identity";

const MAX_SERIALIZABLE_DEPTH = 256;
const REDACTED_VALUE = "<REDACTED>";

const SENSITIVE_FIELD_NAMES = new Set([
  "access_token", "accesstoken", "api_key", "apikey", "authorization",
  "client_secret", "clientsecret", "cookie", "id_token", "idtoken",
  "password", "refresh_token", "refreshtoken", "secret", "set_cookie",
  "setcookie", "token", "credential", "credentials", "private_key", "privatekey",
  "workspace_root", "workspaceroot",
]);

export type AgentRealtimeDebugTraceInput = {
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
};

function normalizeFieldName(value: string) {
  return value.trim().toLowerCase().replace(/[.-]/gu, "_");
}

function isSensitiveFieldName(value: string) {
  const normalized = normalizeFieldName(value);
  return SENSITIVE_FIELD_NAMES.has(normalized) ||
    SENSITIVE_FIELD_NAMES.has(normalized.replace(/_/gu, "")) ||
    /(?:^|_)(?:api_key|cookie|password|secret|token)$/u.test(normalized);
}

export function redactAgentRealtimeDiagnosticText(value: string) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <REDACTED>")
    .replace(/\b(Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n]*/giu, "$1: <REDACTED>")
    .replace(
      /([?&#](?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|id[_-]?token|refresh[_-]?token|secret|token)=)[^&#\s]*/giu,
      "$1<REDACTED>",
    );
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number, fieldName = ""): unknown {
  if (fieldName && isSensitiveFieldName(fieldName)) return REDACTED_VALUE;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactAgentRealtimeDiagnosticText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "<UNDEFINED>";
  if (typeof value === "function") return "<FUNCTION>";
  if (typeof value === "symbol") return String(value);
  if (depth > MAX_SERIALIZABLE_DEPTH) {
    throw new Error(`runtime_recording_value_too_deep:${MAX_SERIALIZABLE_DEPTH}`);
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "<CIRCULAR>";

  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength} bytes>`;
    if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`;
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen, depth + 1));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, sanitizeValue(item, seen, depth + 1, key)]));
  } finally {
    seen.delete(value);
  }
}

export function sanitizeAgentRealtimeDebugValue(value: unknown) {
  return sanitizeValue(value, new WeakSet(), 0);
}

export function sanitizeAgentRealtimeDebugTraceEntry(
  entry: AgentRealtimeDebugTraceEntry,
): AgentRealtimeDebugTraceEntry {
  return {
    ...entry,
    data: sanitizeAgentRealtimeDebugValue(entry.data),
    ...(entry.route ? { route: redactAgentRealtimeDiagnosticText(entry.route) } : {}),
  };
}
