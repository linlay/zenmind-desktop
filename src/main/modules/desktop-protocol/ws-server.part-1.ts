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


export type DesktopWsAuthSession = {
  subject: string;
  deviceId: string;
  expiresAt: number;
  scope: string;
  subprotocol?: string;
};

export type DesktopWsRequestFrame = {
  ns?: string;
  frame?: string;
  type?: string;
  id?: string;
  payload?: unknown;
};

export type DesktopWsResponseFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "response";
  type: string;
  id: string;
  code: number;
  msg: string;
  data?: unknown;
};

export type DesktopWsErrorFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "error";
  type: string;
  id?: string;
  code: number;
  msg: string;
  data?: unknown;
};

export type DesktopWsPushFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM | typeof DESKTOP_WS_NAMESPACE_WEBAPP;
  frame: "push";
  type: DesktopWsPushType | string;
  data?: unknown;
};

export type DesktopWsStreamFrame = {
  ns: typeof DESKTOP_WS_NAMESPACE_AGENT_PLATFORM;
  frame: "stream";
  id?: string;
  streamId?: string;
  event?: unknown;
  reason?: string;
  lastSeq?: number;
  [key: string]: unknown;
};

export type DesktopWsOutboundFrame = DesktopWsResponseFrame | DesktopWsErrorFrame | DesktopWsPushFrame | DesktopWsStreamFrame;

