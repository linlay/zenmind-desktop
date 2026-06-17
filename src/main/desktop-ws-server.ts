import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { App } from "electron";
import {
  DESKTOP_WS_HOST,
  DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
  DESKTOP_WS_PATH,
  DESKTOP_WS_PORT,
  DESKTOP_WS_PUSH_TYPES,
  DESKTOP_WS_REQUEST_TYPES,
  type DesktopWsPushType
} from "../shared/desktop-ws";
import {
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionDefinition
} from "../shared/desktop-actions";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  TaskBoardIssueInput,
  TaskBoardIssueMoveInput,
  TaskBoardIssueUpdateInput
} from "../shared/contracts";
import { resolveDesktopAppInfo } from "./app-metadata";
import { ensureAppServerJwk } from "./app-server-auth";
import { getDesktopDeviceId } from "./device-identity";
import { handleDesktopActionRequest } from "./desktop-action-bridge";
import type { TaskBoardRuntime } from "./task-board-runtime";

type DesktopWsAuthSession = {
  subject: string;
  deviceId: string;
  expiresAt: number;
  scope: string;
  subprotocol?: string;
};

type DesktopWsRequestFrame = {
  frame?: string;
  type?: string;
  id?: string;
  payload?: unknown;
};

type DesktopWsResponseFrame = {
  frame: "response";
  type: string;
  id: string;
  code: number;
  msg: string;
  data?: unknown;
};

type DesktopWsErrorFrame = {
  frame: "error";
  type: string;
  id?: string;
  code: number;
  msg: string;
  data?: unknown;
};

type DesktopWsPushFrame = {
  frame: "push";
  type: DesktopWsPushType | string;
  data?: unknown;
};

