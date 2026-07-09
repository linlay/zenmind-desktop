import type { WebContents } from "electron";

export const DESKTOP_CDP_TARGET_TIMEOUT_CODE = "target_timeout";
export const DESKTOP_CDP_SEND_COMMAND_TIMEOUT_MS = 12_000;

type DesktopCdpDebugger = WebContents["debugger"];
type DesktopCdpLogger = Pick<Console, "debug" | "warn">;

export type DesktopCdpCommandDebugContext = {
  targetId?: string;
  surfaceId?: string;
  webContentsId?: number;
  url?: string;
  title?: string;
  timeoutMs?: number;
  logger?: DesktopCdpLogger;
};

export type DesktopCdpCommandDebugDetails = {
  method: string;
  targetId?: string;
  surfaceId?: string;
  webContentsId?: number;
  url?: string;
  title?: string;
  paramKeys: string[];
  timeoutMs: number;
  elapsedMs?: number;
};

export class DesktopCdpTimeoutError extends Error {
  readonly code = DESKTOP_CDP_TARGET_TIMEOUT_CODE;
  readonly details: DesktopCdpCommandDebugDetails;

  constructor(details: DesktopCdpCommandDebugDetails) {
    super(`CDP target timed out after ${details.timeoutMs}ms while running ${details.method}.`);
    this.name = "DesktopCdpTimeoutError";
    this.details = details;
  }
}

function normalizeTimeoutMs(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DESKTOP_CDP_SEND_COMMAND_TIMEOUT_MS;
}

function readParamKeys(params: Record<string, unknown>) {
  return Object.keys(params).sort();
}

function truncateDebugValue(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sanitizeDebugUrl(value: unknown) {
  const raw = truncateDebugValue(value, 240);
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactDetails(details: DesktopCdpCommandDebugDetails) {
  return {
    method: details.method,
    ...(details.targetId ? { targetId: details.targetId } : {}),
    ...(details.surfaceId ? { surfaceId: details.surfaceId } : {}),
    ...(typeof details.webContentsId === "number" ? { webContentsId: details.webContentsId } : {}),
    ...(details.url ? { url: details.url } : {}),
    ...(details.title ? { title: details.title } : {}),
    paramKeys: details.paramKeys,
    timeoutMs: details.timeoutMs,
    ...(typeof details.elapsedMs === "number" ? { elapsedMs: details.elapsedMs } : {})
  };
}

export function isDesktopCdpTimeoutError(error: unknown): error is DesktopCdpTimeoutError {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === DESKTOP_CDP_TARGET_TIMEOUT_CODE);
}

export function readDesktopCdpErrorDetails(error: unknown) {
  return isDesktopCdpTimeoutError(error) ? error.details : undefined;
}

export async function sendDesktopCdpCommand(
  debuggerRef: DesktopCdpDebugger,
  method: string,
  params: Record<string, unknown> = {},
  context: DesktopCdpCommandDebugContext = {}
) {
  const startedAt = Date.now();
  const timeoutMs = normalizeTimeoutMs(context.timeoutMs);
  const logger = context.logger ?? console;
  const baseDetails: DesktopCdpCommandDebugDetails = {
    method,
    ...(context.targetId ? { targetId: context.targetId } : {}),
    ...(context.surfaceId ? { surfaceId: context.surfaceId } : {}),
    ...(typeof context.webContentsId === "number" ? { webContentsId: context.webContentsId } : {}),
    ...(context.url ? { url: sanitizeDebugUrl(context.url) } : {}),
    ...(context.title ? { title: truncateDebugValue(context.title, 160) } : {}),
    paramKeys: readParamKeys(params),
    timeoutMs
  };
  let timeout: NodeJS.Timeout | null = null;

  logger.debug?.("[desktop-cdp] start", compactDetails(baseDetails));
  try {
    const commandPromise = debuggerRef.sendCommand(method, params);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new DesktopCdpTimeoutError({
          ...baseDetails,
          elapsedMs: Date.now() - startedAt
        }));
      }, timeoutMs);
    });
    const result = await Promise.race([commandPromise, timeoutPromise]);
    logger.debug?.("[desktop-cdp] success", compactDetails({
      ...baseDetails,
      elapsedMs: Date.now() - startedAt
    }));
    return result;
  } catch (error) {
    if (isDesktopCdpTimeoutError(error)) {
      logger.warn?.("[desktop-cdp] timeout", compactDetails(error.details));
    } else {
      logger.warn?.("[desktop-cdp] failed", {
        ...compactDetails({
          ...baseDetails,
          elapsedMs: Date.now() - startedAt
        }),
        error: messageFromError(error)
      });
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export const __testInternals = {
  compactDetails,
  normalizeTimeoutMs,
  readParamKeys,
  sanitizeDebugUrl
};
