import { DESKTOP_WS_NAMESPACE_FIELD, DESKTOP_WS_NAMESPACE_DESKTOP } from "../../../shared/desktop-ws";
import crypto from "node:crypto";

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
