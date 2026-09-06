import type {
  AssistantConversationShareExpiration,
  AssistantConversationShareRecord,
} from "../../../shared/contracts";
import { requireEpochMillis } from "../../../shared/time-contract";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname,
} from "../tunnel";
import { MAX_CONVERSATION_HTML_BYTES } from "./export-contract";
import type { ConversationShareTarget } from "./target";

const CONVERSATION_SHARES_PATH = "/api/desktop/shares";
const CONVERSATION_DOCUMENT_VERSION_HEADER = "X-Conversation-Document-Version";
const CONVERSATION_SHARE_EXPIRATION_HEADER = "X-Conversation-Share-Expiration";
const CONVERSATION_ID_HEADER = "X-Conversation-ID";
const CONVERSATION_DOCUMENT_VERSION = "1";
const CREATE_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONVERSATION_ID_BYTES = 255;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const RECORD_KEYS = ["id", "url", "createdAt", "expiresAt", "lastAccessedAt", "singleUse"] as const;

export type TunnelConversationShareErrorKind =
  | "invalid_request"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "invalid_response";

export class TunnelConversationShareError extends Error {
  constructor(
    readonly kind: TunnelConversationShareErrorKind,
    readonly status?: number,
  ) {
    super(`Tunnel conversation share request failed: ${kind}`);
    this.name = "TunnelConversationShareError";
  }
}

export type ConversationShareCreateInput = {
  target: ConversationShareTarget;
  conversationId: string;
  expiration: AssistantConversationShareExpiration;
  html: Buffer;
};

export interface ConversationShareCreator {
  create(input: ConversationShareCreateInput): Promise<AssistantConversationShareRecord>;
}

export interface ConversationShareReader {
  list(
    target: ConversationShareTarget,
    conversationId: string,
  ): Promise<AssistantConversationShareRecord[]>;
}

export interface ConversationShareRevoker {
  revoke(target: ConversationShareTarget, shareId: string): Promise<void>;
}

export class TunnelConversationShareClient implements
  ConversationShareCreator,
  ConversationShareReader,
  ConversationShareRevoker {
  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  async create(input: ConversationShareCreateInput): Promise<AssistantConversationShareRecord> {
    requireValidTarget(input.target);
    if (
      !isValidConversationId(input.conversationId) ||
      input.html.byteLength === 0
    ) {
      throw new TunnelConversationShareError("invalid_request");
    }
    if (input.html.byteLength > MAX_CONVERSATION_HTML_BYTES) {
      throw new TunnelConversationShareError("invalid_request", 413);
    }
    const response = await this.request(
      `${input.target.origin}${CONVERSATION_SHARES_PATH}`,
      {
        method: "POST",
        headers: {
          ...authorizationHeaders(input.target),
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(input.html.byteLength),
          [CONVERSATION_DOCUMENT_VERSION_HEADER]: CONVERSATION_DOCUMENT_VERSION,
          [CONVERSATION_SHARE_EXPIRATION_HEADER]: input.expiration,
          [CONVERSATION_ID_HEADER]: input.conversationId,
        },
        body: input.html as unknown as BodyInit,
      },
      CREATE_TIMEOUT_MS,
    );
    requireStatus(response, 201);
    const record = readConversationShareRecord(await readLimitedJson(response));
    if (
      record.lastAccessedAt !== null ||
      (input.expiration === "once"
        ? !record.singleUse || record.expiresAt !== null
        : record.singleUse ||
          (input.expiration === "permanent"
            ? record.expiresAt !== null
            : record.expiresAt === null))
    ) {
      throw new TunnelConversationShareError("invalid_response");
    }
    return record;
  }

  async list(
    target: ConversationShareTarget,
    conversationId: string,
  ): Promise<AssistantConversationShareRecord[]> {
    requireValidTarget(target);
    if (!isValidConversationId(conversationId)) {
      throw new TunnelConversationShareError("invalid_request");
    }
    const query = new URLSearchParams({ conversationId });
    const response = await this.request(
      `${target.origin}${CONVERSATION_SHARES_PATH}?${query.toString()}`,
      {
        method: "GET",
        headers: authorizationHeaders(target),
      },
      READ_TIMEOUT_MS,
    );
    requireStatus(response, 200);
    const payload = await readLimitedJson(response);
    if (!isRecord(payload) || !hasOnlyKeys(payload, ["items"]) || !Array.isArray(payload.items)) {
      throw new TunnelConversationShareError("invalid_response");
    }
    const seen = new Set<string>();
    return payload.items.map((item) => {
      const record = readConversationShareRecord(item);
      if (seen.has(record.shareId)) {
        throw new TunnelConversationShareError("invalid_response");
      }
      seen.add(record.shareId);
      return record;
    });
  }

  async revoke(target: ConversationShareTarget, shareId: string): Promise<void> {
    requireValidTarget(target);
    if (!SHARE_ID_PATTERN.test(shareId)) {
      throw new TunnelConversationShareError("invalid_request");
    }
    const response = await this.request(
      `${target.origin}${CONVERSATION_SHARES_PATH}/${encodeURIComponent(shareId)}`,
      {
        method: "DELETE",
        headers: authorizationHeaders(target),
      },
      READ_TIMEOUT_MS,
    );
    requireStatus(response, 204);
    await discardResponseBody(response);
  }

  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof TunnelConversationShareError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new TunnelConversationShareError("timeout");
      }
      throw new TunnelConversationShareError("unavailable");
    }
  }
}

