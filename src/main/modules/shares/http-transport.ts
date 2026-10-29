import { requireEpochMillis } from "../../../shared/time-contract";
import { isTunnelHubForbiddenHostname, isTunnelHubLoopbackHostname } from "../tunnel";
export type ShareTarget = { origin: string; accessToken: string; signal?: AbortSignal };
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
export class ShareHttpError extends Error {
  constructor(readonly kind: "invalid_request" | "timeout" | "unavailable" | "rejected" | "invalid_response", readonly status?: number, readonly code?: string) {
    super(`Share request failed: ${kind}`);
    this.name = "ShareHttpError";
  }
}
export class ShareHttpTransport {
  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}
  protected async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        credentials: "omit",
      });
    } catch (error) {
      if (error instanceof ShareHttpError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new ShareHttpError("timeout");
      }
      throw new ShareHttpError("unavailable");
    }
  }
}

export function authorizationHeaders(target: ShareTarget): Record<string, string> {
  return { Authorization: `Bearer ${target.accessToken}` };
}

export function requireValidTarget(target: ShareTarget): void {
  if (!isValidTunnelApiOrigin(target.origin) || typeof target.accessToken !== "string" || !/^[^\s]+$/u.test(target.accessToken)) {
    throw new ShareHttpError("invalid_request");
  }
}

export function isValidTunnelApiOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const loopback = isTunnelHubLoopbackHostname(parsed.hostname);
    return value === parsed.origin &&
      !parsed.username &&
      !parsed.password &&
      !isTunnelHubForbiddenHostname(parsed.hostname) &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
  } catch {
    return false;
  }
}

export async function requireStatus(response: Response, expectedStatus: number): Promise<void> {
  if (response.status === expectedStatus) {
    return;
  }
  let code: string | undefined;
  if (response.status === 413) {
    try {
      const value = await readLimitedJson(response);
      if (isRecord(value) && typeof value.code === "string" &&
        ["snapshot_too_large", "resources_too_large", "request_body_too_large"].includes(value.code)) code = value.code;
    } catch { /* Unknown gateway responses use the generic upload error. */ }
  }
  await discardResponseBody(response);
  throw new ShareHttpError("rejected", response.status, code);
}

export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A response body is deliberately never surfaced through share errors.
  }
}

export async function readLimitedJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await discardResponseBody(response);
    throw new ShareHttpError("invalid_response");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_JSON_RESPONSE_BYTES) {
      await discardResponseBody(response);
      throw new ShareHttpError("invalid_response");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ShareHttpError("invalid_response");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ShareHttpError("invalid_response");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof ShareHttpError) {
      throw error;
    }
    throw new ShareHttpError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

export function readRequiredRfc3339(value: unknown) {
  if (typeof value !== "string") {
    throw new ShareHttpError("invalid_response");
  }
  const match = RFC3339_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new ShareHttpError("invalid_response");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    !isValidRfc3339Zone(zoneText)
  ) {
    throw new ShareHttpError("invalid_response");
  }
  return requireEpochMillis(Date.parse(value), "share.timestamp");
}

export function readNullableRfc3339(value: unknown) {
  if (value === null) {
    return null;
  }
  return readRequiredRfc3339(value);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidRfc3339Zone(value: string): boolean {
  if (value === "Z") {
    return true;
  }
  const hour = Number(value.slice(1, 3));
  const minute = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function readTrimmedString(value: unknown): string {
  return typeof value === "string" && value.trim() === value ? value : "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}
