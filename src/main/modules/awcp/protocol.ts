import { Buffer } from "node:buffer";

/** AWCP v1 envelopes shared by Main's native guest and Chrome Worker transports.
 * This domain validates only protocol data; page-owned business Schema and all
 * page lifecycle, authorization and manual bindings remain with each transport.
 */
export const AWCP_PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION = AWCP_PROTOCOL_VERSION;
export const AWCP_ACTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const AWCP_LIMITS = Object.freeze({
  maxActionLength: 128,
  maxRevisionLength: 128,
  maxRequestIdLength: 128,
  maxTitleLength: 128,
  maxDescriptionLength: 16 * 1024,
  maxExamples: 32,
  maxErrorMessageLength: 4096,
  maxErrorDetailsBytes: 128 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxSections: 128,
  maxIndexBytes: 64 * 1024,
  maxSectionBytes: 256 * 1024,
});

export type AwcpManualPayload = Record<string, never> | { section: string; revision: string };

export type AwcpInvokePayload = {
  revision: string;
  action: string;
  args: Record<string, unknown>;
};

export type AwcpActionResponse =
  | { ok: true; requestId: string; action: string; result: unknown }
  | {
      ok: false;
      requestId: string;
      action: string;
      error: { code: string; message: string; details?: unknown };
    };

export type AwcpManualIndex = {
  revision: string;
  site: { name: string; description: string };
  sections: Array<{ section: string; title: string }>;
};

export type AwcpManualSection = {
  revision: string;
  section: string;
  description: string;
  inputSchema: Record<string, unknown>;
  examples?: Record<string, unknown>[];
};

export type AwcpManualResponse =
  | ({ ok: true; method: "AWCP.getManual" } & AwcpManualIndex)
  | ({ ok: true; method: "AWCP.getManual" } & AwcpManualSection);

export class AwcpHostError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AwcpHostError";
  }
}

const AWCP_ERROR_CODES = new Set([
  "action_not_found",
  "stale_revision",
  "invalid_arguments",
  "execution_failed",
  "cancelled",
  "duplicate_request",
]);

export function validateManualPayload(input: unknown): AwcpManualPayload {
  assertPlainRecord(input, "AWCP manual payload");
  const keys = Object.keys(input).sort();
  if (keys.length === 0) return {};
  assertExactKeys(input, ["revision", "section"], "AWCP manual payload");
  assertAction(input.section, "section");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength);
  return { section: input.section, revision: input.revision };
}

export function validateInvokePayload(requestId: unknown, input: unknown): AwcpInvokePayload {
  assertToken("requestId", requestId, AWCP_LIMITS.maxRequestIdLength);
  assertPlainRecord(input, "AWCP payload");
  assertExactKeys(input, ["action", "args", "revision"], "AWCP payload");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength);
  assertAction(input.action);
  assertPlainRecord(input.args, "AWCP args");
  assertJsonValue(input.args, "AWCP args");
  return input as AwcpInvokePayload;
}

export function validateManualIndex(input: unknown): AwcpManualIndex {
  assertPlainRecord(input, "AWCP manual index", "awcp_invalid_contract");
  assertExactKeys(input, ["revision", "sections", "site"], "AWCP manual index", "awcp_invalid_contract");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength, "awcp_invalid_contract");
  assertPlainRecord(input.site, "AWCP site", "awcp_invalid_contract");
  assertExactKeys(input.site, ["description", "name"], "AWCP site", "awcp_invalid_contract");
  assertText(input.site.name, "AWCP site name", AWCP_LIMITS.maxTitleLength);
  assertText(input.site.description, "AWCP site description", AWCP_LIMITS.maxDescriptionLength);
  if (!Array.isArray(input.sections) || input.sections.length > AWCP_LIMITS.maxSections) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP section index.");
  }
  let previous = "";
  for (const item of input.sections) {
    assertPlainRecord(item, "AWCP section summary", "awcp_invalid_contract");
    assertExactKeys(item, ["section", "title"], "AWCP section summary", "awcp_invalid_contract");
    assertAction(item.section, "section", "awcp_invalid_contract");
    if (item.section <= previous) {
      throw awcpHostError("awcp_invalid_contract", "AWCP sections must be strictly sorted.");
    }
    assertText(item.title, "AWCP section title", AWCP_LIMITS.maxTitleLength);
    previous = item.section;
  }
  if (Buffer.byteLength(stableAwcpJSON(input), "utf8") > AWCP_LIMITS.maxIndexBytes) {
    throw awcpHostError("awcp_invalid_contract", "The page AWCP manual index exceeds 64 KiB.");
  }
  return input as AwcpManualIndex;
}

