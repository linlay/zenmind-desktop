import type { DesktopArtifactIdentity, DesktopArtifactRecord } from "../../../shared/artifacts";
import { cleanText, object, parseArtifactMetadata } from "./metadata";
export class ArtifactPlatformError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}
export interface ArtifactChat {
  chatId: string;
  chatName: string;
  agentKey: string;
}
export interface ArtifactPlatformApi {
  listChats(signal: AbortSignal): Promise<ArtifactChat[]>;
  listArchives(signal: AbortSignal): Promise<ArtifactChat[]>;
  listArtifacts(chatId: string, signal: AbortSignal): Promise<DesktopArtifactRecord[]>;
  read(identity: DesktopArtifactIdentity, signal: AbortSignal, maxBytes?: number): Promise<Buffer>;
}
export function artifactError(error: unknown): string {
  return error instanceof ArtifactPlatformError ? error.code : "failed";
}
async function bytesWithLimit(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ArtifactPlatformError("response_too_large");
  }
  if (!response.body)
    return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done)
        break;
      size += next.value.byteLength;
      if (size > max)
        throw new ArtifactPlatformError("response_too_large");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  }
  finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createArtifactPlatformClient(options: {
  resolve(reason: "missing" | "unauthorized"): Promise<{
    baseUrl: string;
    token: string;
  }>;
  fetchImpl?: typeof fetch;
}): ArtifactPlatformApi {
  async function request(route: string, body: unknown, signal: AbortSignal, binary = false, maxBytes = 100 * 1024 * 1024): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    for (const reason of ["missing", "unauthorized"] as const) {
      requestSignal.throwIfAborted();
      const connection = await options.resolve(reason);
      requestSignal.throwIfAborted();
      const response = await (options.fetchImpl ?? fetch)(new URL(route, connection.baseUrl), {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: requestSignal,
        headers: { Authorization: `Bearer ${connection.token}`, Accept: binary ? "*/*" : "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 && reason === "missing") {
        await response.body?.cancel();
        continue;
      }
      const bytes = await bytesWithLimit(response, binary && response.ok ? maxBytes : 32 * 1024 * 1024);
      if (binary && response.ok)
        return bytes;
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      }
      catch {
        throw new ArtifactPlatformError("invalid_response", response.status);
      }
      const payload = object(raw);
      if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
        const code = cleanText(object(payload.data).code) || cleanText(payload.code) || cleanText(payload.msg);
        throw new ArtifactPlatformError(["artifact_ambiguous", "artifact_changed", "artifact_not_found", "chat_access_denied"].includes(code) ? code :
          response.status === 403 ? "chat_access_denied" : response.status === 404 ? "artifact_not_found" : "failed", response.status);
      }
      return "code" in payload && "data" in payload ? payload.data : raw;
    }
    throw new ArtifactPlatformError("chat_access_denied", 401);
  }
  function chats(value: unknown): ArtifactChat[] {
    if (!Array.isArray(value))
      throw new ArtifactPlatformError("invalid_response");
    return value.map(raw => {
      const data = object(raw), chatId = cleanText(data.chatId);
      if (!chatId || /[/\\]/u.test(chatId))
        throw new ArtifactPlatformError("invalid_response");
      return { chatId, chatName: cleanText(data.chatName, 1024), agentKey: cleanText(data.agentKey) };
    });
  }
  return {
    async listChats(signal) {
      // /api/chats has no historical page cursor. Omitting limit requests the complete active list.
      const result = await request("/api/chats", undefined, signal);
      return chats(result);
    },
    async listArchives(signal) {
      const result: ArtifactChat[] = [], seen = new Set<string>();
      let offset = 0;
      while (true) {
        const page = object(await request(`/api/archives?limit=100&offset=${offset}`, undefined, signal));
        const items = chats(page.items);
        if (!Number.isSafeInteger(page.total) || Number(page.total) < 0)
          throw new ArtifactPlatformError("invalid_response");
        for (const item of items) {
          if (seen.has(item.chatId))
            throw new ArtifactPlatformError("unstable_pagination");
          seen.add(item.chatId);
          result.push(item);
        }
        offset += items.length;
        if (offset >= Number(page.total))
          return result;
        if (!items.length)
          throw new ArtifactPlatformError("incomplete_response");
      }
    },
    async listArtifacts(chatId, signal) {
      const result: DesktopArtifactRecord[] = [], seen = new Set<string>();
      let cursor = "";
      while (true) {
        const page = object(await request("/api/chat/artifacts/list", { chatId, limit: 100, ...(cursor ? { cursor } : {}) }, signal));
        if (!Array.isArray(page.items))
          throw new ArtifactPlatformError("invalid_response");
        for (const raw of page.items) {
          const item = parseArtifactMetadata(raw);
          if (!item || item.chatId !== chatId)
            throw new ArtifactPlatformError("invalid_response");
          result.push(item);
        }
        if (page.nextCursor === undefined || page.nextCursor === "")
          return result;
        if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor) || page.items.length === 0)
          throw new ArtifactPlatformError("unstable_pagination");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    },
    async read(identity, signal, maxBytes) { return await request("/api/chat/artifacts/read", identity, signal, true, maxBytes) as Buffer; },
  };
}
