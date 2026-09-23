import { isPlainBridgeRecord, type CanonicalChatSyncRequest } from "../../../../shared/contracts";
import { MAIN_CHAT_SURFACE_ID } from "../../../../shared/surface-identity";
import { requireAgentPlatformEpochMillis } from "../../../../shared/time-contract";
import type { FramePortOptions } from "../ipc.shared";
import { PlatformFrameRecord, StreamBinding, protocolError, readOwner, readText, sameOwner } from "../ipc.shared";

export interface QueryBindingPort {
  readonly options: {
    realtimeBroker: Pick<FramePortOptions["realtimeBroker"], "getMainChatRootObserver" | "promoteMainChatRootObserver" | "appendDebugTrace" | "registerRunActionGrant">;
    browserSurfaces: Pick<FramePortOptions["browserSurfaces"], "resolveWebviewSurfaceTarget">;
    syncCanonicalChat: FramePortOptions["syncCanonicalChat"];
  };
}

export function readNormalizedStreamEvent(frame: PlatformFrameRecord): Record<string, unknown> | null {
  if (!isPlainBridgeRecord(frame.event)) return null;
  const rawEvent = frame.event as Record<string, unknown>;
  const { payload, ...eventFields } = rawEvent;
  const payloadFields: Record<string, unknown> = isPlainBridgeRecord(payload) ? payload : {};
  const type = readText(eventFields.type) || readText(payloadFields.type);
  const rawSeq = typeof eventFields.seq === "number" ? eventFields.seq : payloadFields.seq;
  return {
    ...payloadFields,
    ...eventFields,
    ...(type ? { type } : {}),
    ...(typeof rawSeq === "number" ? { seq: rawSeq } : {}),
  };
}

export function updateBindingFromFrame(binding: StreamBinding, frame: PlatformFrameRecord) {
  const event = readNormalizedStreamEvent(frame);
  if (event) {
    binding.chatId = readText(event.chatId) || binding.chatId;
    binding.runId = readText(event.runId) || binding.runId;
    binding.owner = readOwner(event) || binding.owner;
    const seq = Number(event.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) binding.lastSeq = Math.max(binding.lastSeq, seq);
  }
  const lastSeq = Number(frame.lastSeq);
  if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) {
    binding.lastSeq = Math.max(binding.lastSeq, lastSeq);
  }
}