type DesktopWsServerOptions = {
  app: App;
  port?: number;
  host?: string;
  desktopActionOptions: Parameters<typeof handleDesktopActionRequest>[0];
  assistantBridge: {
    listAgents: () => Promise<unknown>;
    startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  };
  getTaskBoardRuntime: () => TaskBoardRuntime | null;
  verifyToken?: (token: string, subprotocol?: string) => Promise<DesktopWsAuthSession>;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

type DesktopWsConnection = {
  id: string;
  socket: Socket;
  auth: DesktopWsAuthSession;
  source: string;
  clientDeviceId: string;
  buffer: Buffer;
  subscriptions: Set<string>;
  closed: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
};

type DesktopWsServerRecord = {
  server: http.Server;
  host: string;
  port: number;
  connections: Set<DesktopWsConnection>;
  logger: Pick<typeof console, "log" | "warn" | "error">;
  startedAt: string;
};

type PublicActionDefinition = DesktopActionDefinition & {
  action: string;
  internalAction: string;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const AUTH_EXPIRING_WINDOW_MS = 5 * 60_000;
const AUTH_EXPIRING_THROTTLE_MS = 60_000;

let activeServer: DesktopWsServerRecord | null = null;

const PUBLIC_ACTION_ALIASES: Record<string, string> = {
  "navigation.toRoute": "desktop.navigate.toRoute",

  "setting.get": "desktop.settings.getState",
  "setting.validatePatch": "desktop.settings.validatePatch",
  "setting.previewPatch": "desktop.settings.previewPatch",
  "setting.applyPatch": "desktop.settings.applyPatch",

  "service.list": "desktop.controlCenter.listServices",
  "service.get": "desktop.controlCenter.getServiceDetail",
  "service.status": "desktop.controlCenter.getServiceStatus",
  "service.logs.meta": "desktop.controlCenter.getServiceLogsMeta",
  "service.logs.read": "desktop.controlCenter.readServiceLog",
  "service.start": "desktop.controlCenter.startService",
  "service.stop": "desktop.controlCenter.stopService",
  "service.restart": "desktop.controlCenter.restartService",

  "agent.list": "desktop.agents.listAgents",
  "agent.get": "desktop.agents.getAgentDetail",
  "agent.create": "desktop.agents.createAgent",
  "agent.update": "desktop.agents.updateAgent",
  "agent.delete": "desktop.agents.deleteAgent",

  "automation.list": "desktop.automations.listAutomations",
  "automation.get": "desktop.automations.getAutomationDetail",
  "automation.create": "desktop.automations.createAutomation",
  "automation.update": "desktop.automations.updateAutomation",
  "automation.toggle": "desktop.automations.pauseAutomation",
  "automation.delete": "desktop.automations.deleteAutomation",
  "automation.executions": "desktop.automations.getAutomationDetail",

  "market.settings": "desktop.market.getSettings",
  "market.list": "desktop.market.listItems",
  "market.refresh": "desktop.market.refresh",
  "market.get": "desktop.market.getItemDetail",
  "market.install": "desktop.market.installItem",
  "market.update": "desktop.market.updateItem",
  "market.uninstall": "desktop.market.uninstallItem",

  "help.current": "desktop.help.getCurrentTopic",
  "help.search": "desktop.help.searchTopics",
  "help.open": "desktop.help.openTopic",
  "help.explain": "desktop.help.explainCurrentPage",
  "help.suggest": "desktop.help.suggestNextAction",

  "page.context": "desktop.page.getContext",
  "page.read": "desktop.page.readCurrent",
  "page.interact": "desktop.page.interact",
  "page.fillForm": "desktop.page.fillForm",
  "page.submitForm": "desktop.page.submitForm",

  "embeddedWeb.surfaces": "desktop.embeddedWeb.listSurfaces",
  "embeddedWeb.active": "desktop.embeddedWeb.getActiveSurface",
  "embeddedWeb.activate": "desktop.embeddedWeb.activateSurface",
  "embeddedWeb.context": "desktop.embeddedWeb.getPageContext",
  "embeddedWeb.navigate": "desktop.embeddedWeb.navigate",
  "embeddedWeb.reload": "desktop.embeddedWeb.reload",
  "embeddedWeb.back": "desktop.embeddedWeb.goBack",
  "embeddedWeb.tab.open": "desktop.embeddedWeb.openTab",
  "embeddedWeb.tab.close": "desktop.embeddedWeb.closeTab",
  "embeddedWeb.tab.switch": "desktop.embeddedWeb.switchTab",
  "embeddedWeb.read": "desktop.embeddedWeb.readPageData",
  "embeddedWeb.executeScript": "desktop.embeddedWeb.executeScript",

  "web.list": "desktop.webs.list",
  "webapp.status": "desktop.webs.webapps.getStatus",
  "webapp.start": "desktop.webs.webapps.start",
  "webapp.stop": "desktop.webs.webapps.stop",
  "webapp.restart": "desktop.webs.webapps.restart",

  "staticServer.list": "desktop.staticServer.list",
  "staticServer.start": "desktop.staticServer.start",
  "staticServer.stop": "desktop.staticServer.stop",
  "staticServer.restart": "desktop.staticServer.restart"
};

const DIRECT_ACTION_TYPES = new Set([
  "service.list",
  "service.get",
  "service.status",
  "agent.list",
  "automation.list"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function createSessionId() {
  return `desktop_ws_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function normalizePublicActionName(action: string) {
  const normalized = action.trim();
  if (!normalized) {
    return "";
  }
  if (PUBLIC_ACTION_ALIASES[normalized]) {
    return PUBLIC_ACTION_ALIASES[normalized];
  }
  if (getDesktopActionDefinition(normalized)) {
    return normalized;
  }
  const legacy = normalized.startsWith("desktop.") ? normalized : `desktop.${normalized}`;
  return getDesktopActionDefinition(legacy) ? legacy : normalized;
}

function listPublicActions(): PublicActionDefinition[] {
  const byInternal = new Map<string, DesktopActionDefinition>(
    DESKTOP_ACTION_DEFINITIONS.map((definition) => [definition.name, definition])
  );
  const actions: PublicActionDefinition[] = [];
  const seen = new Set<string>();
  for (const [action, internalAction] of Object.entries(PUBLIC_ACTION_ALIASES)) {
    const definition = byInternal.get(internalAction);
    if (!definition || seen.has(action)) {
      continue;
    }
    seen.add(action);
    actions.push({
      ...definition,
      name: action,
      action,
      internalAction
    });
  }
  for (const definition of DESKTOP_ACTION_DEFINITIONS) {
    const publicName = definition.name.replace(/^desktop\./u, "");
    if (seen.has(publicName)) {
      continue;
    }
    seen.add(publicName);
    actions.push({
      ...definition,
      name: publicName,
      action: publicName,
      internalAction: definition.name
    });
  }
  return actions;
}

function readTokenFromSubprotocol(req: http.IncomingMessage) {
  const rawProtocol = String(req.headers["sec-websocket-protocol"] ?? "");
  for (const candidate of rawProtocol.split(",")) {
    const protocol = candidate.trim();
    const lower = protocol.toLowerCase();
    if (lower.startsWith("bearer.")) {
      const token = protocol.slice("bearer.".length).trim();
      return token ? { token, subprotocol: protocol } : null;
    }
    if (lower.startsWith("bearer ")) {
      const token = protocol.slice("bearer ".length).trim();
      return token ? { token, subprotocol: protocol } : null;
    }
  }
  return null;
}

function readTokenFromRequest(req: http.IncomingMessage) {
  const fromProtocol = readTokenFromSubprotocol(req);
  if (fromProtocol) {
    return fromProtocol;
  }
  const parsed = new URL(req.url || "/", `http://${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}`);
  const token = readText(parsed.searchParams.get("token"));
  return token ? { token, subprotocol: "" } : null;
}

function decodeJwtPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function verifyRs256Jwt(token: string, publicKeyPem: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid JWT");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJwtPart(headerPart);
  if (header.alg !== "RS256") {
    throw new Error("unsupported JWT alg");
  }
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  if (!verifier.verify(publicKeyPem, Buffer.from(signaturePart, "base64url"))) {
    throw new Error("invalid JWT signature");
  }
  return decodeJwtPart(payloadPart);
}

async function verifyDesktopAccessToken(app: App, token: string, subprotocol?: string): Promise<DesktopWsAuthSession> {
  const { publicKeyPem } = await ensureAppServerJwk(app);
  const payload = verifyRs256Jwt(token, publicKeyPem);
  const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new Error("token expired");
  }
  const scope = readText(payload.scope);
  if (scope !== "app") {
    throw new Error("token scope must be app");
  }
  const deviceId = readText(payload.device_id) || readText(payload.deviceId);
  if (!deviceId || deviceId !== getDesktopDeviceId(app)) {
    throw new Error("token device_id does not match this Desktop");
  }
  return {
    subject: readText(payload.sub),
    deviceId,
    scope,
    expiresAt: exp * 1000,
    subprotocol
  };
}

function writeUpgradeFailure(socket: Socket, status: number, message: string) {
  if (socket.destroyed) {
    return;
  }
  const payload = Buffer.from(message, "utf8");
  try {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${payload.byteLength}\r\n\r\n${message}`
    );
  } catch {
    socket.destroy();
  }
}

function writeUpgradeSuccess(socket: Socket, req: http.IncomingMessage, subprotocol?: string) {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`
  ];
  if (subprotocol) {
    headers.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
  }
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
}

function encodeWebSocketFrame(opcode: number, payload: Buffer) {
  const length = payload.byteLength;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function sendJson(connection: DesktopWsConnection, payload: DesktopWsResponseFrame | DesktopWsErrorFrame | DesktopWsPushFrame) {
  if (connection.closed || connection.socket.destroyed) {
    return;
  }
  connection.socket.write(encodeWebSocketFrame(0x1, Buffer.from(JSON.stringify(payload), "utf8")));
}

function sendResponse(connection: DesktopWsConnection, type: string, id: string, data: unknown, msg = "success") {
  sendJson(connection, { frame: "response", type, id, code: 0, msg, data });
}

function sendError(connection: DesktopWsConnection, id: string | undefined, type: string, code: number, msg: string, data?: unknown) {
  sendJson(connection, { frame: "error", type, id, code, msg, data });
}

function sendPush(connection: DesktopWsConnection, type: DesktopWsPushType | string, data?: unknown) {
  sendJson(connection, { frame: "push", type, data });
}

function closeConnection(record: DesktopWsServerRecord, connection: DesktopWsConnection, code = 1000, reason = "closed") {
  if (connection.closed) {
    return;
  }
  connection.closed = true;
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
  record.connections.delete(connection);
  if (!connection.socket.destroyed) {
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      connection.socket.end(encodeWebSocketFrame(0x8, payload));
    } catch {
      connection.socket.destroy();
    }
  }
}

function parseFrames(connection: DesktopWsConnection) {
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

function actionPayload(action: string, payload: unknown): DesktopActionCallRequest {
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

async function callDesktopAction(options: DesktopWsServerOptions, action: string, payload: unknown): Promise<DesktopActionCallResponse> {
  return handleDesktopActionRequest(options.desktopActionOptions, actionPayload(action, payload));
}

function getTaskBoardRuntime(options: DesktopWsServerOptions) {
  const runtime = options.getTaskBoardRuntime();
  if (!runtime) {
    throw new Error("task board runtime is not initialized");
  }
  return runtime;
}

function readIssueId(payload: unknown) {
  const record = asRecord(payload);
  return readText(record.id) || readText(record.issueId);
}

function readIssueCreateInput(payload: unknown): TaskBoardIssueInput {
  const record = asRecord(payload);
  const nested = asRecord(record.input);
  return (Object.keys(nested).length > 0 ? nested : record) as unknown as TaskBoardIssueInput;
}

function readIssueUpdateInput(payload: unknown): { issueId: string; input: TaskBoardIssueUpdateInput } {
  const record = asRecord(payload);
  return {
    issueId: readIssueId(record),
    input: asRecord(record.input) as unknown as TaskBoardIssueUpdateInput
  };
}

function readIssueMoveInput(payload: unknown): TaskBoardIssueMoveInput {
  return asRecord(payload) as unknown as TaskBoardIssueMoveInput;
}

function unsupported(type: string) {
  return {
    code: "unsupported",
    message: `${type} is reserved but not implemented in Desktop WS v1.`
  };
}

async function handleRequest(options: DesktopWsServerOptions, connection: DesktopWsConnection, req: DesktopWsRequestFrame) {
  const type = readText(req.type);
  const id = readText(req.id);
  if (!type || !id) {
    sendError(connection, id || undefined, "invalid_request", 400, "request type and id are required");
    return;
  }
  if (!DESKTOP_WS_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, id, "invalid_request", 400, `unknown type: ${type}`);
    return;
  }
  if (!DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, id, "unsupported", 501, unsupported(type).message, unsupported(type));
    return;
  }

  const payload = req.payload;
  switch (type) {
    case "session.hello":
      sendResponse(connection, type, id, {
        sessionId: connection.id,
        protocolVersion: 1,
        server: "desktop-ws",
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
      const token = readText(asRecord(payload).token);
      if (!token) {
        sendError(connection, id, "invalid_request", 400, "token is required");
        return;
      }
      try {
        connection.auth = await (options.verifyToken ?? ((nextToken, subprotocol) =>
          verifyDesktopAccessToken(options.app, nextToken, subprotocol)))(token, connection.auth.subprotocol);
        sendResponse(connection, type, id, { expiresAt: connection.auth.expiresAt });
      } catch {
        sendError(connection, id, "unauthorized", 401, "invalid token");
      }
      return;
    }
    case "capability.list":
      sendResponse(connection, type, id, {
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
      sendResponse(connection, type, id, { types: [...connection.subscriptions] });
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
      sendResponse(connection, type, id, { types: [...connection.subscriptions] });
      return;
    }
    case "action.list":
      sendResponse(connection, type, id, { actions: listPublicActions() });
      return;
    case "action.call": {
      const response = await callDesktopAction(options, "", payload);
      if (!response.ok) {
        sendError(connection, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, type, id, response);
      return;
    }
    case "snapshot.get":
      sendResponse(connection, type, id, getTaskBoardRuntime(options).listIssues());
      return;
    case "issue.create":
      sendResponse(connection, type, id, await getTaskBoardRuntime(options).createIssue(readIssueCreateInput(payload)));
      return;
    case "issue.update": {
      const update = readIssueUpdateInput(payload);
      sendResponse(connection, type, id, await getTaskBoardRuntime(options).updateIssue(update.issueId, update.input));
      return;
    }
    case "issue.delete":
      sendResponse(connection, type, id, await getTaskBoardRuntime(options).deleteIssueWithAutomation(readIssueId(payload)));
      return;
    case "issue.move":
      sendResponse(connection, type, id, await getTaskBoardRuntime(options).moveIssue(readIssueMoveInput(payload)));
      return;
    case "device.status":
      sendResponse(connection, type, id, {
        deviceId: getDesktopDeviceId(options.app),
        serverTime: nowIso(),
        connectionCount: activeServer?.connections.size ?? 0
      });
      return;
    case "runtime.info":
      sendResponse(connection, type, id, resolveDesktopAppInfo(options.app));
      return;
    case "assistant.startRun":
      sendResponse(connection, type, id, await options.assistantBridge.startRun(asRecord(payload) as unknown as AssistantStartRunRequest));
      return;
    case "service.list":
    case "service.get":
    case "service.status":
    case "agent.list":
    case "automation.list": {
      const response = await callDesktopAction(options, type, { args: asRecord(payload) });
      if (!response.ok) {
        sendError(connection, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, type, id, response.result ?? response.preview ?? response);
      return;
    }
    default:
      if (DIRECT_ACTION_TYPES.has(type)) {
        const response = await callDesktopAction(options, type, { args: asRecord(payload) });
        sendResponse(connection, type, id, response);
        return;
      }
      sendError(connection, id, "unsupported", 501, unsupported(type).message, unsupported(type));
  }
}

function handleTextMessage(options: DesktopWsServerOptions, connection: DesktopWsConnection, text: string) {
  let parsed: DesktopWsRequestFrame;
  try {
    parsed = JSON.parse(text) as DesktopWsRequestFrame;
  } catch {
    sendError(connection, undefined, "invalid_request", 400, "invalid JSON frame");
    return;
  }
  if (parsed.frame !== "request") {
    sendError(connection, readText(parsed.id) || undefined, "invalid_request", 400, "only request frames are accepted");
    return;
  }
  void handleRequest(options, connection, parsed).catch((error) => {
    sendError(
      connection,
      readText(parsed.id) || undefined,
      "internal_error",
      500,
      error instanceof Error ? error.message : String(error)
    );
  });
}

function bindConnection(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket, auth: DesktopWsAuthSession) {
  const parsed = new URL(req.url || "/", `http://${record.host}:${record.port}`);
  const connection: DesktopWsConnection = {
    id: createSessionId(),
    socket,
    auth,
    source: readText(parsed.searchParams.get("source")),
    clientDeviceId: readText(parsed.searchParams.get("deviceId")) || readText(parsed.searchParams.get("device_id")),
    buffer: Buffer.alloc(0),
    subscriptions: new Set(),
    closed: false,
    heartbeatTimer: null
  };
  record.connections.add(connection);
  sendPush(connection, "connected", { sessionId: connection.id });
  let lastAuthExpiringAt = 0;
  connection.heartbeatTimer = setInterval(() => {
    sendPush(connection, "heartbeat", { timestamp: new Date().toISOString() });
    if (connection.auth.expiresAt <= Date.now() + AUTH_EXPIRING_WINDOW_MS && Date.now() - lastAuthExpiringAt > AUTH_EXPIRING_THROTTLE_MS) {
      lastAuthExpiringAt = Date.now();
      sendPush(connection, "auth.expiring", { expiresAt: connection.auth.expiresAt });
    }
  }, HEARTBEAT_INTERVAL_MS);

  socket.on("data", (chunk) => {
    try {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      const frames = parseFrames(connection);
      for (const frame of frames) {
        if (frame.opcode === 0x1) {
          handleTextMessage(options, connection, frame.payload.toString("utf8"));
        } else if (frame.opcode === 0x8) {
          closeConnection(record, connection);
        } else if (frame.opcode === 0x9) {
          socket.write(encodeWebSocketFrame(0xA, frame.payload));
        }
      }
    } catch (error) {
      record.logger.warn?.(`[desktop-ws] closing invalid websocket frame: ${error instanceof Error ? error.message : String(error)}`);
      closeConnection(record, connection, 1002, "protocol error");
    }
  });
  socket.on("close", () => closeConnection(record, connection));
  socket.on("error", () => closeConnection(record, connection));
}

async function handleUpgrade(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket) {
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
    const auth = await (options.verifyToken ?? ((token, subprotocol) =>
      verifyDesktopAccessToken(options.app, token, subprotocol)))(tokenInfo.token, tokenInfo.subprotocol);
    writeUpgradeSuccess(socket, req, tokenInfo.subprotocol);
    bindConnection(record, options, req, socket, auth);
  } catch (error) {
    record.logger.warn?.(`[desktop-ws] unauthorized websocket upgrade: ${error instanceof Error ? error.message : String(error)}`);
    writeUpgradeFailure(socket, 401, "Unauthorized");
  }
}

export async function startDesktopWsServer(options: DesktopWsServerOptions) {
  if (activeServer) {
    return {
      running: true,
      host: activeServer.host,
      port: activeServer.port,
      webSocketUrl: `ws://${activeServer.host}:${activeServer.port}${DESKTOP_WS_PATH}`
    };
  }
  const host = options.host || DESKTOP_WS_HOST;
  const port = options.port ?? DESKTOP_WS_PORT;
  const logger = options.logger || console;
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Desktop WS Server only accepts WebSocket upgrades on /ws.");
  });
  const record: DesktopWsServerRecord = {
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
  activeServer = record;
  logger.log?.(`[desktop-ws] listening on ${host}:${record.port}`);
  return {
    running: true,
    host,
    port: record.port,
    webSocketUrl: `ws://${host}:${record.port}${DESKTOP_WS_PATH}`
  };
}

export function emitDesktopWsPush(type: DesktopWsPushType | string, data?: unknown) {
  const record = activeServer;
  if (!record) {
    return;
  }
  for (const connection of record.connections) {
    if (connection.subscriptions.has(type)) {
      sendPush(connection, type, data);
    }
  }
}

export function stopDesktopWsServer() {
  const record = activeServer;
  activeServer = null;
  if (!record) {
    return Promise.resolve();
  }
  for (const connection of [...record.connections]) {
    closeConnection(record, connection, 1001, "server stopping");
  }
  return new Promise<void>((resolve) => {
    record.server.close(() => resolve());
  });
}

export const __testInternals = {
  encodeWebSocketFrame,
  parseFrames,
  normalizePublicActionName,
  verifyRs256Jwt,
  listPublicActions
};
