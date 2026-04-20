import type { AgentAuthRefreshReason, DesktopApi, ServiceState } from "../../shared/contracts";

const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";

export type AgentGatewayEvent = Record<string, unknown> & {
  type?: string;
};

export interface AgentGateway {
  baseUrl: string;
  service: ServiceState;
}

export interface EnsureAgentGatewayOptions {
  autoStart?: boolean;
  services?: ServiceState[];
}

export interface AgentQueryParams {
  message: string;
  requestId?: string;
  agentKey?: string;
  teamId?: string;
  chatId?: string;
  references?: unknown[];
  params?: Record<string, unknown>;
  planningMode?: boolean;
  signal?: AbortSignal;
  onEvent: (event: AgentGatewayEvent) => void;
}

export interface AgentGatewayJsonRequestOptions extends EnsureAgentGatewayOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  signal?: AbortSignal;
  retryUnauthorized?: boolean;
}

interface ParsedSseFrame {
  event?: string;
  data: string;
}

export class AgentGatewayError extends Error {
  name = "AgentGatewayError";
  status: number | null;
  data: unknown;

  constructor(
    message: string,
    details: {
      status?: number | null;
      data?: unknown;
    } = {},
  ) {
    super(message);
    this.status = details.status ?? null;
    this.data = details.data;
  }
}

function getDesktopApi() {
  if (typeof window === "undefined") {
    throw new AgentGatewayError("Desktop API 不可用，无法访问小宅助理服务。");
  }
  const api = (window as Window & typeof globalThis & { electronAPI?: DesktopApi }).electronAPI;
  if (!api) {
    throw new AgentGatewayError("Desktop API 不可用，无法访问小宅助理服务。");
  }
  return api;
}

function normalizeBaseUrl(value: string): string {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function findAgentWebclient(services: ServiceState[]): ServiceState | null {
  return services.find((service) => service.id === AGENT_WEBCLIENT_SERVICE_ID) ?? null;
}

function resolveServiceBaseUrl(service: ServiceState | null): string {
  return normalizeBaseUrl(service?.healthMeta.webUrl ?? "");
}

function assertServiceBaseUrl(service: ServiceState | null, context: string): string {
  const baseUrl = resolveServiceBaseUrl(service);
  if (!baseUrl) {
    const label = service?.name || "小宅助理";
    throw new AgentGatewayError(`${context}：${label} 未提供可用的 webUrl。`);
  }
  return baseUrl;
}

function resolveUrl(baseUrl: string, path: string): string {
  const rawPath = String(path || "").trim();
  if (!rawPath) {
    return baseUrl;
  }
  try {
    return new URL(rawPath).toString();
  } catch {
    return new URL(rawPath, `${baseUrl}/`).toString();
  }
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isJsonBody(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return false;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return false;
  }
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
    return false;
  }
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
    return false;
  }
  return true;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

async function issueAccessToken(reason: AgentAuthRefreshReason): Promise<string> {
  const result = await getDesktopApi().agentAuth.issueAccessToken(reason);
  const token = String(result.token || "").trim();
  if (!result.ok || !token) {
    throw new AgentGatewayError(
      result.message || "Desktop AGENT access token 签发失败。",
    );
  }
  return token;
}

async function readResponseError(response: Response, fallbackMessage: string): Promise<AgentGatewayError> {
  const rawText = await response.text().catch(() => "");
  const trimmed = rawText.trim();
  if (!trimmed) {
    return new AgentGatewayError(fallbackMessage, {
      status: response.status,
      data: rawText,
    });
  }

  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      typeof json.msg === "string" && json.msg.trim()
        ? json.msg.trim()
        : typeof json.message === "string" && json.message.trim()
          ? json.message.trim()
          : fallbackMessage;
    return new AgentGatewayError(message, {
      status: response.status,
      data: json,
    });
  } catch {
    return new AgentGatewayError(trimmed || fallbackMessage, {
      status: response.status,
      data: rawText,
    });
  }
}

function parseSseFrame(block: string): ParsedSseFrame | null {
  const lines = block.split(/\r?\n/u);
  let eventName = "";
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }
    if (rawLine.startsWith("event:")) {
      eventName = rawLine.slice(6).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event: eventName || undefined,
    data: dataLines.join("\n"),
  };
}

