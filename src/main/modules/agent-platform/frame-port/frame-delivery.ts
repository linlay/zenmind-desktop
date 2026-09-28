import {
  AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL,
  isPlainBridgeRecord,
  type AgentPlatformRequestFrame,
  type AgentWebclientPlatformFramePortEvent,
  type DesktopPlatformConnectionState,
} from "../../../../shared/contracts";
import type { FramePortOptions } from "../ipc.shared";
import { LogicalSession, PlatformFrameRecord, StreamBinding, readText } from "../ipc.shared";
import { RealtimeBroker } from "../realtime/realtime-broker";

export interface FrameDeliveryPort {
  developmentDiagnosticsEnabled: boolean;
  readonly options: {
    browserSurfaces: Pick<FramePortOptions["browserSurfaces"], "resolveWebviewSurfaceTarget">;
    realtimeBroker: Pick<FramePortOptions["realtimeBroker"], "appendDebugTrace">;
  };
}



export function createFrameDelivery(deps: FrameDeliveryPort) {
  function reportChatLoadDiagnostic(stage: "request" | "response", session: LogicalSession, details: Record<string, unknown>): void {
    if (!deps.developmentDiagnosticsEnabled)
      return;
    console.debug("[agent-webclient-chat-load]", {
      stage,
      sessionId: session.sessionId,
      logicalGeneration: session.logicalGeneration,
      physicalGeneration: session.physicalGeneration,
      surfaceId: session.surfaceId,
      webContentsId: session.sender.id,
      ...details,
    });
  }

  function sendEvent(session: LogicalSession, event: AgentWebclientPlatformFramePortEvent): void {
    if (session.closed || session.sender.isDestroyed())
      return;
    session.sender.send(AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_EVENT_CHANNEL, event);
    const target = deps.options.browserSurfaces.resolveWebviewSurfaceTarget(session.sender.id);
    deps.options.realtimeBroker.appendDebugTrace({
      layer: "surface-bridge",
      direction: "desktop-to-surface",
      data: event,
      surfaceId: target?.surfaceId,
      webContentsId: session.sender.id,
      surfaceKind: target?.surfaceType,
      surfaceRole: target?.surfaceRole,
      surfaceLevel: target?.surfaceLevel,
      parentSurfaceId: target?.parentSurfaceId,
      interaction: target?.interaction,
      route: target?.pageRoute || session.sender.getURL(),
    });
  }

  function sendFrame(session: LogicalSession, frame: PlatformFrameRecord): void {
    const requestId = readText(frame.id);
    if (frame.frame === "response" || frame.frame === "error") {
      const diagnostic = session.loadDiagnostics.get(requestId);
      diagnostic?.end(frame.frame === "error" || (typeof frame.code === "number" && frame.code !== 0)
        ? "failed" : "succeeded", typeof frame.code === "number" ? frame.code : undefined);
      session.loadDiagnostics.delete(requestId);
    }
    const chatLoad = requestId ? session.chatLoadRequests.get(requestId) : null;
    if (chatLoad) {
      const data = isPlainBridgeRecord(frame.data) ? frame.data : {};
      const nestedData = isPlainBridgeRecord(data.data) ? data.data : {};
      const responseChatId = readText(data.chatId) || readText(nestedData.chatId);
      reportChatLoadDiagnostic("response", session, {
        requestId,
        requestedChatId: chatLoad.chatId,
        responseChatId,
        frame: readText(frame.frame),
        type: readText(frame.type),
        code: typeof frame.code === "number" ? frame.code : undefined,
        elapsedMs: Date.now() - chatLoad.startedAt,
      });
      if (readText(frame.frame) === "response" || readText(frame.frame) === "error") {
        session.chatLoadRequests.delete(requestId);
      }
    }
    sendEvent(session, {
      sessionId: session.sessionId,
      type: "frame",
      frame: frame as Exclude<import("../../../../shared/contracts").AgentPlatformRealtimeFrame, AgentPlatformRequestFrame>,
    });
  }

  function sendRunEvent(session: LogicalSession, binding: StreamBinding, runEvent: Record<string, unknown>): void {
    const seq = Number(runEvent.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) {
      binding.lastSeq = Math.max(binding.lastSeq, seq);
    }
    sendFrame(session, {
      frame: "stream",
      id: binding.localId,
      event: runEvent,
    });
  }

  function framePortState(session: LogicalSession, state: ReturnType<RealtimeBroker["getConnectionState"]>): DesktopPlatformConnectionState {
    const phase = state.phase === "connected" ? "connected"
      : state.phase === "reconnecting" || state.phase === "error" ? "reconnecting"
        : state.phase === "closed" || state.phase === "closing" ? "closed"
          : "connecting";
    session.phase = phase;
    session.physicalGeneration = state.generation;
    session.reconnectCount = state.reconnectCount;
    return {
      phase,
      logicalGeneration: session.logicalGeneration,
      physicalGeneration: state.generation,
      reconnectCount: state.reconnectCount,
      retryable: phase === "connecting" || phase === "reconnecting",
      ...(state.physicalSessionId ? { physicalSessionId: state.physicalSessionId } : {}),
      ...(state.lastInboundAt ? { lastInboundAt: state.lastInboundAt } : {}),
      ...(state.lastHeartbeatAt ? { lastHeartbeatAt: state.lastHeartbeatAt } : {}),
      ...(state.lastError ? {
        error: {
          code: phase === "reconnecting" ? "PLATFORM_CONNECTION_UNAVAILABLE" : "DESKTOP_FRAME_PORT_CLOSED",
          message: state.lastError,
        },
      } : {}),
    };
  }
  return { reportChatLoadDiagnostic, sendEvent, sendFrame, sendRunEvent, framePortState };
}
