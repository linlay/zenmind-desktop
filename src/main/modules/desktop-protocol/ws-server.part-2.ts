import crypto from "node:crypto";

import http from "node:http";

import type { Socket } from "node:net";

import type { AddressInfo } from "node:net";

import type { App } from "electron";

import {
  DESKTOP_WS_NAMESPACE_AGENT_PLATFORM,
  DESKTOP_WS_NAMESPACE_DESKTOP,
  DESKTOP_WS_NAMESPACE_FIELD,
  DESKTOP_WS_NAMESPACE_WEBAPP,
  DESKTOP_WS_NAMESPACES,
  DESKTOP_WS_HOST,
  DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
  DESKTOP_WS_LAN_BIND_HOST,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_WS_PUSH_TYPES,
  DESKTOP_WS_REQUEST_TYPES,
  type DesktopWsPushType
} from "../../../shared/desktop-ws";

import {
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionDefinition
} from "../../../shared/desktop-actions";

import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  DesktopMobileWebappCatalog,
  DesktopWsServerState,
  ServiceState,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueUpdateInput
} from "../../../shared/contracts";


import { getDesktopDeviceId } from "../identity";

import { handleDesktopActionRequest } from "../desktop-actions";

import type { KanbanRuntime } from "../kanban";

import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../agent-platform";

import { AUTH_EXPIRING_THROTTLE_MS, AUTH_EXPIRING_WINDOW_MS, AgentPlatformWsBridge, DIRECT_ACTION_TYPES, DesktopWsAuthSession, DesktopWsConnection, DesktopWsOutboundFrame, DesktopWsProtocolTransport, DesktopWsRequestFrame, DesktopWsServerKind, DesktopWsServerOptions, DesktopWsServerRecord, DesktopWsSessionGroup, HEARTBEAT_INTERVAL_MS, MAX_FRAME_BYTES, activeServers, asRecord, authenticateDesktopWsProtocolSession, createDesktopWsServerRuntimeState, createSessionId, encodeWebSocketFrame, isDesktopWsBindHostSatisfied, listPublicActions, normalizeDesktopWsBindHost, normalizePublicActionName, nowIso, readAuthRefreshReason, readNamespace, readText, readTokenFromRequest, refreshDesktopWsConnectionAuth, sendJson, sendResponse, tunnelSessionGroup, verifyRs256Jwt, writeUpgradeFailure, writeUpgradeSuccess } from "./ws-server.part-1";

export function sendError(
  connection: DesktopWsConnection,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP,
  id: string | undefined,
  type: string,
  code: number,
  msg: string,
  data?: unknown
) {
  sendJson(connection, { ns: namespace, frame: "error", type, id, code, msg, data });
}

export function sendPush(connection: DesktopWsConnection, type: DesktopWsPushType | string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_DESKTOP, frame: "push", type, data });
}

export function closeConnection(connection: DesktopWsConnection, code = 1000, reason = "closed") {
  if (connection.closed) {
    return;
  }
  connection.closed = true;
  connection.agentPlatformBridge?.close();
  connection.agentPlatformBridge = null;
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
  connection.server.connections.delete(connection);
  connection.transport.close(code, reason);
}

export function parseFrames(connection: DesktopWsConnection) {
  const messages: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  const buffer = connection.buffer;
  while (offset + 2 <= buffer.byteLength) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (!fin) {
      throw new Error("fragmented websocket frames are not supported");
    }
    if (payloadLength === 126) {
      if (offset + 4 > buffer.byteLength) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.byteLength) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(MAX_FRAME_BYTES)) {
        throw new Error("websocket frame is too large");
      }
      payloadLength = Number(longLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.byteLength) break;
    if (payloadLength > MAX_FRAME_BYTES) {
      throw new Error("websocket frame is too large");
    }
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    messages.push({ opcode, payload });
    offset += frameLength;
  }
  connection.buffer = buffer.subarray(offset);
  return messages;
}

export function actionPayload(action: string, payload: unknown): DesktopActionCallRequest {
  const record = asRecord(payload);
  return {
    requestId: readText(record.requestId),
    action: normalizePublicActionName(readText(record.action) || action),
    args: asRecord(record.args),
    source: asRecord(record.source),
    permissionMode: readText(record.permissionMode) as DesktopActionCallRequest["permissionMode"],
    expectedPageKey: readText(record.expectedPageKey)
  };
}

