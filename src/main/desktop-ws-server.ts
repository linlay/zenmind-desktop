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
  AgentAuthIssueResult,
  AgentAuthRefreshReason,
  DesktopMobileWebappCatalog,
  DesktopWsServerState,
  ServiceState,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueUpdateInput
} from "../shared/contracts";
import { resolveDesktopAppInfo } from "./app-metadata";
import { ensureIdentityCenterJwk } from "./identity-center-auth";
import { getDesktopDeviceId } from "./device-identity";
import { handleDesktopActionRequest } from "./desktop-action-bridge";
import type { KanbanRuntime } from "./kanban-runtime";

export type DesktopWsAuthSession = {
  subject: string;
  deviceId: string;
  expiresAt: number;
  scope: string;
  subprotocol?: string;
};

type DesktopWsRequestFrame = {
  ns?: string;
  frame?: string;
  type?: string;
  id?: string;
  payload?: unknown;
};

type DesktopWsResponseFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "response";
  type: string;
  id: string;
  code: number;
  msg: string;
  data?: unknown;
};

type DesktopWsErrorFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "error";
  type: string;
  id?: string;
  code: number;
  msg: string;
  data?: unknown;
};

type DesktopWsPushFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "push";
  type: DesktopWsPushType | string;
  data?: unknown;
};

type DesktopWsStreamFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM;
  frame: "stream";
  id?: string;
  streamId?: string;
  event?: unknown;
  reason?: string;
  lastSeq?: number;
  [key: string]: unknown;
};

type DesktopWsOutboundFrame = DesktopWsResponseFrame | DesktopWsErrorFrame | DesktopWsPushFrame | DesktopWsStreamFrame;

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

