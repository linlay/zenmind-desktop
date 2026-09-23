import type {
  EnterpriseChatUser
} from "../../../shared/contracts";
import { isRecord, readText } from "./protocol-values";
import {
  normalizeEnterpriseImBaseUrl
} from "./settings";

export const ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS = 15_000;

export const ENTERPRISE_CHAT_RECONNECT_MAX_MS = 30_000;

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export type WebSocketMessageEventLike = { data: unknown };

export type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

export type PendingWebSocketRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ServerSession = {
  token: string;
  expiresAt: number;
  user: EnterpriseChatUser;
};

export class EnterpriseChatRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizeServerUrl(value: string | undefined) {
  if (!readText(value)) return "";
  const normalized = normalizeEnterpriseImBaseUrl(readText(value));
  if (!normalized) {
    throw new Error("IM server base URL must use loopback HTTP or remote HTTPS.");
  }
  return normalized;
}

export function toWebSocketUrl(serverUrl: string, ticket: string) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws`;
  url.search = "";
  url.searchParams.set("v", "1");
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export function createDefaultWebSocket(url: string): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as unknown as { WebSocket?: new (targetUrl: string) => WebSocketLike }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("This Desktop runtime does not provide WebSocket support.");
  }
  return new WebSocketConstructor(url);
}

export async function readWebSocketText(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (isRecord(data) && typeof data.text === "function") {
    return String(await (data.text as () => Promise<string>)());
  }
  return "";
}