export async function callDesktopAction(options: DesktopWsServerOptions, action: string, payload: unknown): Promise<DesktopActionCallResponse> {
  return handleDesktopActionRequest(options.desktopActionOptions, actionPayload(action, payload));
}

export function getKanbanRuntime(options: DesktopWsServerOptions) {
  const runtime = options.getKanbanRuntime();
  if (!runtime) {
    throw new Error("Kanban runtime is not initialized");
  }
  return runtime;
}

export function readIssueId(payload: unknown) {
  const record = asRecord(payload);
  return readText(record.id) || readText(record.issueId);
}

export function readIssueCreateInput(payload: unknown): KanbanIssueInput {
  const record = asRecord(payload);
  const nested = asRecord(record.input);
  return (Object.keys(nested).length > 0 ? nested : record) as unknown as KanbanIssueInput;
}

export function readIssueUpdateInput(payload: unknown): { issueId: string; input: KanbanIssueUpdateInput } {
  const record = asRecord(payload);
  return {
    issueId: readIssueId(record),
    input: asRecord(record.input) as unknown as KanbanIssueUpdateInput
  };
}

export function readIssueMoveInput(payload: unknown): KanbanIssueMoveInput {
  return asRecord(payload) as unknown as KanbanIssueMoveInput;
}

export function unsupported(type: string) {
  return {
    code: "unsupported",
    message: `${type} is reserved but not implemented in Desktop WS v1.`
  };
}

export async function handleRequest(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  req: DesktopWsRequestFrame,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP
) {
  const type = readText(req.type);
  const id = readText(req.id);
  if (!type || !id) {
    sendError(connection, namespace, id || undefined, "invalid_request", 400, "request type and id are required");
    return;
  }
  if (!DESKTOP_WS_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, namespace, id, "invalid_request", 400, `unknown type: ${type}`);
    return;
  }
  if (!DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, namespace, id, "unsupported", 501, unsupported(type).message, unsupported(type));
    return;
  }

  const payload = req.payload;
  switch (type) {
    case "session.hello":
      sendResponse(connection, namespace, type, id, {
        sessionId: connection.id,
        protocolVersion: 1,
        server: "desktop-ws",
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        defaultNamespace: DESKTOP_WS_NAMESPACE_DESKTOP,
        namespaces: DESKTOP_WS_NAMESPACES,
        deviceId: getDesktopDeviceId(options.app),
        auth: {
          subject: connection.auth.subject,
          deviceId: connection.auth.deviceId,
          scope: connection.auth.scope,
          expiresAt: connection.auth.expiresAt
        },
        requestTypes: DESKTOP_WS_REQUEST_TYPES,
        pushTypes: DESKTOP_WS_PUSH_TYPES
      });
      return;
    case "auth.refresh": {
      const payloadRecord = asRecord(payload);
      const token = readText(payloadRecord.token);
      if (token) {
        try {
          connection.auth = await authenticateDesktopWsProtocolSession(options, token, connection.auth.subprotocol);
          sendResponse(connection, namespace, type, id, { token, expiresAt: connection.auth.expiresAt });
        } catch {
          sendError(connection, namespace, id, "unauthorized", 401, "invalid token");
        }
        return;
      }
      try {
        const refreshed = await refreshDesktopWsConnectionAuth(options, connection, readAuthRefreshReason(payloadRecord));
        sendResponse(connection, namespace, type, id, { token: refreshed.token, expiresAt: refreshed.auth.expiresAt });
      } catch {
        sendError(connection, namespace, id, "auth_refresh_failed", 503, "token refresh failed");
      }
      return;
    }
    case "capability.list":
      sendResponse(connection, namespace, type, id, {
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        defaultNamespace: DESKTOP_WS_NAMESPACE_DESKTOP,
        namespaces: DESKTOP_WS_NAMESPACES,
        requestTypes: DESKTOP_WS_REQUEST_TYPES,
        implementedRequestTypes: DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
        pushTypes: DESKTOP_WS_PUSH_TYPES,
        actions: listPublicActions()
      });
      return;
    case "event.subscribe": {
      const types = Array.isArray(asRecord(payload).types)
        ? (asRecord(payload).types as unknown[]).map(readText).filter(Boolean)
        : [];
      for (const nextType of types) {
        connection.subscriptions.add(nextType);
      }
      sendResponse(connection, namespace, type, id, { types: [...connection.subscriptions] });
      return;
    }
    case "event.unsubscribe": {
      const types = Array.isArray(asRecord(payload).types)
        ? (asRecord(payload).types as unknown[]).map(readText).filter(Boolean)
        : [];
      if (types.length === 0) {
        connection.subscriptions.clear();
      } else {
        for (const nextType of types) {
          connection.subscriptions.delete(nextType);
        }
      }
      sendResponse(connection, namespace, type, id, { types: [...connection.subscriptions] });
      return;
    }
    case "action.list":
      sendResponse(connection, namespace, type, id, { actions: listPublicActions() });
      return;
    case "action.call": {
      const response = await callDesktopAction(options, "", payload);
      if (!response.ok) {
        sendError(connection, namespace, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, namespace, type, id, response);
      return;
    }
    case "snapshot.get":
      sendResponse(connection, namespace, type, id, getKanbanRuntime(options).listIssues());
      return;
    case "webapp.list":
      if (!options.listMobileWebapps) {
        sendError(connection, namespace, id, "webapp_catalog_unavailable", 503, "WebApp catalog is not available.");
        return;
      }
      sendResponse(connection, namespace, type, id, options.listMobileWebapps());
      return;
    case "issue.create":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).createIssue(readIssueCreateInput(payload)));
      return;
    case "issue.update": {
      const update = readIssueUpdateInput(payload);
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).updateIssue(update.issueId, update.input));
      return;
    }
    case "issue.delete":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).deleteIssueWithAutomation(readIssueId(payload)));
      return;
    case "issue.move":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).moveIssue(readIssueMoveInput(payload)));
      return;
    case "device.status":
      sendResponse(connection, namespace, type, id, {
        deviceId: getDesktopDeviceId(options.app),
        serverTime: nowIso(),
        connectionCount: connection.server.connections.size
      });
      return;
    case "runtime.info":
      sendResponse(connection, namespace, type, id, options.desktopActionOptions.getDesktopAppInfo());
      return;
    case "assistant.startRun":
      sendResponse(connection, namespace, type, id, await options.assistantBridge.startRun(asRecord(payload) as unknown as AssistantStartRunRequest));
      return;
    case "service.list":
    case "service.get":
    case "service.status": {
      const response = await callDesktopAction(options, type, { args: asRecord(payload) });
      if (!response.ok) {
        sendError(connection, namespace, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, namespace, type, id, response.result ?? response.preview ?? response);
      return;
    }
    default:
      if (DIRECT_ACTION_TYPES.has(type)) {
        const response = await callDesktopAction(options, type, { args: asRecord(payload) });
        sendResponse(connection, namespace, type, id, response);
        return;
      }
      sendError(connection, namespace, id, "unsupported", 501, unsupported(type).message, unsupported(type));
  }
}