export function createQueryBinding(deps: QueryBindingPort) {
  function establishCanonicalChatIdentity(binding: StreamBinding, chatIdValue: string): void {
    const chatId = chatIdValue.trim();
    if (!chatId)
      throw protocolError("canonical Chat identity is empty");
    if (binding.runStarted)
      throw protocolError("canonical Chat identity arrived after run.start");
    if (binding.canonicalChatId && binding.canonicalChatId !== chatId) {
      throw protocolError("canonical Chat identity conflicts with the current query");
    }
    if (binding.chatId && binding.chatId !== chatId) {
      throw protocolError("canonical Chat identity conflicts with the query source");
    }
    if (binding.suppressed || binding.detachSent) {
      throw protocolError("canonical Chat identity belongs to a stale Main Chat query source");
    }
    binding.canonicalChatId = chatId;
    binding.chatId = chatId;
    const promoteMainChatBundle = () => {
      if (binding.observerToken &&
        deps.options.realtimeBroker.getMainChatRootObserver()?.token === binding.observerToken) {
        deps.options.realtimeBroker.promoteMainChatRootObserver(binding.observerToken, chatId);
      }
    };
    if (!binding.newChatSource || binding.canonicalChatReady) {
      promoteMainChatBundle();
      return;
    }
    const request = {
      sourceId: binding.sourceId,
      surfaceId: MAIN_CHAT_SURFACE_ID,
      registrationId: binding.newChatSource.registrationId,
      guestWebContentsId: binding.newChatSource.guestWebContentsId,
      agentKey: binding.newChatSource.agentKey,
      newChat: binding.newChatSource.newChat,
      chatId,
    } satisfies Omit<CanonicalChatSyncRequest, "requestId">;
    // The outer Desktop identity owns the canonical Chat as soon as
    // chat.start arrives. Guest navigation remains protected separately until
    // WebClient promotes its own live-query URL.
    promoteMainChatBundle();
    const traceCanonicalSync = (state: "ready" | "failed", reason: string) => {
      const target = deps.options.browserSurfaces.resolveWebviewSurfaceTarget(binding.newChatSource!.guestWebContentsId);
      deps.options.realtimeBroker.appendDebugTrace({
        layer: "surface-bridge",
        direction: "desktop-to-surface",
        data: {
          event: "main-chat-canonical-sync",
          state,
          reason,
          generation: binding.newChatSource!.registrationId,
          ownerPresent: Boolean(target?.ownerChatId?.trim()),
          routeKind: target?.ownerChatId?.trim() ? "canonical" : "new-chat",
        },
        surfaceId: MAIN_CHAT_SURFACE_ID,
        webContentsId: binding.newChatSource!.guestWebContentsId,
        surfaceKind: target?.surfaceType,
        surfaceRole: target?.surfaceRole,
        surfaceLevel: target?.surfaceLevel,
        interaction: target?.interaction,
        route: target?.pageRoute,
      });
    };
    const ready = deps.options.syncCanonicalChat(binding.newChatSource.ownerWebContentsId, request).then((result) => {
      if (!result.ok) {
        traceCanonicalSync("failed", result.code);
        throw Object.assign(new Error(result.message), { name: result.code });
      }
      traceCanonicalSync("ready", "canonical_promotion_guard_installed");
    });
    void ready.catch(() => undefined);
    binding.canonicalChatReady = ready;
  }

  function processQueryBootstrapFrame(binding: StreamBinding, upstreamFrame: PlatformFrameRecord): void {
    if (binding.type !== "/api/query")
      return;
    const event = readNormalizedStreamEvent(upstreamFrame);
    if (!event)
      return;
    const type = readText(event.type);
    if (type !== "chat.start" && type !== "request.query" && type !== "run.start")
      return;
    requireAgentPlatformEpochMillis(event.timestamp, `agentWebclient.query[${binding.sourceId}].${type}.timestamp`);
    const chatId = readText(event.chatId);
    if (!chatId)
      throw protocolError(`${type} must include canonical chatId`);
    if (type === "chat.start") {
      const eventOwner = readOwner(event);
      if (eventOwner && binding.expectedOwner && !sameOwner(binding.expectedOwner, eventOwner)) {
        throw protocolError("chat.start owner conflicts with the query owner");
      }
      establishCanonicalChatIdentity(binding, chatId);
      return;
    }
    if (type === "request.query") {
      if (!binding.newChatSource)
        return;
      if (binding.canonicalChatId) {
        if (binding.canonicalChatId !== chatId) {
          throw protocolError("request.query chatId conflicts with the canonical Chat identity");
        }
        return;
      }
      if (!binding.preboundChatId)
        return;
      const requestId = readText(event.requestId);
      const owner = readOwner(event);
      if (!requestId || requestId !== binding.expectedQueryRequestId) {
        throw protocolError("request.query does not match the submitted query requestId");
      }
      if (chatId !== binding.preboundChatId) {
        throw protocolError("request.query chatId conflicts with the submitted canonical Chat");
      }
      if (!owner || (binding.expectedOwner && !sameOwner(binding.expectedOwner, owner))) {
        throw protocolError("request.query owner conflicts with the query owner");
      }
      establishCanonicalChatIdentity(binding, chatId);
      return;
    }
    const runId = readText(event.runId);
    const owner = readOwner(event);
    if (!runId)
      throw protocolError("run.start must include canonical runId");
    if (!owner)
      throw protocolError("run.start must include exactly one Run owner");
    if (binding.expectedOwner && !sameOwner(binding.expectedOwner, owner)) {
      throw protocolError("run.start owner conflicts with the query owner");
    }
    if (binding.newChatSource && !binding.canonicalChatId) {
      throw protocolError("new Chat query requires chat.start or a matching canonical request.query before run.start");
    }
    if (binding.canonicalChatId && binding.canonicalChatId !== chatId) {
      throw protocolError("run.start chatId conflicts with the canonical Chat identity");
    }
    if (binding.chatId && binding.chatId !== chatId) {
      throw protocolError("run.start chatId conflicts with the query source");
    }
    if (binding.suppressed || binding.detachSent) {
      throw protocolError("run.start belongs to a stale Main Chat query source");
    }
    if (binding.runStarted) {
      if (binding.runId !== runId || !sameOwner(binding.owner, owner)) {
        throw protocolError("run.start conflicts with the registered Run");
      }
      return;
    }
    const ready = binding.canonicalChatReady ?? Promise.resolve();
    deps.options.realtimeBroker.registerRunActionGrant({
      sourceId: binding.observerToken || binding.sourceId,
      chatId,
      runId,
      owner,
      ready,
    });
    binding.chatId = chatId;
    binding.runId = runId;
    binding.owner = owner;
    binding.runStarted = true;
  }
  return { establishCanonicalChatIdentity, processQueryBootstrapFrame };
}
