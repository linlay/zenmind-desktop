import type { MinimalWebSocketConstructor, KanbanDesktopWsConfig } from "./ws-model";
import { PROTOCOL_VERSION, CONTRACT_VERSION } from "./ws-protocol";
import { randomUUID } from "node:crypto";
import { isRecord } from "./ws-values";
import { Buffer } from "node:buffer";

export function getWebSocketConstructor(): MinimalWebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : null;
}

export function createWsUrl(config: KanbanDesktopWsConfig) {
  const url = new URL("/ws", config.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "desktop");
  url.searchParams.set("v", String(PROTOCOL_VERSION));
  url.searchParams.set("contractVersion", CONTRACT_VERSION);
  if (config.token?.trim()) {
    url.searchParams.set("token", config.token.trim());
  }
  return url.toString();
}

export function createWsLogUrl(config: KanbanDesktopWsConfig) {
  const url = new URL(createWsUrl(config));
  if (url.searchParams.has("token")) {
    url.searchParams.set("token", "***");
  }
  return url.toString();
}

export function createRequestId() {
  return `desktop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function wsEventDetail(event: unknown) {
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

export async function decodeMessageData(data: unknown) {
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