type AgentPlatformBridgeOptions = {
  getServiceState: (app: App, serviceId: string) => Promise<ServiceState>;
  issueAccessToken: (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  WebSocketConstructor?: MinimalWebSocketConstructor;
};

export type DesktopWsServerOptions = {
  app: App;
  port?: number;
  host?: string;
  desktopActionOptions: Parameters<typeof handleDesktopActionRequest>[0];
  assistantBridge: {
    listAgents: () => Promise<unknown>;
    startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  };
  getKanbanRuntime: () => KanbanRuntime | null;
  listMobileWebapps?: () => DesktopMobileWebappCatalog;
  issueAccessToken?: (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  agentPlatformBridge?: AgentPlatformBridgeOptions;
  verifyToken?: (token: string, subprotocol?: string) => Promise<DesktopWsAuthSession>;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

type DesktopWsServerKind = "debug";
type DesktopWsSessionKind = DesktopWsServerKind | "tunnel";

export type DesktopWsProtocolTransport = {
  sendText: (text: string) => void;
  close: (code?: number, reason?: string) => void;
};

type DesktopWsSessionGroup = {
  kind: DesktopWsSessionKind;
  connections: Set<DesktopWsConnection>;
  logger: Pick<typeof console, "log" | "warn" | "error">;
  startedAt: string;
};

type DesktopWsConnection = {
  id: string;
  server: DesktopWsSessionGroup;
  auth: DesktopWsAuthSession;
  source: string;
  clientDeviceId: string;
  buffer: Buffer;
  subscriptions: Set<string>;
  closed: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  authRefresh: Promise<DesktopWsIssuedAuthRefresh> | null;
  agentPlatformBridge: AgentPlatformWsBridge | null;
  transport: DesktopWsProtocolTransport;
};

type DesktopWsIssuedAuthRefresh = {
  token: string;
  auth: DesktopWsAuthSession;
};

type DesktopWsServerRecord = DesktopWsSessionGroup & {
  kind: DesktopWsServerKind;
  server: http.Server;
  host: string;
  port: number;
};

export type DesktopWsServerRuntimeState = Omit<DesktopWsServerState, "enabled" | "message">;

type PublicActionDefinition = DesktopActionDefinition & {
  action: string;
  internalAction: string;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const AUTH_EXPIRING_WINDOW_MS = 5 * 60_000;
const AUTH_EXPIRING_THROTTLE_MS = 60_000;
const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const AGENT_PLATFORM_WS_SOURCE = "desktop-ws-bridge";
const WS_OPEN_STATE = 1;
const WS_CONNECTING_STATE = 0;
const AGENT_PLATFORM_CONTROL_PUSH_TYPES = new Set(["connected", "heartbeat", "auth.expiring"]);
const AGENT_PLATFORM_CONNECT_TIMEOUT_MS = 8_000;

const activeServers = new Map<DesktopWsServerKind, DesktopWsServerRecord>();
const tunnelSessionGroup: DesktopWsSessionGroup = {
  kind: "tunnel",
  connections: new Set(),
  logger: console,
  startedAt: nowIso()
};

function normalizeDesktopWsBindHost(value: unknown) {
  const host = typeof value === "string" ? value.trim() : "";
  return host || DESKTOP_WS_HOST;
}

function isDesktopWsBindHostSatisfied(activeHost: string, requestedHost: string) {
  return activeHost === requestedHost || activeHost === DESKTOP_WS_LAN_BIND_HOST;
}

function getDesktopWsLocalUrlHost(host: string) {
  return host === DESKTOP_WS_LAN_BIND_HOST ? DESKTOP_WS_HOST : host;
}

function createDesktopWsServerRuntimeState(
  record: DesktopWsServerRecord | null,
  defaultPort: number
): DesktopWsServerRuntimeState {
  const host = record?.host ?? DESKTOP_WS_HOST;
  const urlHost = getDesktopWsLocalUrlHost(host);
  const port = record?.port ?? defaultPort;
  return {
    running: Boolean(record),
    host,
    port,
    path: DESKTOP_WS_PATH,
    url: `ws://${urlHost}:${port}${DESKTOP_WS_PATH}`
  };
}

const PUBLIC_ACTION_ALIASES: Record<string, string> = {
  "navigation.toRoute": "desktop.navigate.toRoute",

  "service.list": "desktop.controlCenter.listServices",
  "service.get": "desktop.controlCenter.getServiceDetail",
  "service.status": "desktop.controlCenter.getServiceStatus",
  "service.logs.meta": "desktop.controlCenter.getServiceLogsMeta",
  "service.logs.read": "desktop.controlCenter.readServiceLog",
  "service.start": "desktop.controlCenter.startService",
  "service.stop": "desktop.controlCenter.stopService",
  "service.restart": "desktop.controlCenter.restartService",

  "market.settings": "desktop.market.getSettings",
  "market.list": "desktop.market.listItems",
  "market.refresh": "desktop.market.refresh",
  "market.get": "desktop.market.getItemDetail",
  "market.install": "desktop.market.installItem",
  "market.update": "desktop.market.updateItem",
  "market.uninstall": "desktop.market.uninstallItem",

  "help.open": "desktop.help.openTopic",

  "kanban.issue.list": "desktop.kanban.listIssues",
  "kanban.issue.get": "desktop.kanban.getIssue",
  "kanban.issue.create": "desktop.kanban.createIssue",
  "kanban.issue.update": "desktop.kanban.updateIssue",
  "kanban.issue.delete": "desktop.kanban.deleteIssue",
  "kanban.issue.move": "desktop.kanban.moveIssue",

  "site.list": "desktop.site.list",
  "web.listSurfaces": "desktop.web.listSurfaces",
  "web.getSurfaceState": "desktop.web.getSurfaceState",
  "web.activateSurface": "desktop.web.activateSurface",
  "web.navigate": "desktop.web.navigate",
  "web.reload": "desktop.web.reload",
  "web.refreshSurface": "desktop.web.refreshSurface",
  "web.goBack": "desktop.web.goBack",
  "web.openTab": "desktop.web.openTab",
  "web.closeTab": "desktop.web.closeTab",
  "web.switchTab": "desktop.web.switchTab",
  "website.list": "desktop.website.list",
  "website.add": "desktop.website.add",
  "website.update": "desktop.website.update",
  "website.remove": "desktop.website.remove",
  "webapp.getStatus": "desktop.webapp.getStatus",
  "webapp.checkRuntime": "desktop.webapp.checkRuntime",
  "webapp.start": "desktop.webapp.start",
  "webapp.stop": "desktop.webapp.stop",
  "webapp.restart": "desktop.webapp.restart",
  "webapp.open": "desktop.webapp.open",
  "webapp.install": "desktop.webapp.install",
  "webapp.uninstall": "desktop.webapp.uninstall",
  "webapp.getPublishStatus": "desktop.webapp.getPublishStatus",
  "webapp.publish": "desktop.webapp.publish",
  "webapp.unpublish": "desktop.webapp.unpublish"
};

const BLOCKED_PUBLIC_ACTION_NAMES = new Set([
  "web.list",
  "web.surfaces",
  "web.active",
  "web.activate",
  "web.context",
  "web.read",
  "web.getPageContext",
  "web.readPageData",
  "web.extractStructured",
  "web.interactElement",
  "web.executeScript",
  "web.back",
  "web.tab.open",
  "web.tab.close",
  "web.tab.switch",
  "webapp.status",
  "pet.settings",
  "pet.appearances",
  "help.openTopic",
  "agent.open",
  "agent.update",
  "skill.open",
  "skill.update",
  "kanban.listIssues",
  "kanban.getIssue",
  "kanban.createIssue",
  "kanban.updateIssue",
  "kanban.deleteIssue",
  "kanban.moveIssue"
]);

const DIRECT_ACTION_TYPES = new Set([
  "service.list",
  "service.get",
  "service.status"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNamespace(value: unknown) {
  const record = asRecord(value);
  return readText(record[DESKTOP_WS_NAMESPACE_FIELD]) || DESKTOP_WS_NAMESPACE_DESKTOP;
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getWebSocketConstructor(options: AgentPlatformBridgeOptions): MinimalWebSocketConstructor | null {
  if (options.WebSocketConstructor) {
    return options.WebSocketConstructor;
  }
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function createAgentPlatformWsUrl(app: App, baseUrl: string, token: string) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("source", AGENT_PLATFORM_WS_SOURCE);
  url.searchParams.set("deviceId", getDesktopDeviceId(app));
  return url.toString();
}

async function decodeMessageData(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (asRecord(data).text && typeof asRecord(data).text === "function") {
    const text = await (data as { text: () => Promise<unknown> }).text();
    return typeof text === "string" ? text : String(text ?? "");
  }
  if (asRecord(data).arrayBuffer && typeof asRecord(data).arrayBuffer === "function") {
    const buffer = await (data as { arrayBuffer: () => Promise<unknown> }).arrayBuffer();
    if (buffer instanceof ArrayBuffer) {
      return Buffer.from(buffer).toString("utf8");
    }
  }
  return String(data ?? "");
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
  if (BLOCKED_PUBLIC_ACTION_NAMES.has(normalized)) {
    return normalized;
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
    if (BLOCKED_PUBLIC_ACTION_NAMES.has(publicName)) {
      continue;
    }
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
  const { publicKeyPem } = await ensureIdentityCenterJwk(app);
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

export function authenticateDesktopWsProtocolSession(
  options: DesktopWsServerOptions,
  token: string,
  subprotocol?: string
) {
  return (options.verifyToken ?? ((nextToken, nextSubprotocol) =>
    verifyDesktopAccessToken(options.app, nextToken, nextSubprotocol)))(token, subprotocol);
}

function readAuthRefreshReason(payload: Record<string, unknown>): AgentAuthRefreshReason {
  return readText(payload.reason) === "unauthorized" ? "unauthorized" : "missing";
}

async function issueDesktopWsRefreshAuth(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  reason: AgentAuthRefreshReason
): Promise<DesktopWsIssuedAuthRefresh> {
  if (!options.issueAccessToken) {
    throw new Error("Desktop WS token issuer is not configured");
  }
  const tokenResult = await options.issueAccessToken(options.app, reason);
  const token = readText(tokenResult.token);
  if (!tokenResult.ok || !token) {
    throw new Error(tokenResult.message || "Desktop WS token unavailable");
  }
  const auth = await authenticateDesktopWsProtocolSession(options, token, connection.auth.subprotocol);
  connection.auth = auth;
  return { token, auth };
}

function refreshDesktopWsConnectionAuth(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  reason: AgentAuthRefreshReason
) {
  if (!connection.authRefresh) {
    connection.authRefresh = issueDesktopWsRefreshAuth(options, connection, reason).finally(() => {
      connection.authRefresh = null;
    });
  }
  return connection.authRefresh;
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

function sendJson(connection: DesktopWsConnection, payload: DesktopWsOutboundFrame) {
  if (connection.closed) {
    return;
  }
  connection.transport.sendText(JSON.stringify(payload));
}

function sendResponse(
  connection: DesktopWsConnection,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP,
  type: string,
  id: string,
  data: unknown,
  msg = "success"
) {
  sendJson(connection, { ns: namespace, frame: "response", type, id, code: 0, msg, data });
}

function sendError(
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

function sendPush(connection: DesktopWsConnection, type: DesktopWsPushType | string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_DESKTOP, frame: "push", type, data });
}

function sendAgentPlatformError(connection: DesktopWsConnection, id: string | undefined, type: string, code: number, msg: string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_AGENT_PLATFORM, frame: "error", type, id, code, msg, data });
}

function withAgentPlatformNamespace(frame: Record<string, unknown>): DesktopWsOutboundFrame | null {
  const outboundFrame = readText(frame.frame);
  if (!outboundFrame || !["response", "push", "stream", "error"].includes(outboundFrame)) {
    return null;
  }
  const { ns: _ns, ...rest } = frame;
  return {
    ns: DESKTOP_WS_NAMESPACE_AGENT_PLATFORM,
    ...rest,
    frame: outboundFrame
  } as DesktopWsOutboundFrame;
}

class AgentPlatformWsBridge {
  private ws: MinimalWebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly pendingRequests = new Map<string, string>();

  constructor(
    private readonly options: DesktopWsServerOptions,
    private readonly connection: DesktopWsConnection,
    private readonly logger: Pick<typeof console, "log" | "warn" | "error">
  ) {}

  async forwardRequest(req: DesktopWsRequestFrame) {
    const id = readText(req.id);
    const type = readText(req.type);
    if (!id || !type) {
      sendAgentPlatformError(this.connection, id || undefined, "invalid_request", 400, "request type and id are required");
      return;
    }
    if (req.frame !== "request") {
      sendAgentPlatformError(this.connection, id || undefined, "invalid_request", 400, "only request frames are accepted");
      return;
    }
    if (!this.options.agentPlatformBridge) {
      sendAgentPlatformError(this.connection, id, "agent_platform_unavailable", 503, "agent-platform bridge is not configured");
      return;
    }

    try {
      await this.ensureConnected(this.options.agentPlatformBridge);
      const socket = this.ws;
      if (!socket || !this.isSocketOpen(socket)) {
        throw new Error("agent-platform websocket is not open");
      }
      const { ns: _ns, ...forwarded } = req;
      this.pendingRequests.set(id, type);
      socket.send(JSON.stringify(forwarded));
    } catch (error) {
      this.pendingRequests.delete(id);
      sendAgentPlatformError(
        this.connection,
        id,
        "agent_platform_unavailable",
        503,
        errorMessage(error)
      );
    }
  }

  close() {
    this.rejectPending("agent-platform bridge closed");
    this.closeSocket(1000, "desktop ws closed");
  }

  private async ensureConnected(bridgeOptions: AgentPlatformBridgeOptions) {
    if (this.ws && this.isSocketOpen(this.ws)) {
      return;
    }
    if (this.ws && this.ws.readyState === WS_CONNECTING_STATE && this.opening) {
      return this.opening;
    }
    if (this.opening) {
      return this.opening;
    }
    this.opening = this.open(bridgeOptions).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(bridgeOptions: AgentPlatformBridgeOptions) {
    const WebSocketConstructor = getWebSocketConstructor(bridgeOptions);
    if (!WebSocketConstructor) {
      throw new Error("current runtime does not provide WebSocket");
    }

    const serviceState = await bridgeOptions.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
    const baseUrl = serviceState.status === "running"
      ? serviceState.healthMeta.webUrl.trim() || (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
      : "";
    if (!baseUrl) {
      throw new Error(serviceState.message || "agent-platform is not running");
    }

    const tokenResult = await bridgeOptions.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      throw new Error(tokenResult.message || "agent-platform token unavailable");
    }

    this.closeSocket(1000, "agent-platform reconnect");
    const wsUrl = createAgentPlatformWsUrl(this.options.app, baseUrl, tokenResult.token.trim());
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocketConstructor(wsUrl);
      this.ws = socket;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.closeSocket(1002, "agent-platform connect timeout");
        reject(new Error("agent-platform websocket connect timeout"));
      }, AGENT_PLATFORM_CONNECT_TIMEOUT_MS);

      const finishOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const failOpen = (event?: unknown) => {
        if (settled) {
          this.handleSocketClosed(event);
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.closeSocket(1002, "agent-platform connect failed");
        reject(new Error(`agent-platform websocket connect failed${this.eventDetail(event) ? `: ${this.eventDetail(event)}` : ""}`));
      };
      const handleMessage = (event?: unknown) => {
        const data = asRecord(event).data;
        void this.handleMessage(data);
      };
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener("open", finishOpen);
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("close", failOpen);
        socket.addEventListener("error", failOpen);
      } else {
        socket.onopen = finishOpen;
        socket.onmessage = (event) => {
          void this.handleMessage(event.data);
        };
        socket.onclose = failOpen;
        socket.onerror = failOpen;
      }
    });
  }

  private async handleMessage(data: unknown) {
    let raw = "";
    try {
      raw = await decodeMessageData(data);
    } catch (error) {
      this.logger.warn?.(`[desktop-ws] failed to read agent-platform frame: ${errorMessage(error)}`);
      return;
    }

    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      frame = asRecord(parsed);
    } catch (error) {
      this.logger.warn?.(`[desktop-ws] failed to parse agent-platform frame: ${errorMessage(error)}`);
      return;
    }

    const frameKind = readText(frame.frame);
    const frameType = readText(frame.type);
    if (frameKind === "push" && AGENT_PLATFORM_CONTROL_PUSH_TYPES.has(frameType)) {
      return;
    }
    if ((frameKind === "response" || frameKind === "error") && readText(frame.id)) {
      this.pendingRequests.delete(readText(frame.id));
    }
    const namespaced = withAgentPlatformNamespace(frame);
    if (!namespaced) {
      this.logger.warn?.(`[desktop-ws] dropped unknown agent-platform frame: ${frameKind || "unknown"}`);
      return;
    }
    sendJson(this.connection, namespaced);
  }

  private handleSocketClosed(event?: unknown) {
    this.rejectPending(`agent-platform websocket closed${this.eventDetail(event) ? `: ${this.eventDetail(event)}` : ""}`);
    this.ws = null;
  }

  private rejectPending(message: string) {
    for (const [id] of this.pendingRequests) {
      sendAgentPlatformError(this.connection, id, "agent_platform_disconnected", 503, message);
    }
    this.pendingRequests.clear();
  }

  private closeSocket(code: number, reason: string) {
    const socket = this.ws;
    this.ws = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close failures for sockets that are already closed.
    }
  }

  private isSocketOpen(socket: MinimalWebSocket) {
    return typeof socket.readyState !== "number" || socket.readyState === WS_OPEN_STATE;
  }

  private eventDetail(event: unknown) {
    const record = asRecord(event);
    const parts: string[] = [];
    if (typeof record.type === "string" && record.type) {
      parts.push(`type=${record.type}`);
    }
    if (typeof record.code === "number") {
      parts.push(`code=${record.code}`);
    }
    if (typeof record.reason === "string" && record.reason) {
      parts.push(`reason=${record.reason}`);
    }
    if (typeof record.message === "string" && record.message) {
      parts.push(`message=${record.message}`);
    }
    return parts.join(" ");
  }
}

function closeConnection(connection: DesktopWsConnection, code = 1000, reason = "closed") {
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

function getKanbanRuntime(options: DesktopWsServerOptions) {
  const runtime = options.getKanbanRuntime();
  if (!runtime) {
    throw new Error("Kanban runtime is not initialized");
  }
  return runtime;
}

function readIssueId(payload: unknown) {
  const record = asRecord(payload);
  return readText(record.id) || readText(record.issueId);
}

function readIssueCreateInput(payload: unknown): KanbanIssueInput {
  const record = asRecord(payload);
  const nested = asRecord(record.input);
  return (Object.keys(nested).length > 0 ? nested : record) as unknown as KanbanIssueInput;
}

function readIssueUpdateInput(payload: unknown): { issueId: string; input: KanbanIssueUpdateInput } {
  const record = asRecord(payload);
  return {
    issueId: readIssueId(record),
    input: asRecord(record.input) as unknown as KanbanIssueUpdateInput
  };
}

function readIssueMoveInput(payload: unknown): KanbanIssueMoveInput {
  return asRecord(payload) as unknown as KanbanIssueMoveInput;
}

function unsupported(type: string) {
  return {
    code: "unsupported",
    message: `${type} is reserved but not implemented in Desktop WS v1.`
  };
}

async function handleRequest(
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
      sendResponse(connection, namespace, type, id, resolveDesktopAppInfo(options.app));
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

function handleTextMessage(options: DesktopWsServerOptions, connection: DesktopWsConnection, text: string) {
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

type BindDesktopWsProtocolSessionInput = {
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

function bindProtocolSession(
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

function closeSocketWithFrame(socket: Socket, code = 1000, reason = "closed") {
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

function bindSocketConnection(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket, auth: DesktopWsAuthSession) {
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
    const auth = await authenticateDesktopWsProtocolSession(options, tokenInfo.token, tokenInfo.subprotocol);
    writeUpgradeSuccess(socket, req, tokenInfo.subprotocol);
    bindSocketConnection(record, options, req, socket, auth);
  } catch (error) {
    record.logger.warn?.(`[desktop-ws] unauthorized websocket upgrade: ${error instanceof Error ? error.message : String(error)}`);
    writeUpgradeFailure(socket, 401, "Unauthorized");
  }
}

async function startDesktopWsServerInstance(
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

function stopDesktopWsServerInstance(kind: DesktopWsServerKind) {
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