function authorizationHeaders(target: ConversationShareTarget): Record<string, string> {
  return { Authorization: `Bearer ${target.accessToken}` };
}

function requireValidTarget(target: ConversationShareTarget): void {
  if (!isValidTunnelApiOrigin(target.origin) || !/^[^\s]+$/u.test(target.accessToken)) {
    throw new TunnelConversationShareError("invalid_request");
  }
}

function isValidTunnelApiOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const loopback = isTunnelHubLoopbackHostname(parsed.hostname);
    return value === parsed.origin &&
      !parsed.username &&
      !parsed.password &&
      !isTunnelHubForbiddenHostname(parsed.hostname) &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
  } catch {
    return false;
  }
}

function requireStatus(response: Response, expectedStatus: number): void {
  if (response.status === expectedStatus) {
    return;
  }
  void discardResponseBody(response);
  throw new TunnelConversationShareError("rejected", response.status);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A response body is deliberately never surfaced through share errors.
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await discardResponseBody(response);
    throw new TunnelConversationShareError("invalid_response");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_JSON_RESPONSE_BYTES) {
      await discardResponseBody(response);
      throw new TunnelConversationShareError("invalid_response");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TunnelConversationShareError("invalid_response");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof TunnelConversationShareError) {
      throw error;
    }
    throw new TunnelConversationShareError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

function readConversationShareRecord(value: unknown): AssistantConversationShareRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const shareId = readTrimmedString(value.id);
  const url = readTrimmedString(value.url);
  if (!SHARE_ID_PATTERN.test(shareId) || !isSafeConversationShareUrl(url)) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const createdAt = readRequiredRfc3339(value.createdAt);
  const expiresAt = readNullableRfc3339(value.expiresAt);
  const lastAccessedAt = readNullableRfc3339(value.lastAccessedAt);
  const singleUse = value.singleUse;
  if (
    typeof singleUse !== "boolean" ||
    (singleUse && (expiresAt !== null || lastAccessedAt !== null)) ||
    (expiresAt !== null && expiresAt <= createdAt) ||
    (lastAccessedAt !== null && lastAccessedAt < createdAt) ||
    (expiresAt !== null && lastAccessedAt !== null && lastAccessedAt > expiresAt)
  ) {
    throw new TunnelConversationShareError("invalid_response");
  }
  return { shareId, url, createdAt, expiresAt, lastAccessedAt, singleUse };
}

function readRequiredRfc3339(value: unknown) {
  if (typeof value !== "string") {
    throw new TunnelConversationShareError("invalid_response");
  }
  const match = RFC3339_PATTERN.exec(value);
  if (!match) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    !isValidRfc3339Zone(zoneText)
  ) {
    throw new TunnelConversationShareError("invalid_response");
  }
  return requireEpochMillis(Date.parse(value), "conversationShare.timestamp");
}

function readNullableRfc3339(value: unknown) {
  if (value === null) {
    return null;
  }
  return readRequiredRfc3339(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidRfc3339Zone(value: string): boolean {
  if (value === "Z") {
    return true;
  }
  const hour = Number(value.slice(1, 3));
  const minute = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59;
}

function isSafeConversationShareUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const loopback = isTunnelHubLoopbackHostname(parsed.hostname);
    return !parsed.username &&
      !parsed.password &&
      !isTunnelHubForbiddenHostname(parsed.hostname) &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
  } catch {
    return false;
  }
}

function isValidConversationId(value: string): boolean {
  return value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CONVERSATION_ID_BYTES &&
    !/\p{Cc}/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" && value.trim() === value ? value : "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}
