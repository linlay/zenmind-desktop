import { randomUUID } from "node:crypto";
import { type AgentWebclientRunOwner } from "../../../../shared/contracts";
import { desktopActionErrorStatus } from "../../../../shared/desktop-action-diagnostics";
import { getDesktopActionDefinition } from "../../../../shared/desktop-actions";
import { AgentPlatformRealtimeClient, type AgentPlatformRealtimeFrame } from "./agent-platform-realtime-client";
import {
  BrokerRun,
  DESKTOP_AWCP_INVOKE_TYPE,
  DESKTOP_AWCP_MANUAL_TYPE,
  DESKTOP_CDP_REQUEST_TYPE,
  DESKTOP_MAX_RESPONSE_BYTES,
  DESKTOP_RESPONSE_DELTA_EVENT_TYPE,
  DESKTOP_SCREENSHOT_CHUNK_CHARS,
  DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE,
  DESKTOP_STREAM_RAW_CHUNK_BYTES,
  DesktopBridgeRequestProvider,
  RealtimeLane,
  RunActionGrant,
  brokerError,
  isRecord,
  readText,
  sameRunOwner,
} from "./realtime-broker.shared";
import { type RunSiteControlGrants } from "./run-site-control-grants";

/** Dependencies limited to desktop requests; state remains owned by the Broker. */
export interface DesktopRequestsPort {
  desktopBridgeProvider: DesktopBridgeRequestProvider | null;
  runActionGrants: Map<string, RunActionGrant>;
  siteControlGrants: RunSiteControlGrants;
  clients: Record<RealtimeLane, AgentPlatformRealtimeClient>;
  inboundDesktopRequests: Map<string, AbortController>;
  seenInboundDesktopRequestIds: Set<string>;
  getRunChannel(runIdValue: string, lane?: RealtimeLane): BrokerRun | undefined;
}