export type AgentPlatformBridgeOptions = {
  getServiceState: (app: App, serviceId: string) => Promise<ServiceState>;
  issueAccessToken: (app: App, reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;
  realtimeBroker?: RealtimeBroker;
  WebSocketConstructor?: new (url: string) => import("../agent-platform/realtime/agent-platform-realtime-client").AgentPlatformRealtimeSocket;
};

export type DesktopWsServerOptions = {
  app: App;
  ensureIdentityCenterJwk: (app: App) => Promise<{ publicKeyPem: string }>;
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

export type DesktopWsServerKind = "debug";

export type DesktopWsSessionKind = DesktopWsServerKind | "tunnel";

export type DesktopWsProtocolTransport = {
  sendText: (text: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type DesktopWsSessionGroup = {
  kind: DesktopWsSessionKind;
  connections: Set<DesktopWsConnection>;
  logger: Pick<typeof console, "log" | "warn" | "error">;
  startedAt: string;
};

export type DesktopWsConnection = {
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

export type DesktopWsIssuedAuthRefresh = {
  token: string;
  auth: DesktopWsAuthSession;
};

export type DesktopWsServerRecord = DesktopWsSessionGroup & {
  kind: DesktopWsServerKind;
  server: http.Server;
  host: string;
  port: number;
};

export type DesktopWsServerRuntimeState = Omit<DesktopWsServerState, "enabled" | "message">;

export type PublicActionDefinition = DesktopActionDefinition & {
  action: string;
  internalAction: string;
};

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const AUTH_EXPIRING_WINDOW_MS = 5 * 60_000;

export const AUTH_EXPIRING_THROTTLE_MS = 60_000;

export const AGENT_PLATFORM_SERVICE_ID = "agent-platform";

export const AGENT_PLATFORM_CONTROL_PUSH_TYPES = new Set(["connected", "heartbeat", "auth.expiring"]);

export const activeServers = new Map<DesktopWsServerKind, DesktopWsServerRecord>();

export const tunnelSessionGroup: DesktopWsSessionGroup = {
  kind: "tunnel",
  connections: new Set(),
  logger: console,
  startedAt: nowIso()
};

export function normalizeDesktopWsBindHost(value: unknown) {
  const host = typeof value === "string" ? value.trim() : "";
  return host || DESKTOP_WS_HOST;
}

export function isDesktopWsBindHostSatisfied(activeHost: string, requestedHost: string) {
  return activeHost === requestedHost || activeHost === DESKTOP_WS_LAN_BIND_HOST;
}

export function getDesktopWsLocalUrlHost(host: string) {
  return host === DESKTOP_WS_LAN_BIND_HOST ? DESKTOP_WS_HOST : host;
}

export function createDesktopWsServerRuntimeState(
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

export const PUBLIC_ACTION_ALIASES: Record<string, string> = {
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

export const BLOCKED_PUBLIC_ACTION_NAMES = new Set([
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

export const DIRECT_ACTION_TYPES = new Set([
  "service.list",
  "service.get",
  "service.status"
]);

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function readNamespace(value: unknown) {
  const record = asRecord(value);
  return readText(record[DESKTOP_WS_NAMESPACE_FIELD]) || DESKTOP_WS_NAMESPACE_DESKTOP;
}

export function nowIso() {
  return new Date().toISOString();
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createSessionId() {
  return `desktop_ws_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function normalizePublicActionName(action: string) {
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

export function listPublicActions(): PublicActionDefinition[] {
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

export function readTokenFromSubprotocol(req: http.IncomingMessage) {
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

export function readTokenFromRequest(req: http.IncomingMessage) {
  const fromProtocol = readTokenFromSubprotocol(req);
  if (fromProtocol) {
    return fromProtocol;
  }
  const parsed = new URL(req.url || "/", `http://${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}`);
  const token = readText(parsed.searchParams.get("token"));
  return token ? { token, subprotocol: "" } : null;
}

export function decodeJwtPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function verifyRs256Jwt(token: string, publicKeyPem: string) {
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

export async function verifyDesktopAccessToken(
  app: App,
  token: string,
  ensureIdentityCenterJwk: DesktopWsServerOptions["ensureIdentityCenterJwk"],
  subprotocol?: string
): Promise<DesktopWsAuthSession> {
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
    verifyDesktopAccessToken(options.app, nextToken, options.ensureIdentityCenterJwk, nextSubprotocol)))(token, subprotocol);
}

export function readAuthRefreshReason(payload: Record<string, unknown>): AgentAuthRefreshReason {
  return readText(payload.reason) === "unauthorized" ? "unauthorized" : "missing";
}

export async function issueDesktopWsRefreshAuth(
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

export function refreshDesktopWsConnectionAuth(
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

export function writeUpgradeFailure(socket: Socket, status: number, message: string) {
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

export function writeUpgradeSuccess(socket: Socket, req: http.IncomingMessage, subprotocol?: string) {
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

export function encodeWebSocketFrame(opcode: number, payload: Buffer) {
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

export function sendJson(connection: DesktopWsConnection, payload: DesktopWsOutboundFrame) {
  if (connection.closed) {
    return;
  }
  connection.transport.sendText(JSON.stringify(payload));
}

export function sendResponse(
  connection: DesktopWsConnection,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP,
  type: string,
  id: string,
  data: unknown,
  msg = "success"
) {
  sendJson(connection, { ns: namespace, frame: "response", type, id, code: 0, msg, data });
}

export function sendAgentPlatformError(connection: DesktopWsConnection, id: string | undefined, type: string, code: number, msg: string, data?: unknown) {
  sendJson(connection, { ns: DESKTOP_WS_NAMESPACE_AGENT_PLATFORM, frame: "error", type, id, code, msg, data });
}

export function withAgentPlatformNamespace(frame: Record<string, unknown>): DesktopWsOutboundFrame | null {
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

export class AgentPlatformWsBridge {
  private readonly broker: RealtimeBroker;
  private readonly ownsBroker: boolean;
  private readonly consumerId: string;
  private readonly pendingRequestIds = new Set<string>();
  private unsubscribePush: (() => void) | null = null;

  constructor(
    private readonly options: DesktopWsServerOptions,
    private readonly connection: DesktopWsConnection,
    private readonly logger: Pick<typeof console, "log" | "warn" | "error">
  ) {
    const bridgeOptions = options.agentPlatformBridge;
    this.consumerId = `desktop-ws-ap:${connection.id}`;
    this.ownsBroker = !bridgeOptions?.realtimeBroker;
    this.broker = bridgeOptions?.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: bridgeOptions?.issueAccessToken ?? (async () => ({
        ok: false,
        token: "",
        message: "agent-platform bridge is not configured",
      })),
      getDesktopDeviceId: () => "desktop-main",
      createWebSocket: bridgeOptions?.WebSocketConstructor
        ? (url) => new bridgeOptions.WebSocketConstructor!(url)
        : undefined,
      onDiagnostic: (message) => this.logger.warn?.(`[desktop-ws] ${message}`),
    });
  }

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
    if (this.pendingRequestIds.has(id)) {
      sendAgentPlatformError(this.connection, id, "duplicate_id", 409, "request id is already active");
      return;
    }

    try {
      const availability = await this.resolveAvailability(this.options.agentPlatformBridge);
      await this.ensurePushSubscription(availability.baseUrl, availability.token);
      this.pendingRequestIds.add(id);
      await this.broker.forwardRequest({
        baseUrl: availability.baseUrl,
        token: availability.token,
        localId: id,
        consumerId: this.consumerId,
        type,
        payload: asRecord(req.payload),
        stream: type === "/api/query" || type === "/api/attach",
        onFrame: (frame) => {
          const frameKind = readText(frame.frame);
          const terminalStream = frameKind === "stream" && Boolean(readText(frame.reason));
          if (frameKind === "response" || frameKind === "error" || terminalStream) {
            this.pendingRequestIds.delete(id);
          }
          const namespaced = withAgentPlatformNamespace(frame);
          if (namespaced) {
            sendJson(this.connection, namespaced);
          }
        },
        onError: (error) => {
          this.pendingRequestIds.delete(id);
          sendAgentPlatformError(
            this.connection,
            id,
            error.name || "connection_unavailable",
            503,
            error.message,
          );
        },
      });
    } catch (error) {
      this.pendingRequestIds.delete(id);
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
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    this.broker.cleanupConsumer(this.consumerId);
    this.pendingRequestIds.clear();
    if (this.ownsBroker) {
      this.broker.dispose();
    }
  }

  private async resolveAvailability(bridgeOptions: AgentPlatformBridgeOptions) {
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
    return { baseUrl, token: tokenResult.token.trim() };
  }

  private async ensurePushSubscription(baseUrl: string, token: string) {
    await this.broker.ensureConnected(baseUrl, token);
    if (this.unsubscribePush) {
      return;
    }
    this.unsubscribePush = this.broker.subscribePush({
      types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES].filter((type) =>
        !AGENT_PLATFORM_CONTROL_PUSH_TYPES.has(type),
      ),
      kind: "desktop-ws",
      consumerId: this.consumerId,
      onPush: (frame) => {
        const namespaced = withAgentPlatformNamespace(frame);
        if (namespaced) {
          sendJson(this.connection, namespaced);
        }
      },
    });
  }
}