export function validateManualSection(input: unknown, requestedSection: string, requestedRevision: string): AwcpManualSection {
  assertPlainRecord(input, "AWCP manual section", "awcp_invalid_contract");
  const expected = Object.prototype.hasOwnProperty.call(input, "examples")
    ? ["description", "examples", "inputSchema", "revision", "section"]
    : ["description", "inputSchema", "revision", "section"];
  assertExactKeys(input, expected, "AWCP manual section", "awcp_invalid_contract");
  assertToken("revision", input.revision, AWCP_LIMITS.maxRevisionLength, "awcp_invalid_contract");
  assertAction(input.section, "section", "awcp_invalid_contract");
  if (input.section !== requestedSection || input.revision !== requestedRevision) {
    throw awcpHostError("awcp_invalid_contract", "The page returned a different AWCP manual section.");
  }
  assertText(input.description, "AWCP section description", AWCP_LIMITS.maxDescriptionLength);
  assertPlainRecord(input.inputSchema, "AWCP inputSchema", "awcp_invalid_contract");
  assertJsonValue(input.inputSchema, "AWCP inputSchema", "awcp_invalid_contract");
  if (Object.prototype.hasOwnProperty.call(input, "examples")) {
    if (!Array.isArray(input.examples) || input.examples.length > AWCP_LIMITS.maxExamples) {
      throw awcpHostError("awcp_invalid_contract", "AWCP examples must be a bounded array.");
    }
    input.examples.forEach((example, index) => {
      assertPlainRecord(example, `AWCP example ${index}`, "awcp_invalid_contract");
      assertJsonValue(example, `AWCP example ${index}`, "awcp_invalid_contract");
    });
  }
  if (Buffer.byteLength(stableAwcpJSON(input), "utf8") > AWCP_LIMITS.maxSectionBytes) {
    throw awcpHostError("awcp_invalid_contract", "The page AWCP manual section exceeds 256 KiB.");
  }
  return input as AwcpManualSection;
}

export function validateManualError(input: unknown, requestedSection: string): "section_not_found" | "stale_revision" | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "error")) return null;
  if (Object.keys(record).join(",") !== "error") {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  const error = record.error as Record<string, unknown>;
  if (Object.keys(error).sort().join(",") !== "code,message,section" ||
      (error.code !== "section_not_found" && error.code !== "stale_revision") ||
      error.section !== requestedSection || typeof error.message !== "string" || !error.message.trim() ||
      error.message.length > AWCP_LIMITS.maxErrorMessageLength) {
    throw awcpHostError("awcp_invalid_contract", "The page returned an invalid AWCP manual error.");
  }
  return error.code;
}

export function stableAwcpJSON(value: unknown): string {
  const order = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(order);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, order(record[key])]));
    }
    return input;
  };
  return JSON.stringify(order(value));
}

function assertText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw awcpHostError("awcp_invalid_contract", `${name} must be non-empty and at most ${maximum} characters.`);
  }
}

export function awcpPreflightFailure(
  reason: "stale_revision" | "action_not_found" | "page_changed" | "manual_required",
  message: string,
) {
  return awcpHostError("awcp_preflight_rejected", message, {
    reason, stage: "desktop_preflight", executionStarted: false,
  });
}

