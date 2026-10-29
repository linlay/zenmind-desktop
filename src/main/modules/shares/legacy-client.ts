import type { ShareRecord } from "../../../shared/contracts/shares";
import { ShareHttpTransport, ShareHttpError as TunnelConversationShareError, authorizationHeaders, requireValidTarget, requireStatus, readLimitedJson, discardResponseBody, isRecord, hasOnlyKeys, readTrimmedString, readRequiredRfc3339, readNullableRfc3339, isValidTunnelApiOrigin } from "./http-transport";
import type { ShareTarget as ConversationShareTarget } from "./http-transport";
export { ShareHttpError as TunnelConversationShareError } from "./http-transport";
type ConversationShareLimits = { maxSnapshotBytes: number; maxResourceBytes: number };
// Released v1 wire policy fields are validated and discarded here.
const CONVERSATION_SHARES_PATH = "/api/desktop/shares";
const CONVERSATION_SNAPSHOT_VERSION_HEADER = "X-Conversation-Snapshot-Version";
const CONVERSATION_SHARE_EXPIRATION_HEADER = "X-Conversation-Share-Expiration";
const CONVERSATION_ID_HEADER = "X-Conversation-ID";
const CONVERSATION_SNAPSHOT_VERSION = "1";
const CREATE_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
const MAX_CONVERSATION_ID_BYTES = 255;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u;
const RECORD_KEYS = ["id", "conversationId", "url", "createdAt", "expiresAt", "lastAccessedAt", "singleUse"] as const;

export type ConversationShareCreateInput = {
  target: ConversationShareTarget;
  conversationId: string;
  snapshot: Buffer;
  attachments: Array<{ id: string; name: string; mimeType: string; bytes: Buffer }>;
};

export interface ConversationShareCreator {
  limits(target: ConversationShareTarget): Promise<ConversationShareLimits>;
  create(input: ConversationShareCreateInput): Promise<ShareRecord>;
}

export interface ConversationShareReader {
  list(target: ConversationShareTarget): Promise<ShareRecord[]>;
}

export interface ConversationShareRevoker {
  revoke(target: ConversationShareTarget, shareId: string): Promise<void>;
}

export class TunnelConversationShareClient extends ShareHttpTransport implements
  ConversationShareCreator,
  ConversationShareReader,
  ConversationShareRevoker {

  async limits(target: ConversationShareTarget): Promise<ConversationShareLimits> {
    requireValidTarget(target);
    const response = await this.request(`${target.origin}${CONVERSATION_SHARES_PATH}/limits`, {
      method: "GET", headers: authorizationHeaders(target), cache: "no-store"
    }, READ_TIMEOUT_MS);
    await requireStatus(response, 200);
    const value = await readLimitedJson(response);
    if (!isRecord(value) || !hasOnlyKeys(value, ["maxSnapshotBytes", "maxResourceBytes"]) ||
      typeof value.maxSnapshotBytes !== "number" || !Number.isSafeInteger(value.maxSnapshotBytes) || value.maxSnapshotBytes <= 0 ||
      typeof value.maxResourceBytes !== "number" || !Number.isSafeInteger(value.maxResourceBytes) || value.maxResourceBytes <= 0 ||
      !Number.isSafeInteger(value.maxSnapshotBytes + value.maxResourceBytes + 1024 * 1024)) {
      throw new TunnelConversationShareError("invalid_response");
    }
    return { maxSnapshotBytes: value.maxSnapshotBytes, maxResourceBytes: value.maxResourceBytes };
  }

  async create(input: ConversationShareCreateInput): Promise<ShareRecord> {
    requireValidTarget(input.target);
    if (!isValidConversationId(input.conversationId) || input.snapshot.byteLength === 0) {
      throw new TunnelConversationShareError("invalid_request");
    }
    const form = new FormData();
    form.append("snapshot", new Blob([Uint8Array.from(input.snapshot)], { type: "application/json" }), "snapshot.json");
    for (const attachment of input.attachments) {
      form.append("attachment:" + attachment.id,
        new Blob([Uint8Array.from(attachment.bytes)], { type: attachment.mimeType }), attachment.name);
    }
    const response = await this.request(
      `${input.target.origin}${CONVERSATION_SHARES_PATH}`,
      {
        method: "POST",
        headers: {
          ...authorizationHeaders(input.target),
          [CONVERSATION_SNAPSHOT_VERSION_HEADER]: CONVERSATION_SNAPSHOT_VERSION,
          [CONVERSATION_SHARE_EXPIRATION_HEADER]: "permanent",
          [CONVERSATION_ID_HEADER]: input.conversationId,
        },
        body: form,
      },
      CREATE_TIMEOUT_MS,
    );
    await requireStatus(response, 201);
    const record = readConversationShareRecord(await readLimitedJson(response), input.conversationId);
    if (
      record.lastAccessedAt !== null
    ) {
      throw new TunnelConversationShareError("invalid_response");
    }
    return record;
  }

  async list(
    target: ConversationShareTarget,
  ): Promise<ShareRecord[]> {
    requireValidTarget(target);
    const response = await this.request(
      `${target.origin}${CONVERSATION_SHARES_PATH}`,
      {
        method: "GET",
        headers: authorizationHeaders(target),
      },
      READ_TIMEOUT_MS,
    );
    await requireStatus(response, 200);
    const payload = await readLimitedJson(response);
    if (!isRecord(payload) || !hasOnlyKeys(payload, ["items"]) || !Array.isArray(payload.items)) {
      throw new TunnelConversationShareError("invalid_response");
    }
    const seen = new Set<string>();
    return payload.items.map((item) => {
      const record = readConversationShareRecord(item);
      if (seen.has(record.id)) {
        throw new TunnelConversationShareError("invalid_response");
      }
      seen.add(record.id);
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
    await requireStatus(response, 204);
    await discardResponseBody(response);
  }

}

function readConversationShareRecord(value: unknown, expectedConversationId?: string): ShareRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const shareId = readTrimmedString(value.id);
  const chatId = readTrimmedString(value.conversationId);
  const url = readTrimmedString(value.url);
  if (
    !SHARE_ID_PATTERN.test(shareId) ||
    !isValidConversationId(chatId) ||
    (expectedConversationId !== undefined && chatId !== expectedConversationId) ||
    !isSafeLegacyUrl(url)
  ) {
    throw new TunnelConversationShareError("invalid_response");
  }
  const createdAt = readRequiredRfc3339(value.createdAt);
  const lastAccessedAt = readNullableRfc3339(value.lastAccessedAt);
  if (value.expiresAt !== null || value.singleUse !== false || (lastAccessedAt !== null && lastAccessedAt < createdAt)) {
    throw new TunnelConversationShareError("invalid_response");
  }
  return { id: shareId, kind: "conversation", title: "Shared conversation (legacy)", url, createdAt, lastAccessedAt,
    ...(!/[\p{Cc}/\\:?#]/u.test(chatId) ? { source: { module: "conversation", id: chatId } } : {}) };

}

function isValidConversationId(value: string): boolean {
  return value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CONVERSATION_ID_BYTES &&
    !/\p{Cc}/u.test(value);
}


function isSafeLegacyUrl(value: string) { try { const url = new URL(value); return !url.username && !url.password && isValidTunnelApiOrigin(url.origin); } catch { return false; } }
