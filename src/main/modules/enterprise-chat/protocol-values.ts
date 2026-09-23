import type { EpochMilliseconds } from "../../../shared/time-contract";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readEpochMilliseconds(value: unknown): EpochMilliseconds {
  return Math.max(0, Math.trunc(readNumber(value))) as EpochMilliseconds;
}

export function nowEpochMilliseconds() {
  return Date.now() as EpochMilliseconds;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