export function handleTextMessage(options: DesktopWsServerOptions, connection: DesktopWsConnection, text: string) {
  let parsed: DesktopWsRequestFrame;
  try {
    parsed = JSON.parse(text) as DesktopWsRequestFrame;
  } catch {
    sendError(connection, DESKTOP_WS_NAMESPACE_DESKTOP, undefined, "invalid_request", 400, "invalid JSON frame");
    return;
  }
  const namespace = readNamespace(parsed);
  if (
    namespace !== DESKTOP_WS_NAMESPACE_DESKTOP &&
    namespace !== DESKTOP_WS_NAMESPACE_AGENT_PLATFORM &&
    namespace !== DESKTOP_WS_NAMESPACE_WEBAPP
  ) {
    sendError(
      connection,
      DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "invalid_namespace",
      400,
      `unknown namespace: ${namespace}`,
      {
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        namespaces: DESKTOP_WS_NAMESPACES
      }
    );
    return;
  }
  if (parsed.frame !== "request") {
    sendError(
      connection,
      namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "invalid_request",
      400,
      "only request frames are accepted"
    );
    return;
  }
  if (namespace === DESKTOP_WS_NAMESPACE_AGENT_PLATFORM) {
    if (!connection.agentPlatformBridge) {
      connection.agentPlatformBridge = new AgentPlatformWsBridge(options, connection, connection.server.logger);
    }
    void connection.agentPlatformBridge.forwardRequest(parsed);
    return;
  }
  void handleRequest(
    options,
    connection,
    parsed,
    namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP
  ).catch((error) => {
    sendError(
      connection,
      namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "internal_error",
      500,
      error instanceof Error ? error.message : String(error)
    );
  });
}

export type DesktopWsProtocolSessionCreateInput = {
  authToken: string;
  subprotocol?: string;
  source?: string;
  clientDeviceId?: string;
  onAuthenticated?: (auth: DesktopWsAuthSession) => Promise<void> | void;
  transport: DesktopWsProtocolTransport;
};

