import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  CANONICAL_CHAT_SYNC_REQUEST_CHANNEL,
  CANONICAL_CHAT_SYNC_RESULT_CHANNEL,
  type CanonicalChatSyncRequest,
  type CanonicalChatSyncResult,
} from "../../shared/canonical-chat-sync";

const CANONICAL_CHAT_SYNC_TIMEOUT_MS = 1_500;

type CanonicalChatSyncInput = Omit<CanonicalChatSyncRequest, "requestId">;

export function registerCanonicalChatSyncIpc(ipcMain: any, options: {
  resolveRenderer(ownerWebContentsId: number): WebContents | null;
  timeoutMs?: number;
}) {
  const pending = new Map<string, {
    ownerWebContentsId: number;
    timer: ReturnType<typeof setTimeout>;
    resolve(result: CanonicalChatSyncResult): void;
  }>();

  ipcMain.on?.(CANONICAL_CHAT_SYNC_RESULT_CHANNEL, (event: any, result: CanonicalChatSyncResult) => {
    const requestId = typeof result?.requestId === "string" ? result.requestId.trim() : "";
    const current = pending.get(requestId);
    if (!current || event.sender?.id !== current.ownerWebContentsId || typeof result?.ok !== "boolean") return;
    pending.delete(requestId);
    clearTimeout(current.timer);
    current.resolve(result);
  });

  const request = (ownerWebContentsId: number, input: CanonicalChatSyncInput) => {
    const renderer = options.resolveRenderer(ownerWebContentsId);
    if (!renderer || renderer.isDestroyed()) {
      return Promise.resolve({
        requestId: "",
        ok: false,
        code: "stale_source",
        message: "Main Chat renderer is unavailable",
      } satisfies CanonicalChatSyncResult);
    }
    const requestId = `canonical-chat-${randomUUID()}`;
    const payload: CanonicalChatSyncRequest = { ...input, requestId };
    return new Promise<CanonicalChatSyncResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({
          requestId,
          ok: false,
          code: "surface_registration_failure",
          message: "canonical Chat surface synchronization timed out",
        });
      }, options.timeoutMs ?? CANONICAL_CHAT_SYNC_TIMEOUT_MS);
      (timer as typeof timer & { unref?: () => void }).unref?.();
      pending.set(requestId, { ownerWebContentsId, timer, resolve });
      try {
        renderer.send(CANONICAL_CHAT_SYNC_REQUEST_CHANNEL, payload);
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({
          requestId,
          ok: false,
          code: "stale_source",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  return { request };
}