function toAgentGatewayEvent(frame: ParsedSseFrame): AgentGatewayEvent | null {
  if (!frame.data || frame.data === "[DONE]") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch (error) {
    throw new AgentGatewayError(
      `SSE 事件解析失败：${error instanceof Error ? error.message : String(error)}`,
      { data: frame.data },
    );
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentGatewayError("SSE 事件不是有效对象。", {
      data: parsed,
    });
  }

  const event = parsed as AgentGatewayEvent;
  if (frame.event && (typeof event.type !== "string" || !event.type.trim())) {
    event.type = frame.event;
  }
  return event;
}

async function consumeSseStream(
  response: Response,
  onEvent: (event: AgentGatewayEvent) => void,
): Promise<void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = (block: string) => {
    const frame = parseSseFrame(block);
    if (!frame) {
      return;
    }
    const event = toAgentGatewayEvent(frame);
    if (event) {
      onEvent(event);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), {
        stream: !done,
      });

      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        flushBlock(block);
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (buffer.trim()) {
    flushBlock(buffer);
  }
}

export async function ensureAgentGateway(
  options: EnsureAgentGatewayOptions = {},
): Promise<AgentGateway> {
  const autoStart = options.autoStart ?? true;
  const desktopApi = getDesktopApi();
  const services = options.services ?? await desktopApi.services.list();
  const service = findAgentWebclient(services);

  if (!service) {
    throw new AgentGatewayError("未注册小宅助理服务 agent-webclient。");
  }

  if (service.status === "running") {
    return {
      baseUrl: assertServiceBaseUrl(service, "小宅助理服务已运行"),
      service,
    };
  }

  if (!autoStart) {
    throw new AgentGatewayError(`小宅助理服务未运行：${service.statusLabel || service.status}`);
  }

  const result = await desktopApi.services.start(AGENT_WEBCLIENT_SERVICE_ID);
  if (!result.ok) {
    throw new AgentGatewayError(result.message || "启动小宅助理服务失败。", {
      data: result,
    });
  }

  return {
    baseUrl: assertServiceBaseUrl(result.service, "小宅助理服务启动成功"),
    service: result.service,
  };
}

async function fetchWithAgentAuth(
  url: string,
  init: RequestInit,
  options: { retryUnauthorized?: boolean } = {},
): Promise<Response> {
  const retryUnauthorized = options.retryUnauthorized ?? true;
  let token = await issueAccessToken("missing");

  const buildInit = (): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });

  let response = await fetch(url, buildInit());
  if (retryUnauthorized && response.status === 401) {
    token = await issueAccessToken("unauthorized");
    response = await fetch(url, buildInit());
  }
  return response;
}

export async function requestAgentJson<T = unknown>(
  path: string,
  options: AgentGatewayJsonRequestOptions = {},
): Promise<T> {
  const { baseUrl } = await ensureAgentGateway(options);
  const body = options.body;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  let requestBody = body as BodyInit | null | undefined;

  if (isJsonBody(body)) {
    requestBody = JSON.stringify(body);
    if (!hasHeader(headers, "Content-Type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetchWithAgentAuth(
    resolveUrl(baseUrl, path),
    {
      method: options.method || (requestBody == null ? "GET" : "POST"),
      headers,
      body: requestBody,
      signal: options.signal,
    },
    { retryUnauthorized: options.retryUnauthorized },
  );

  if (!response.ok) {
    throw await readResponseError(response, `Agent Gateway 请求失败 (${response.status})`);
  }

  const rawText = await response.text();
  if (!rawText.trim()) {
    return null as T;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch (error) {
    throw new AgentGatewayError(
      `Agent Gateway JSON 响应解析失败：${error instanceof Error ? error.message : String(error)}`,
      { data: rawText },
    );
  }
}

export async function streamAgentQuery(params: AgentQueryParams): Promise<void> {
  const { baseUrl } = await ensureAgentGateway();
  const requestId = String(params.requestId || createRequestId()).trim();
  const body: Record<string, unknown> = {
    requestId,
    planningMode: params.planningMode ?? false,
    message: params.message,
  };

  if (params.agentKey) body.agentKey = params.agentKey;
  if (params.teamId) body.teamId = params.teamId;
  if (params.chatId) body.chatId = params.chatId;
  if (params.references !== undefined) body.references = params.references;
  if (params.params !== undefined) body.params = params.params;

  const response = await fetchWithAgentAuth(
    resolveUrl(baseUrl, "/api/query"),
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: params.signal,
    },
  );

  if (!response.ok) {
    throw await readResponseError(response, `Agent Gateway 流式请求失败 (${response.status})`);
  }

  await consumeSseStream(response, params.onEvent);
}