export type BindDesktopWsProtocolSessionInput = {
  auth: DesktopWsAuthSession;
  source?: string;
  clientDeviceId?: string;
  transport: DesktopWsProtocolTransport;
};

export class DesktopWsProtocolSession {
  constructor(
    private readonly options: DesktopWsServerOptions,
    private readonly connection: DesktopWsConnection
  ) {}

  receiveTextFrame(text: string) {
    handleTextMessage(this.options, this.connection, text);
  }

  close(code = 1000, reason = "closed") {
    closeConnection(this.connection, code, reason);
  }

  get id() {
    return this.connection.id;
  }
}

export function bindProtocolSession(
  group: DesktopWsSessionGroup,
  options: DesktopWsServerOptions,
  input: BindDesktopWsProtocolSessionInput
) {
  group.logger = options.logger || console;
  const connection: DesktopWsConnection = {
    id: createSessionId(),
    server: group,
    auth: input.auth,
    source: readText(input.source),
    clientDeviceId: readText(input.clientDeviceId),
    buffer: Buffer.alloc(0),
    subscriptions: new Set(),
    closed: false,
    heartbeatTimer: null,
    authRefresh: null,
    agentPlatformBridge: null,
    transport: input.transport
  };
  group.connections.add(connection);
  sendPush(connection, "connected", { sessionId: connection.id });
  let lastAuthExpiringAt = 0;
  connection.heartbeatTimer = setInterval(() => {
    sendPush(connection, "heartbeat", { timestamp: new Date().toISOString() });
    if (connection.auth.expiresAt <= Date.now() + AUTH_EXPIRING_WINDOW_MS && Date.now() - lastAuthExpiringAt > AUTH_EXPIRING_THROTTLE_MS) {
      lastAuthExpiringAt = Date.now();
      sendPush(connection, "auth.expiring", { expiresAt: connection.auth.expiresAt });
    }
  }, HEARTBEAT_INTERVAL_MS);
  return {
    connection,
    session: new DesktopWsProtocolSession(options, connection)
  };
}

export async function createDesktopWsProtocolSession(
  options: DesktopWsServerOptions,
  input: DesktopWsProtocolSessionCreateInput
) {
  const authToken = readText(input.authToken);
  if (!authToken) {
    throw new Error("authToken is required");
  }
  const auth = await authenticateDesktopWsProtocolSession(options, authToken, input.subprotocol);
  await input.onAuthenticated?.(auth);
  return bindProtocolSession(tunnelSessionGroup, options, {
    auth,
    source: input.source,
    clientDeviceId: input.clientDeviceId,
    transport: input.transport
  }).session;
}

export function closeSocketWithFrame(socket: Socket, code = 1000, reason = "closed") {
  if (socket.destroyed) {
    return;
  }
  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.byteLength);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    socket.end(encodeWebSocketFrame(0x8, payload));
  } catch {
    socket.destroy();
  }
}

export function bindSocketConnection(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket, auth: DesktopWsAuthSession) {
  const parsed = new URL(req.url || "/", `http://${record.host}:${record.port}`);
  const { connection, session } = bindProtocolSession(record, options, {
    auth,
    source: readText(parsed.searchParams.get("source")),
    clientDeviceId: readText(parsed.searchParams.get("deviceId")) || readText(parsed.searchParams.get("device_id")),
    transport: {
      sendText(text) {
        if (!socket.destroyed) {
          socket.write(encodeWebSocketFrame(0x1, Buffer.from(text, "utf8")));
        }
      },
      close(code, reason) {
        closeSocketWithFrame(socket, code, reason);
      }
    }
  });
  socket.on("data", (chunk) => {
    try {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      const frames = parseFrames(connection);
      for (const frame of frames) {
        if (frame.opcode === 0x1) {
          session.receiveTextFrame(frame.payload.toString("utf8"));
        } else if (frame.opcode === 0x8) {
          session.close();
        } else if (frame.opcode === 0x9) {
          socket.write(encodeWebSocketFrame(0xA, frame.payload));
        }
      }
    } catch (error) {
      record.logger.warn?.(`[desktop-ws] closing invalid websocket frame: ${error instanceof Error ? error.message : String(error)}`);
      session.close(1002, "protocol error");
    }
  });
  socket.on("close", () => session.close());
  socket.on("error", () => session.close());
}