export function createDesktopRequests(deps: DesktopRequestsPort) {
  function setDesktopBridgeProvider(provider: DesktopBridgeRequestProvider | null): void {
    deps.desktopBridgeProvider = provider;
  }

  function registerRunActionGrant(input: {
    sourceId: string;
    chatId: string;
    runId: string;
    owner: AgentWebclientRunOwner;
    ready: Promise<void>;
    replaceExisting?: boolean;
  }): void {
    const sourceId = input.sourceId.trim();
    const chatId = input.chatId.trim();
    const runId = input.runId.trim();
    if (!sourceId || !chatId || !runId) {
      throw brokerError("invalid_request", "canonical Run WorkPanel grant identity is incomplete");
    }
    const existing = deps.runActionGrants.get(runId);
    if (existing && (existing.chatId !== chatId ||
      !sameRunOwner(existing.owner, input.owner))) {
      throw brokerError("duplicate_id", "canonical Run WorkPanel grant identity conflicts");
    }
    if (existing && input.replaceExisting === false)
      return;
    const generation = (existing?.generation ?? 0) + 1;
    let supersede: () => void = () => undefined;
    const superseded = new Promise<void>((resolve) => {
      supersede = resolve;
    });
    const grant: RunActionGrant = {
      sourceId,
      chatId,
      runId,
      owner: input.owner,
      generation,
      state: "pending",
      failureMessage: "",
      ready: Promise.resolve(),
      superseded,
      supersede,
    };
    grant.ready = input.ready.then(() => {
      const current = deps.runActionGrants.get(runId);
      if (current !== grant || current.generation !== generation)
        return;
      current.state = "ready";
      current.failureMessage = "";
    }, (error) => {
      const current = deps.runActionGrants.get(runId);
      if (current === grant && current.generation === generation) {
        current.state = "failed";
        current.failureMessage = error instanceof Error ? error.message : String(error);
      }
      throw error;
    });
    void grant.ready.catch(() => undefined);
    existing?.supersede();
    deps.runActionGrants.set(runId, grant);
    while (deps.runActionGrants.size > 2000) {
      const oldest = deps.runActionGrants.keys().next().value as string | undefined;
      if (!oldest)
        break;
      revokeRunActionGrant(oldest);
    }
  }

  function revokeRunActionGrant(runIdValue: string): boolean {
    const runId = runIdValue.trim();
    if (!runId)
      return false;
    const grant = deps.runActionGrants.get(runId);
    if (!grant)
      return false;
    deps.runActionGrants.delete(runId);
    grant.supersede();
    return true;
  }

  function clearRunActionGrants(): void {
    deps.siteControlGrants.revokeAll();
    for (const grant of deps.runActionGrants.values())
      grant.supersede();
    deps.runActionGrants.clear();
  }

  function handleInboundRequest(lane: RealtimeLane, frame: AgentPlatformRealtimeFrame): void {
    const id = readText(frame.id);
    if (!id)
      return;
    const type = readText(frame.type);
    if (lane === "primary" &&
      (getDesktopActionDefinition(type) || type === DESKTOP_AWCP_MANUAL_TYPE || type === DESKTOP_AWCP_INVOKE_TYPE || type === DESKTOP_CDP_REQUEST_TYPE)) {
      void handleDesktopBridgeRequest(id, type, frame);
      return;
    }
    const errorType = lane === "primary" ? "unsupported_in_current_view" : "unknown_request_type";
    try {
      deps.clients[lane].send({
        frame: "error",
        type: errorType,
        id,
        code: 409,
        msg: lane === "primary"
          ? "Desktop cannot handle this request in the current view"
          : lane === "btw"
            ? "Desktop BTW lane does not support inbound requests"
            : "Desktop selection explanation lane does not support inbound requests",
        data: {
          code: errorType,
          message: lane === "primary"
            ? "Inbound request is unsupported in the current view"
            : "Inbound request type is unknown",
        },
      });
    }
    catch {
      // The connection is already unavailable.
    }
  }

  async function handleDesktopBridgeRequest(id: string, type: string, frame: AgentPlatformRealtimeFrame): Promise<void> {
    if (deps.inboundDesktopRequests.has(id) || deps.seenInboundDesktopRequestIds.has(id)) {
      sendDesktopBridgeError(id, "duplicate_id", 409, "Desktop bridge request id was already used");
      return;
    }
    deps.seenInboundDesktopRequestIds.add(id);
    if (deps.seenInboundDesktopRequestIds.size > 2000) {
      deps.seenInboundDesktopRequestIds.delete(deps.seenInboundDesktopRequestIds.values().next().value as string);
    }
    const provider = deps.desktopBridgeProvider;
    if (!provider) {
      sendDesktopBridgeError(id, "desktop_provider_unavailable", 503, "Desktop bridge provider is unavailable");
      return;
    }
    if (!isRecord(frame.payload)) {
      sendDesktopBridgeError(id, "invalid_request", 400, "Desktop bridge payload must be an object");
      return;
    }
    const controller = new AbortController();
    deps.inboundDesktopRequests.set(id, controller);
    try {
      const isCdp = type === DESKTOP_CDP_REQUEST_TYPE;
      const isAwcpManual = type === DESKTOP_AWCP_MANUAL_TYPE;
      const isAwcpInvoke = type === DESKTOP_AWCP_INVOKE_TYPE;
      const isAwcp = isAwcpManual || isAwcpInvoke;
      const isDesktopAction = !isCdp && !isAwcp;
      if (isAwcpManual) {
        const keys = Object.keys(frame.payload).filter((key) => key !== "surfaceId");
        const isIndexRequest = keys.length === 0;
        const isSectionRequest = keys.sort().join(",") === "revision,section" &&
          typeof frame.payload.section === "string" && typeof frame.payload.revision === "string";
        if (!isIndexRequest && !isSectionRequest) {
          throw brokerError("protocol_error", "AWCP manual payload accepts section and revision together, plus an optional surfaceId");
        }
      }
      let actionRequest: Record<string, unknown> | null = null;
      let actionSource: Record<string, unknown> = {};
      if (!isCdp) {
        const source = isRecord(frame.source) ? frame.source : {};
        const runId = readText(source.runId);
        const chatId = readText(source.chatId);
        const agentKey = readText(source.agentKey);
        const teamId = readText(source.teamId);
        if (!runId || !chatId || (agentKey && teamId)) {
          throw brokerError("protocol_error", "Desktop Action source must include runId and chatId and at most one Run owner");
        }
        await awaitRunActionReadiness(type, source, controller.signal);
        if (type.startsWith("desktop.web.") && !deps.siteControlGrants.resolve(source)) {
          await awaitRunActionReadiness("desktop.workpanel.getState", source, controller.signal);
        }
        if (controller.signal.aborted)
          return;
        actionSource = source;
        if (isDesktopAction) {
          actionRequest = {
            requestId: id,
            action: type,
            args: frame.payload,
            source,
          };
        }
      }
      const cdpSource = isCdp && isRecord(frame.payload.source) ? frame.payload.source : {};
      if (isCdp && (!readText(cdpSource.runId) || !readText(cdpSource.chatId) ||
        Boolean(readText(cdpSource.agentKey)) === Boolean(readText(cdpSource.teamId)))) {
        throw brokerError("protocol_error", "CDP source must include Run, Chat and exactly one owner");
      }
      let result: unknown;
      if (isAwcpManual || isAwcpInvoke) {
        let scope = deps.siteControlGrants.resolve(actionSource);
        const { surfaceId, ...awcpPayload } = frame.payload;
        if (surfaceId !== undefined && (typeof surfaceId !== "string" || !surfaceId.trim())) throw brokerError("protocol_error", "Invalid AWCP surfaceId");
        if (!scope) {
          await awaitRunActionReadiness("desktop.workpanel.getState", actionSource, controller.signal);
          if (controller.signal.aborted) return;
          if (typeof surfaceId !== "string" || !surfaceId.trim()) throw brokerError("protocol_error", "WorkPanel AWCP requires an exact surfaceId");
          scope = deps.siteControlGrants.resolveWorkPanel(actionSource, surfaceId,
            () => provider.acquireWorkPanelAwcpScope(surfaceId, readText(actionSource.chatId)));
        }
        result = isAwcpManual
          ? await provider.awcpManual(id, awcpPayload, scope, controller.signal, surfaceId as string | undefined)
          : await provider.awcpInvoke(id, awcpPayload, scope, controller.signal, surfaceId as string | undefined);
      }
      else if (isDesktopAction) {
        result = await provider.action(actionRequest as Record<string, unknown>, type.startsWith("desktop.web.") ? deps.siteControlGrants.resolve(actionSource) : undefined);
      }
      else {
        const scope = deps.siteControlGrants.resolve(cdpSource);
        if (!scope) await awaitRunActionReadiness("desktop.workpanel.getState", cdpSource, controller.signal);
        result = await provider.cdp(frame.payload, scope, controller.signal);
      }
      if (controller.signal.aborted)
        return;
      if (!isRecord(result)) {
        sendDesktopBridgeError(id, "invalid_desktop_response", 502, "Desktop bridge response must be an object");
        return;
      }
      if (!isAwcp && result.ok !== true) {
        const error = isRecord(result.error) ? result.error : {};
        // Action results are internal DTOs; normalize their diagnostics at the WS boundary.
        const data = isDesktopAction
          ? { action: type, ...(isRecord(error.details) ? { details: error.details } : {}) }
          : result;
        sendDesktopBridgeError(id, readText(error.code) || "desktop_request_failed", isDesktopAction ? desktopActionErrorStatus(isRecord(error.details) ? error.details.category : undefined) : 400, readText(error.message) || "Desktop rejected the request", data);
        return;
      }
      await sendDesktopBridgeSuccess(id, type, result, controller.signal);
    }
    catch (error) {
      if (!controller.signal.aborted) {
        const errorCode = error instanceof Error ? readText((error as Error & { code?: string }).code) || error.name : "";
        if ((type === DESKTOP_AWCP_MANUAL_TYPE || type === DESKTOP_AWCP_INVOKE_TYPE) && errorCode) {
          const statusCode = error instanceof Error && typeof (error as Error & { statusCode?: unknown }).statusCode === "number"
            ? (error as Error & { statusCode: number }).statusCode
            : errorCode === "site_control_unavailable" ? 409 : 502;
          const details = error instanceof Error && isRecord((error as Error & { details?: unknown }).details)
            ? (error as Error & { details: Record<string, unknown> }).details
            : undefined;
          sendDesktopBridgeError(id, errorCode, statusCode, error instanceof Error ? error.message : String(error), details);
          return;
        }
        if (errorCode === "source_chat_not_ready" || errorCode === "protocol_error" || errorCode === "site_control_unavailable") {
          const brokerFailure = error as Error & {
            retryable?: boolean;
            details?: Record<string, unknown>;
          };
          const failureData = {
            ...(typeof brokerFailure.retryable === "boolean"
              ? { retryable: brokerFailure.retryable }
              : {}),
            ...(brokerFailure.details ? { details: brokerFailure.details } : {}),
          };
          sendDesktopBridgeError(id, errorCode, 409, error instanceof Error ? error.message : String(error), Object.keys(failureData).length > 0 ? failureData : undefined);
          return;
        }
        sendDesktopBridgeError(id, "desktop_request_failed", 500, error instanceof Error ? error.message : String(error));
      }
    }
    finally {
      deps.inboundDesktopRequests.delete(id);
    }
  }

  async function awaitRunActionReadiness(action: string, source: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (!action.startsWith("desktop.workpanel."))
      return;
    const runId = readText(source.runId);
    const chatId = readText(source.chatId);
    if (!runId || !chatId) {
      throw brokerError("protocol_error", "WorkPanel source must include canonical Chat and Run identity");
    }
    const grant = deps.runActionGrants.get(runId);
    if (!grant) {
      const run = deps.getRunChannel(runId);
      if (!run || run.chatId !== chatId || run.terminal) {
        throw brokerError("source_chat_not_ready", "WorkPanel source Run does not have a canonical Chat grant", {
          retryable: false,
          details: { recovery: "reattach_source_chat" },
        });
      }
      if (!run.owner) {
        throw brokerError("protocol_error", "WorkPanel source Run owner is unavailable");
      }
      if (run.owner.kind !== "agent") {
        throw brokerError("source_chat_not_ready", "WorkPanel is unavailable for a Team-owned Run", { retryable: false, details: { recovery: "unsupported_run_owner" } });
      }
      if (readText(source.agentKey) !== run.owner.agentKey) {
        throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its Run owner");
      }
      return;
    }
    if (grant.chatId !== chatId) {
      throw brokerError("protocol_error", "WorkPanel source Chat conflicts with its canonical Run");
    }
    if (grant.owner.kind !== "agent") {
      throw brokerError("source_chat_not_ready", "WorkPanel is unavailable for a Team-owned Run", { retryable: false, details: { recovery: "unsupported_run_owner" } });
    }
    if (readText(source.agentKey) !== grant.owner.agentKey) {
      throw brokerError("protocol_error", "WorkPanel source Agent conflicts with its canonical Run");
    }
    if (grant.state === "failed") {
      throw brokerError("source_chat_not_ready", grant.failureMessage || "canonical Chat synchronization failed", { retryable: false, details: { recovery: "reattach_source_chat" } });
    }
    await Promise.race([
      grant.ready,
      grant.superseded,
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    ]).catch((error) => {
      const current = deps.runActionGrants.get(runId);
      if (current && current.generation !== grant.generation)
        return;
      throw brokerError("source_chat_not_ready", error instanceof Error ? error.message : String(error), { retryable: false, details: { recovery: "reattach_source_chat" } });
    });
    if (signal.aborted)
      return;
    const current = deps.runActionGrants.get(runId);
    if (!current) {
      throw brokerError("source_chat_not_ready", "WorkPanel source Run grant ended before the action was dispatched", { retryable: false, details: { recovery: "run_finished" } });
    }
    if (current.generation !== grant.generation) {
      await awaitRunActionReadiness(action, source, signal);
    }
  }

  async function sendDesktopBridgeSuccess(id: string, type: string, result: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const resultNode = isRecord(result.result) ? result.result : null;
    const screenshot = type === DESKTOP_CDP_REQUEST_TYPE &&
      readText(result.method) === "Page.captureScreenshot" &&
      resultNode && typeof resultNode.data === "string"
      ? resultNode.data.trim()
      : "";
    if (screenshot) {
      const paddingBytes = screenshot.endsWith("==") ? 2 : screenshot.endsWith("=") ? 1 : 0;
      const screenshotBytes = Math.floor((screenshot.length * 3) / 4) - paddingBytes;
      if (screenshotBytes > DESKTOP_MAX_RESPONSE_BYTES) {
        sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop screenshot exceeds 64 MiB");
        return;
      }
      const streamId = `desktop-bridge-${randomUUID()}`;
      let seq = 0;
      for (let offset = 0; offset < screenshot.length; offset += DESKTOP_SCREENSHOT_CHUNK_CHARS) {
        if (signal.aborted)
          return;
        seq += 1;
        sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_SCREENSHOT_DELTA_EVENT_TYPE, screenshot.slice(offset, offset + DESKTOP_SCREENSHOT_CHUNK_CHARS));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (signal.aborted)
        return;
      deps.clients.primary.send({
        frame: "response",
        type,
        id,
        code: 0,
        msg: "success",
        data: {
          ...result,
          result: {
            ...resultNode,
            data: {
              streamed: true,
              streamId,
              encoding: "base64",
              chunkCount: seq,
              totalBytes: screenshotBytes,
            },
          },
        },
      });
      return;
    }
    const serialized = Buffer.from(JSON.stringify(result), "utf8");
    if (serialized.byteLength > DESKTOP_MAX_RESPONSE_BYTES) {
      sendDesktopBridgeError(id, "desktop_response_too_large", 413, "Desktop response exceeds 64 MiB");
      return;
    }
    if (serialized.byteLength <= DESKTOP_STREAM_RAW_CHUNK_BYTES) {
      deps.clients.primary.send({ frame: "response", type, id, code: 0, msg: "success", data: result });
      return;
    }
    const streamId = `desktop-bridge-${randomUUID()}`;
    let seq = 0;
    for (let offset = 0; offset < serialized.byteLength; offset += DESKTOP_STREAM_RAW_CHUNK_BYTES) {
      if (signal.aborted)
        return;
      seq += 1;
      const chunk = serialized.subarray(offset, Math.min(offset + DESKTOP_STREAM_RAW_CHUNK_BYTES, serialized.byteLength));
      sendDesktopBridgeChunk(id, streamId, seq, DESKTOP_RESPONSE_DELTA_EVENT_TYPE, chunk.toString("base64"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal.aborted)
      return;
    deps.clients.primary.send({
      frame: "response",
      type,
      id,
      code: 0,
      msg: "success",
      data: {
        streamed: true,
        streamId,
        encoding: "base64",
        contentType: "application/json",
        chunkCount: seq,
        totalBytes: serialized.byteLength,
      },
    });
  }

  function sendDesktopBridgeChunk(id: string, streamId: string, seq: number, type: string, chunk: string): void {
    deps.clients.primary.send({
      frame: "stream",
      id,
      streamId,
      event: {
        seq,
        type,
        timestamp: Date.now(),
        encoding: "base64",
        chunk,
      },
    });
  }

  function sendDesktopBridgeError(id: string, type: string, code: number, msg: string, data?: unknown): void {
    try {
      deps.clients.primary.send({
        frame: "error",
        type,
        id,
        code,
        msg,
        ...(data === undefined ? {} : { data }),
      });
    }
    catch {
      // The connection is already unavailable.
    }
  }

  return { setDesktopBridgeProvider, registerRunActionGrant, revokeRunActionGrant, clearRunActionGrants, handleInboundRequest, handleDesktopBridgeRequest, awaitRunActionReadiness, sendDesktopBridgeSuccess, sendDesktopBridgeChunk, sendDesktopBridgeError };
}
