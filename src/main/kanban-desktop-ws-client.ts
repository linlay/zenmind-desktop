import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  TaskBoardCurrentUser,
  TaskBoardIssueResult,
  TaskBoardListResult,
  TaskBoardProject
} from "../shared/contracts";
import type { TaskBoardCloudSnapshot } from "./task-board-local-store";

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

type KanbanEnvelope = {
  v?: number;
  frame?: "request" | "response" | "push" | "stream" | string;
  type?: "event" | "rpc.req" | "rpc.res" | string;
  id?: string;
  op?: string;
  role?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  payload?: unknown;
  ok?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
};

type PendingRequest = {
  op: string;
  resolve: (payload: KanbanEnvelope) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type KanbanDesktopConnectionState = NonNullable<TaskBoardListResult["connectionState"]>;

export type KanbanDesktopWsConfig = {
  serverUrl: string;
  token?: string;
  selectedProjectId?: string;
};

export type KanbanDesktopDeviceInfo = {
  deviceName: string;
  deviceAlias?: string;
  hostname?: string;
  username?: string;
};

export type KanbanDesktopWsClientOptions = {
  capabilities: string[];
  getCurrentUser: () => TaskBoardCurrentUser;
  getDeviceId: () => string;
  getDeviceInfo?: () => KanbanDesktopDeviceInfo;
  onSnapshot: (snapshot: TaskBoardCloudSnapshot) => void;
  onDispatchIssue: (
    issue: unknown,
    revision: number
  ) => TaskBoardIssueResult;
  onListAgents: () => Promise<DesktopPetAgentOption[]>;
  onStartRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  onAutomationSync: (payload: unknown) => Promise<unknown>;
  onListLocalProjects: () => Promise<{ ok: boolean; projects: TaskBoardProject[]; message?: string }>;
  onCreateLocalProject: (payload: unknown) => Promise<unknown>;
  onBindProject: (payload: unknown) => Promise<unknown>;
  onUnbindProject: (payload: unknown) => Promise<unknown>;
  onConnected?: () => void;
  onStateChanged?: (state: KanbanDesktopConnectionState) => void;
  onDebug?: (message: string) => void;
};

const PROTOCOL_VERSION = 2;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 5_000;
const WS_OPEN_STATE = 1;

function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function createWsUrl(config: KanbanDesktopWsConfig) {
  const url = new URL("/ws", config.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "desktop");
  url.searchParams.set("v", String(PROTOCOL_VERSION));
  if (config.token?.trim()) {
    url.searchParams.set("token", config.token.trim());
  }
  return url.toString();
}

function createWsLogUrl(config: KanbanDesktopWsConfig) {
  const url = new URL(createWsUrl(config));
  if (url.searchParams.has("token")) {
    url.searchParams.set("token", "***");
  }
  return url.toString();
}

function createRequestId() {
  return `desktop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wsEventDetail(event: unknown) {
  if (!isRecord(event)) {
    return "";
  }
  const parts: string[] = [];
  if (typeof event.type === "string" && event.type) {
    parts.push(`type=${event.type}`);
  }
  if (typeof event.code === "number") {
    parts.push(`code=${event.code}`);
  }
  if (typeof event.reason === "string" && event.reason) {
    parts.push(`reason=${event.reason}`);
  }
  if (typeof event.message === "string" && event.message) {
    parts.push(`message=${event.message}`);
  }
  return parts.join(" ");
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
  if (isRecord(data) && typeof data.text === "function") {
    const text = await (data as { text: () => Promise<unknown> }).text();
    return typeof text === "string" ? text : String(text ?? "");
  }
  if (isRecord(data) && typeof data.arrayBuffer === "function") {
    const buffer = await (data as { arrayBuffer: () => Promise<unknown> }).arrayBuffer();
    if (buffer instanceof ArrayBuffer) {
      return Buffer.from(buffer).toString("utf8");
    }
  }
  return String(data ?? "");
}

function normalizeSnapshot(payload: unknown, env: KanbanEnvelope): TaskBoardCloudSnapshot {
  const record = isRecord(payload) ? payload : {};
  return {
    boardId: readText(record.boardId) || readText(env.boardId),
    projectId: readText(record.projectId) || readText(env.projectId),
    revision: typeof record.revision === "number" ? record.revision : env.revision,
    complete: record.complete === true,
    scope: readText(record.scope),
    projects: Array.isArray(record.projects) ? record.projects : [],
    projectBindings: Array.isArray(record.projectBindings) ? record.projectBindings : [],
    issues: Array.isArray(record.issues) ? record.issues : []
  };
}

function normalizeStartRunPayload(payload: unknown, env: KanbanEnvelope): AssistantStartRunRequest {
  const record = isRecord(payload) ? payload : {};
  const request: AssistantStartRunRequest = {
    message: readText(record.message),
    agentKey: readText(record.agentKey) || undefined,
    accessLevel: normalizeAccessLevel(record.accessLevel),
    chatId: readText(record.chatId) || null,
    source: "sidebar"
  };
  if ("issue" in record) {
    request.issue = record.issue;
  }
  if (typeof env.revision === "number") {
    request.revision = env.revision;
  }
  return request;
}

function normalizeAccessLevel(value: unknown): AssistantStartRunRequest["accessLevel"] | undefined {
  const text = readText(value);
  return text === "default" || text === "auto_approve" || text === "full_access" ? text : undefined;
}

function toV2Type(op: string) {
  const trimmed = op.trim();
  const aliases: Record<string, string> = {
    "desktop.hello": "session.hello",
    "desktop.assistant.listAgents": "agent.listDesktop",
    "desktop.kanban.issue.dispatch": "desktop.issue.dispatch",
    "desktop.automation.sync": "automation.sync",
    "kanban.snapshot": "snapshot.updated",
    "kanban.snapshot.get": "snapshot.get",
    "kanban.issue.assignAndRun": "issue.assignRun",
    "kanban.issue.dispatchToDesktop": "issue.dispatchDesktop"
  };
  if (aliases[trimmed]) {
    return aliases[trimmed];
  }
  return trimmed.startsWith("kanban.") ? trimmed.slice("kanban.".length) : trimmed;
}

function isV2Envelope(env: KanbanEnvelope) {
  return (env.v ?? 0) >= 2 || readText(env.frame) !== "";
}

function envelopeBusinessType(env: KanbanEnvelope) {
  return toV2Type(isV2Envelope(env) ? readText(env.type) : readText(env.op));
}

function isResponseEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) ? env.frame === "response" : env.type === "rpc.res";
}

function isRequestEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env) ? env.frame === "request" : env.type === "rpc.req";
}

function isSnapshotPushEnvelope(env: KanbanEnvelope) {
  return isV2Envelope(env)
    ? env.frame === "push" && envelopeBusinessType(env) === "snapshot.updated"
    : env.op === "kanban.snapshot";
}

export class KanbanDesktopWsClient {
  private ws: MinimalWebSocket | null = null;
  private config: KanbanDesktopWsConfig | null = null;
  private state: KanbanDesktopConnectionState = "disabled";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly options: KanbanDesktopWsClientOptions) {}

  start(config: KanbanDesktopWsConfig | null, options: { forceReconnect?: boolean } = {}) {
    const normalizedConfig = config && config.serverUrl.trim()
      ? {
        serverUrl: config.serverUrl.trim(),
        token: config.token?.trim() ?? "",
        selectedProjectId: config.selectedProjectId?.trim() ?? "default"
      }
      : null;
    this.stopped = false;
    if (!normalizedConfig) {
      this.config = null;
      this.closeWebSocket("kanban desktop ws disabled");
      this.setState("disabled");
      return;
    }
    const previousUrl = this.config ? createWsUrl(this.config) : "";
    const nextUrl = createWsUrl(normalizedConfig);
    const previousProjectId = this.config?.selectedProjectId ?? "";
    this.config = normalizedConfig;
    if (this.ws && previousUrl === nextUrl && previousProjectId === normalizedConfig.selectedProjectId) {
      if (options.forceReconnect) {
        this.connect();
      }
      return;
    }
    if (
      this.ws &&
      previousUrl === nextUrl &&
      previousProjectId !== normalizedConfig.selectedProjectId &&
      this.state === "open"
    ) {
      if (options.forceReconnect) {
        this.connect();
        return;
      }
      // 仅项目变化且连接已打开:走轻量 desktop.project.select,避免整条 WS 重连。
      void this.selectProject(normalizedConfig.selectedProjectId);
      return;
    }
    this.connect();
  }

  private async selectProject(selectedProjectId: string) {
    try {
      await this.request("desktop.project.select", { selectedProjectId });
      this.options.onDebug?.(`云端看板已切换项目：${selectedProjectId}`);
    } catch (error) {
      this.options.onDebug?.(`云端看板项目切换失败，回落重连：${errorMessage(error)}`);
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.rejectAllPending(new Error("kanban desktop ws stopped"));
    this.closeWebSocket("kanban desktop ws stopped");
    this.setState("disabled");
  }

  getState() {
    return this.state;
  }

  isOpen() {
    return this.state === "open" && Boolean(this.ws);
  }

  async request<TPayload = unknown>(op: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TPayload> {
    if (!this.ws || this.state !== "open") {
      throw new Error("云端看板服务未连接。");
    }
    const id = createRequestId();
    const response = await new Promise<KanbanEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${op} 请求超时。`));
          this.handleClosed("error");
        }
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timeout });
      const sent = this.sendEnvelope({
        v: PROTOCOL_VERSION,
        frame: "request",
        type: toV2Type(op),
        id,
        role: "desktop",
        boardId: "default",
        projectId: this.config?.selectedProjectId ?? "default",
        payload
      });
      if (!sent) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error("云端看板服务未连接。"));
      }
    });
    if (response.ok === false) {
      throw new Error(response.error?.message || `${op} 操作失败。`);
    }
    return response.payload as TPayload;
  }

  private connect() {
    const config = this.config;
    if (!config || this.stopped) {
      return;
    }
    const WebSocketConstructor = getWebSocketConstructor();
    if (!WebSocketConstructor) {
      this.options.onDebug?.("当前运行时不支持 WebSocket。");
      this.setState("error");
      this.scheduleReconnect();
      return;
    }
    this.clearReconnectTimer();
    this.closeWebSocket("kanban desktop ws reconnect");
    this.setState("connecting");
    try {
      const wsUrl = createWsUrl(config);
      this.options.onDebug?.(`云端看板 WebSocket 正在连接：${createWsLogUrl(config)}`);
      const socket = new WebSocketConstructor(wsUrl);
      this.ws = socket;
      const onOpen = () => {
        void this.handleOpen();
      };
      const onMessage = (event?: unknown) => {
        const data = isRecord(event) && "data" in event ? event.data : undefined;
        void this.handleMessage(data);
      };
      const onClose = (event?: unknown) => this.handleClosed("closed", wsEventDetail(event));
      const onError = (event?: unknown) => {
        const detail = wsEventDetail(event);
        this.options.onDebug?.(`云端看板 WebSocket 错误${detail ? `：${detail}` : ""}`);
        this.handleClosed("error", detail);
      };
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = (event) => {
          void this.handleMessage(event.data);
        };
        socket.onclose = onClose;
        socket.onerror = onError;
      }
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  private async handleOpen() {
    if (this.stopped) {
      return;
    }
    this.options.onDebug?.("云端看板 WebSocket 已打开。");
    this.setState("open");
    try {
      const agents = await this.options.onListAgents().catch((error) => {
        this.options.onDebug?.(`云端看板 hello 智能体列表读取失败：${errorMessage(error)}`);
        return [];
      });
      await this.request("session.hello", {
        capabilities: this.options.capabilities,
        deviceId: this.options.getDeviceId(),
        ...this.options.getDeviceInfo?.(),
        selectedProjectId: this.config?.selectedProjectId ?? "default",
        currentUser: this.options.getCurrentUser(),
        scope: "project",
        agents
      });
      const snapshot = await this.request<TaskBoardCloudSnapshot>("snapshot.get", {
        projectId: this.config?.selectedProjectId ?? "default"
      });
      this.options.onSnapshot(snapshot);
      this.options.onConnected?.();
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
    }
  }

  private async handleMessage(data: unknown) {
    if (this.stopped) {
      return;
    }
    let raw: string;
    try {
      raw = await decodeMessageData(data);
    } catch (error) {
      this.options.onDebug?.(`云端看板消息读取失败：${errorMessage(error)}`);
      return;
    }
    let env: KanbanEnvelope;
    try {
      env = JSON.parse(raw) as KanbanEnvelope;
    } catch (error) {
      this.options.onDebug?.(`云端看板消息解析失败：${errorMessage(error)}`);
      return;
    }
    if (isResponseEnvelope(env) && env.id) {
      this.options.onDebug?.(`云端看板 WebSocket 收到响应：${envelopeBusinessType(env) || "unknown"} ${env.id}`);
      this.resolvePending(env);
      return;
    }
    if (isRequestEnvelope(env)) {
      this.options.onDebug?.(`云端看板 WebSocket 收到请求：${envelopeBusinessType(env) || "unknown"} ${env.id || ""}`);
      void this.handleServerRequest(env);
      return;
    }
    if (isSnapshotPushEnvelope(env)) {
      this.options.onSnapshot(normalizeSnapshot(env.payload, env));
    }
  }

  private async handleServerRequest(env: KanbanEnvelope) {
    try {
      let payload: unknown;
      const businessType = envelopeBusinessType(env);
      if (businessType === "desktop.issue.dispatch") {
        const record = isRecord(env.payload) ? env.payload : {};
        const issue = "issue" in record ? record.issue : env.payload;
        payload = this.options.onDispatchIssue(issue, env.revision ?? 0);
      } else if (businessType === "agent.listDesktop") {
        const agents = await this.options.onListAgents();
        payload = { ok: true, items: agents, agents };
      } else if (businessType === "desktop.assistant.startRun") {
        payload = await this.options.onStartRun(normalizeStartRunPayload(env.payload, env));
      } else if (businessType === "automation.sync") {
        payload = await this.options.onAutomationSync(env.payload);
      } else if (businessType === "desktop.project.listLocal") {
        payload = await this.options.onListLocalProjects();
      } else if (businessType === "desktop.project.createLocal") {
        payload = await this.options.onCreateLocalProject(env.payload);
      } else if (businessType === "desktop.project.bind") {
        payload = await this.options.onBindProject(env.payload);
      } else if (businessType === "desktop.project.unbind") {
        payload = await this.options.onUnbindProject(env.payload);
      } else {
        throw new Error(`Desktop 不支持 ${businessType || "unknown"}。`);
      }
      this.options.onDebug?.(`云端看板 WebSocket 回复请求：${businessType || "unknown"} ${env.id || ""}`);
      this.respond(env, true, payload);
    } catch (error) {
      this.respond(env, false, {
        ok: false,
        message: errorMessage(error)
      }, errorMessage(error));
    }
  }

  private resolvePending(env: KanbanEnvelope) {
    const pending = env.id ? this.pending.get(env.id) : undefined;
    if (!pending || !env.id) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(env.id);
    if (env.ok === false) {
      pending.reject(new Error(env.error?.message || `${pending.op} 操作失败。`));
      return;
    }
    pending.resolve(env);
  }

  private respond(env: KanbanEnvelope, ok: boolean, payload: unknown, message = "") {
    if (isV2Envelope(env)) {
      return this.sendEnvelope({
        v: PROTOCOL_VERSION,
        frame: "response",
        type: envelopeBusinessType(env),
        id: env.id,
        role: "desktop",
        boardId: env.boardId ?? "default",
        projectId: env.projectId ?? this.config?.selectedProjectId ?? "default",
        revision: env.revision,
        ok,
        error: ok ? undefined : { code: "desktop_error", message: message || "Desktop 操作失败。" },
        payload
      });
    }
    return this.sendEnvelope({
      v: 1,
      type: "rpc.res",
      id: env.id,
      op: env.op,
      role: "desktop",
      boardId: env.boardId ?? "default",
      projectId: env.projectId ?? this.config?.selectedProjectId ?? "default",
      revision: env.revision,
      ok,
      error: ok ? undefined : { code: "desktop_error", message: message || "Desktop 操作失败。" },
      payload
    });
  }

  private sendEnvelope(env: KanbanEnvelope) {
    const socket = this.ws;
    if (!socket || !this.isSocketReady(socket)) {
      this.options.onDebug?.(`云端看板 WebSocket 发送失败：socket 未就绪 readyState=${socket?.readyState ?? "none"}`);
      this.handleClosed("error");
      return false;
    }
    try {
      socket.send(JSON.stringify(env));
      if (isResponseEnvelope(env)) {
        this.options.onDebug?.(`云端看板 WebSocket 已发送响应：${envelopeBusinessType(env) || "unknown"} ${env.id || ""}`);
      }
      return true;
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
      this.handleClosed("error");
      return false;
    }
  }

  private isSocketReady(socket: MinimalWebSocket) {
    return typeof socket.readyState !== "number" || socket.readyState === WS_OPEN_STATE;
  }

  private handleClosed(nextState: "closed" | "error", detail = "") {
    if (this.stopped) {
      return;
    }
    this.options.onDebug?.(`云端看板 WebSocket 已断开${detail ? `：${detail}` : ""}`);
    this.rejectAllPending(new Error("云端看板连接已断开。"));
    this.closeWebSocket(`kanban desktop ws ${nextState}`);
    this.setState(nextState);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || !this.config || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private closeWebSocket(reason: string) {
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
      socket.close(1000, reason);
    } catch {
      // Ignore close failures for sockets that are already closing.
    }
  }

  private rejectAllPending(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: KanbanDesktopConnectionState) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChanged?.(state);
  }
}
