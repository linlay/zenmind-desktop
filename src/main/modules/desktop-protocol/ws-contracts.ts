import {
  DESKTOP_WS_NAMESPACE_DESKTOP,
  DESKTOP_WS_NAMESPACE_AGENT_PLATFORM,
  DESKTOP_WS_NAMESPACE_WEBAPP,
  type DesktopWsPushType
} from "../../../shared/desktop-ws";
import { type App } from "electron";
import {
  type ServiceState,
  type AgentAuthRefreshReason,
  type AgentAuthIssueResult,
  type AssistantStartRunRequest,
  type AssistantStartRunResult,
  type DesktopMobileWebappCatalog,
  type DesktopWsServerState
} from "../../../shared/contracts";
import { RealtimeBroker } from "../agent-platform";
import { handleDesktopActionRequest } from "../desktop-actions";
import { type KanbanRuntime } from "../kanban";
import http from "node:http";
import { type DesktopActionDefinition } from "../../../shared/desktop-actions";

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
  agentPlatformBridge: { forwardRequest(req: DesktopWsRequestFrame): Promise<void>; close(): void } | null;
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