export async function handleUpgrade(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket) {
  const parsed = new URL(req.url || "/", `http://${record.host}:${record.port}`);
  if (parsed.pathname !== DESKTOP_WS_PATH) {
    writeUpgradeFailure(socket, 404, "Not Found");
    return;
  }
  const tokenInfo = readTokenFromRequest(req);
  if (!tokenInfo) {
    writeUpgradeFailure(socket, 401, "Unauthorized");
    return;
  }
  try {
    const auth = await authenticateDesktopWsProtocolSession(options, tokenInfo.token, tokenInfo.subprotocol);
    writeUpgradeSuccess(socket, req, tokenInfo.subprotocol);
    bindSocketConnection(record, options, req, socket, auth);
  } catch (error) {
    record.logger.warn?.(`[desktop-ws] unauthorized websocket upgrade: ${error instanceof Error ? error.message : String(error)}`);
    writeUpgradeFailure(socket, 401, "Unauthorized");
  }
}

export async function startDesktopWsServerInstance(
  kind: DesktopWsServerKind,
  options: DesktopWsServerOptions,
  defaultPort: number
) {
  const host = normalizeDesktopWsBindHost(options.host);
  const logger = options.logger || console;
  const activeServer = activeServers.get(kind) ?? null;
  if (activeServer) {
    if (isDesktopWsBindHostSatisfied(activeServer.host, host)) {
      const runtimeState = createDesktopWsServerRuntimeState(activeServer, defaultPort);
      return {
        ...runtimeState,
        webSocketUrl: runtimeState.url
      };
    }
    await stopDesktopWsServerInstance(kind);
  }
  const port = options.port ?? defaultPort;
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Desktop WS Server only accepts WebSocket upgrades on /ws.");
  });
  const record: DesktopWsServerRecord = {
    kind,
    server,
    host,
    port,
    connections: new Set(),
    logger,
    startedAt: nowIso()
  };
  server.on("upgrade", (req, socket) => {
    const wsSocket = socket as Socket;
    void handleUpgrade(record, options, req, wsSocket).catch((error) => {
      logger.warn?.(`[desktop-ws] upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
      writeUpgradeFailure(wsSocket, 500, "Internal Server Error");
    });
  });
  server.on("error", (error) => {
    logger.warn?.(`[desktop-ws] failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
  const address = server.address() as AddressInfo | null;
  record.port = address?.port ?? port;
  activeServers.set(kind, record);
  logger.log?.(`[desktop-ws:${kind}] listening on ${host}:${record.port}`);
  const runtimeState = createDesktopWsServerRuntimeState(record, defaultPort);
  return {
    ...runtimeState,
    webSocketUrl: runtimeState.url
  };
}

export function startDesktopWsServer(options: DesktopWsServerOptions) {
  return startDesktopWsServerInstance("debug", options, DESKTOP_WS_PORT);
}

export function getDesktopWsServerRuntimeState() {
  return createDesktopWsServerRuntimeState(activeServers.get("debug") ?? null, DESKTOP_WS_PORT);
}

export function emitDesktopWsPush(type: DesktopWsPushType | string, data?: unknown) {
  for (const record of [...activeServers.values(), tunnelSessionGroup]) {
    for (const connection of record.connections) {
      if (connection.subscriptions.has(type)) {
        sendPush(connection, type, data);
      }
    }
  }
}

export function hasTunnelDesktopWsSubscriber(type: DesktopWsPushType | string) {
  const now = Date.now();
  return [...tunnelSessionGroup.connections].some((connection) =>
    !connection.closed &&
    connection.auth.scope === "app" &&
    connection.auth.expiresAt > now &&
    Boolean(connection.auth.deviceId) &&
    connection.subscriptions.has(type)
  );
}

export function stopDesktopWsServerInstance(kind: DesktopWsServerKind) {
  const record = activeServers.get(kind) ?? null;
  activeServers.delete(kind);
  if (!record) {
    return Promise.resolve();
  }
  for (const connection of [...record.connections]) {
    closeConnection(connection, 1001, "server stopping");
  }
  return new Promise<void>((resolve) => {
    record.server.close(() => resolve());
  });
}

export function stopDesktopWsServer() {
  return stopDesktopWsServerInstance("debug");
}

export const __testInternals = {
  encodeWebSocketFrame,
  parseFrames,
  normalizePublicActionName,
  verifyRs256Jwt,
  listPublicActions,
  startDesktopWsServerInstance,
  stopDesktopWsServerInstance
};
