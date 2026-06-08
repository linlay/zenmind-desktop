import { randomUUID } from "node:crypto";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption,
  TaskBoardCurrentUser,
  TaskBoardIssueResult,
  TaskBoardListResult
} from "../shared/contracts";
import type { TaskBoardCloudSnapshot } from "./task-board-local-store";

type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

type KanbanEnvelope = {
  v?: number;
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

export type KanbanDesktopWsClientOptions = {
  capabilities: string[];
  getCurrentUser: () => TaskBoardCurrentUser;
  getDeviceId: () => string;
  onSnapshot: (snapshot: TaskBoardCloudSnapshot) => void;
  onDispatchIssue: (issue: unknown, revision: number) => TaskBoardIssueResult;
  onListAgents: () => Promise<DesktopPetAgentOption[]>;
  onStartRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  onAutomationSync: (payload: unknown) => Promise<unknown>;
  onStateChanged?: (state: KanbanDesktopConnectionState) => void;
  onDebug?: (message: string) => void;
};

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 5_000;

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
  if (config.token?.trim()) {
    url.searchParams.set("token", config.token.trim());
  }
  return url.toString();
}

function createRequestId() {
  return `desktop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSnapshot(payload: unknown, env: KanbanEnvelope): TaskBoardCloudSnapshot {
  const record = isRecord(payload) ? payload : {};
  return {
    boardId: readText(record.boardId) || readText(env.boardId),
    projectId: readText(record.projectId) || readText(env.projectId),
    revision: typeof record.revision === "number" ? record.revision : env.revision,
    issues: Array.isArray(record.issues) ? record.issues : []
  };
}

function normalizeStartRunPayload(payload: unknown): AssistantStartRunRequest {
  const record = isRecord(payload) ? payload : {};
  return {
    message: readText(record.message),
    agentKey: readText(record.agentKey) || undefined,
    chatId: readText(record.chatId) || null,
    source: "sidebar"
  };
}

export class KanbanDesktopWsClient {
  private ws: MinimalWebSocket | null = null;
  private config: KanbanDesktopWsConfig | null = null;
  private state: KanbanDesktopConnectionState = "disabled";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly options: KanbanDesktopWsClientOptions) {}

  start(config: KanbanDesktopWsConfig | null) {
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
      return;
    }
    this.connect();
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
        this.pending.delete(id);
        reject(new Error(`${op} 请求超时。`));
      }, timeoutMs);
      this.pending.set(id, { op, resolve, reject, timeout });
      this.sendEnvelope({
        v: PROTOCOL_VERSION,
        type: "rpc.req",
        id,
        op,
        role: "desktop",
        boardId: "default",
        projectId: this.config?.selectedProjectId ?? "default",
        payload
      });
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
      const socket = new WebSocketConstructor(createWsUrl(config));
      this.ws = socket;
      socket.onopen = () => this.handleOpen();
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onclose = () => this.handleClosed("closed");
      socket.onerror = () => this.handleClosed("error");
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
    this.setState("open");
    try {
      await this.request("desktop.hello", {
        capabilities: this.options.capabilities,
        deviceId: this.options.getDeviceId(),
        selectedProjectId: this.config?.selectedProjectId ?? "default",
        currentUser: this.options.getCurrentUser(),
        scope: "current_user"
      });
      const snapshot = await this.request<TaskBoardCloudSnapshot>("kanban.snapshot.get", {
        projectId: this.config?.selectedProjectId ?? "default"
      });
      this.options.onSnapshot(snapshot);
    } catch (error) {
      this.options.onDebug?.(errorMessage(error));
    }
  }

  private handleMessage(data: unknown) {
    if (this.stopped) {
      return;
    }
    const raw = typeof data === "string" ? data : String(data ?? "");
    let env: KanbanEnvelope;
    try {
      env = JSON.parse(raw) as KanbanEnvelope;
    } catch {
      return;
    }
    if (env.type === "rpc.res" && env.id) {
      this.resolvePending(env);
      return;
    }
    if (env.type === "rpc.req") {
      void this.handleServerRequest(env);
      return;
    }
    if (env.op === "kanban.snapshot") {
      this.options.onSnapshot(normalizeSnapshot(env.payload, env));
    }
  }

  private async handleServerRequest(env: KanbanEnvelope) {
    try {
      let payload: unknown;
      if (env.op === "desktop.kanban.issue.dispatch") {
        const record = isRecord(env.payload) ? env.payload : {};
        const issue = "issue" in record ? record.issue : env.payload;
        payload = this.options.onDispatchIssue(issue, env.revision ?? 0);
      } else if (env.op === "desktop.assistant.listAgents") {
        const agents = await this.options.onListAgents();
        payload = { ok: true, items: agents, agents };
      } else if (env.op === "desktop.assistant.startRun") {
        payload = await this.options.onStartRun(normalizeStartRunPayload(env.payload));
      } else if (env.op === "desktop.automation.sync") {
        payload = await this.options.onAutomationSync(env.payload);
      } else {
        throw new Error(`Desktop 不支持 ${env.op || "unknown"}。`);
      }
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
    this.sendEnvelope({
      v: PROTOCOL_VERSION,
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
    if (!this.ws) {
      throw new Error("云端看板服务未连接。");
    }
    this.ws.send(JSON.stringify(env));
  }

  private handleClosed(nextState: "closed" | "error") {
    if (this.stopped) {
      return;
    }
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