export function validateActionResponse(input: unknown, requestId: string, action: string): AwcpActionResponse {
  assertPlainRecord(input, "AWCP response", "awcp_invalid_response");
  assertJsonValue(input, "AWCP response", "awcp_invalid_response");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > AWCP_LIMITS.maxResponseBytes) {
    throw awcpHostError("awcp_response_too_large", "The page AWCP response exceeds 64 MiB.");
  }
  if (input.requestId !== requestId || input.action !== action) {
    throw awcpHostError("awcp_response_mismatch", "The page AWCP response does not match its request.");
  }
  if (input.ok === true) {
    assertExactKeys(input, ["action", "ok", "requestId", "result"], "AWCP success response", "awcp_invalid_response");
    return input as AwcpActionResponse;
  }
  if (input.ok !== false) throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP response.");
  assertExactKeys(input, ["action", "error", "ok", "requestId"], "AWCP failure response", "awcp_invalid_response");
  assertPlainRecord(input.error, "AWCP error", "awcp_invalid_response");
  const errorKeys = Object.keys(input.error).sort();
  if (errorKeys.join(",") !== "code,message" && errorKeys.join(",") !== "code,details,message") {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error.");
  }
  const code = input.error.code;
  if (typeof code !== "string" || (!AWCP_ERROR_CODES.has(code) && !/^action\..+$/.test(code))) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error code.");
  }
  if (typeof input.error.message !== "string" || !input.error.message.trim() ||
      input.error.message.length > AWCP_LIMITS.maxErrorMessageLength) {
    throw awcpHostError("awcp_invalid_response", "The page returned an invalid AWCP error message.");
  }
  if (Object.prototype.hasOwnProperty.call(input.error, "details") &&
      Buffer.byteLength(JSON.stringify(input.error.details), "utf8") > AWCP_LIMITS.maxErrorDetailsBytes) {
    throw awcpHostError("awcp_invalid_response", "The page returned oversized AWCP error details.");
  }
  return input as AwcpActionResponse;
}

function assertAction(value: unknown, name = "action", code = "awcp_invalid_request"): asserts value is string {
  if (typeof value !== "string" || !value || value.length > AWCP_LIMITS.maxActionLength || !AWCP_ACTION_PATTERN.test(value)) {
    throw awcpHostError(code, `AWCP ${name} is invalid.`);
  }
}

export function assertToken(
  name: string,
  value: unknown,
  maxLength: number,
  code = "awcp_invalid_request",
): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw awcpHostError(code, `AWCP ${name} is invalid.`);
  }
}

export function assertPlainRecord(
  value: unknown,
  name: string,
  code = "awcp_invalid_request",
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw awcpHostError(code, `${name} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw awcpHostError(code, `${name} must be a plain JSON object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  name: string,
  code = "awcp_invalid_request",
) {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw awcpHostError(code, `${name} has unsupported fields.`);
  }
}

export function assertJsonValue(root: unknown, name: string, code = "awcp_invalid_request") {
  const visit = (value: unknown, ancestors: Set<object>) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      throw awcpHostError(code, `${name} contains a non-finite number.`);
    }
    if (!value || typeof value !== "object") throw awcpHostError(code, `${name} contains a non-JSON value.`);
    if (ancestors.has(value)) throw awcpHostError(code, `${name} contains a cycle.`);
    ancestors.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw awcpHostError(code, `${name} contains a symbol property.`);
    }
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw awcpHostError(code, `${name} contains a sparse or extended array.`);
      }
      for (const item of value) visit(item, ancestors);
      ancestors.delete(value);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw awcpHostError(code, `${name} contains a non-plain object.`);
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw awcpHostError(code, `${name} contains an accessor property.`);
      }
      visit(descriptor.value, ancestors);
    }
    ancestors.delete(value);
  };
  visit(root, new Set());
}

export function awcpHostError(code: string, message: string, details?: Record<string, unknown>) {
  const statusCode = code === "awcp_invalid_request" || code === "awcp_preflight_rejected"
    ? 400
    : code === "awcp_duplicate_request" || code === "site_control_unavailable"
      ? 409
      : 502;
  return new AwcpHostError(code, statusCode, message, details);
}

export function isAwcpHostError(error: unknown): error is AwcpHostError {
  return error instanceof AwcpHostError;
}
