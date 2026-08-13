import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import type { App } from "electron";
import type {
  DesktopLogTarget,
  ServiceLogReadOptions,
  ServiceLogReadResult,
  ServiceLogStreamEvent,
  ServiceLogStreamOptions
} from "../../shared/contracts";
import { getLogsRoot } from "../user-paths";
import {
  LOG_READ_WINDOW_BYTES,
  normalizeLogStreamOffset,
  normalizeLogStreamPollInterval,
  readLogRange,
  readServiceLogFile
} from "../services/manager/logs";

type ConsoleWriter = (...args: unknown[]) => void;
type DesktopLogStreamCallback = (event: ServiceLogStreamEvent) => void;

const DESKTOP_LOG_SERVICE_ID = "desktop";
const KANBAN_WS_LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const REDACTED_LOG_VALUE = "[REDACTED]";
const REDACTED_LOCAL_PAYLOAD = "[REDACTED_LOCAL_PAYLOAD]";
let consoleTeeInstalled = false;

function getDesktopLogPath(app: App, target: DesktopLogTarget) {
  const filename = target === "error"
    ? "error.log"
    : target === "kanban-ws"
      ? "kanban-ws.log"
      : "main.log";
  return path.join(getDesktopLogRoot(app), filename);
}

function normalizeDesktopLogTarget(target: unknown): DesktopLogTarget {
  if (target === "error" || target === "kanban-ws") {
    return target;
  }
  return "main";
}

function stringifyConsoleArgs(args: unknown[]) {
  return args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    return util.inspect(arg, {
      depth: 8,
      breakLength: 160,
      compact: false
    });
  }).join(" ");
}

function appendDesktopLogLine(filePath: string, line: string) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, "utf8");
  } catch {
    // Logging must never break the Desktop process.
  }
}

function trimLogFileToLimit(filePath: string, limitBytes: number) {
  const stat = fs.statSync(filePath);
  if (stat.size <= limitBytes) {
    return;
  }
  const readStart = Math.max(0, stat.size - limitBytes);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - readStart);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, readStart);
    const content = buffer.subarray(0, bytesRead);
    const firstNewline = content.indexOf(0x0a);
    fs.writeFileSync(filePath, firstNewline === -1 ? "" : content.subarray(firstNewline + 1));
  } finally {
    fs.closeSync(descriptor);
  }
}

function createConsoleTee(
  app: App,
  originalWriter: ConsoleWriter,
  level: "debug" | "error" | "info" | "log" | "warn"
): ConsoleWriter {
  return (...args: unknown[]) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${stringifyConsoleArgs(args)}\n`;
    appendDesktopLogLine(getDesktopLogPath(app, "main"), line);
    if (level === "error") {
      appendDesktopLogLine(getDesktopLogPath(app, "error"), line);
    }
    originalWriter(...args);
  };
}

export function getDesktopLogRoot(app: App) {
  const root = path.join(getLogsRoot(app), "desktop");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function asLogRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { event: "diagnostic", message: String(value ?? "") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveLogKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return [
    "token",
    "authtoken",
    "authentication",
    "authorization",
    "cookie",
    "session",
    "secret",
    "password",
    "apikey",
    "accesskey",
    "privatekey",
    "credential"
  ].some((fragment) => normalized.includes(fragment));
}

function isLocalFilePath(value: string) {
  return /^file:/iu.test(value) || /^\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value);
}

function redactLocalPathsInText(value: string) {
  return value.replace(
    /(^|[\s("'=])(?:file:\/\/|\/)[^\s"'<>]+|(^|[\s("'=])[A-Za-z]:[\\/][^\s"'<>]+/gmu,
    (_match, unixPrefix = "", windowsPrefix = "") => `${unixPrefix || windowsPrefix}${REDACTED_LOG_VALUE}`
  );
}

function redactSensitiveUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return redactLocalPathsInText(value);
    }
    if (url.username || url.password) {
      url.username = REDACTED_LOG_VALUE;
      url.password = REDACTED_LOG_VALUE;
    }
    for (const [key] of url.searchParams) {
      if (isSensitiveLogKey(key)) {
        url.searchParams.set(key, REDACTED_LOG_VALUE);
      }
    }
    return redactLocalPathsInText(url.toString());
  } catch {
    return redactLocalPathsInText(value)
      .replace(/(bearer\s+)[^\s,;]+/giu, `$1${REDACTED_LOG_VALUE}`)
      .replace(/\b(authorization|cookie|set-cookie|token|api[_-]?key|password)\s*[:=]\s*[^\s,;]+/giu, `$1=${REDACTED_LOG_VALUE}`)
      .replace(/([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|authorization|password)=)[^&#\s]*/giu, `$1${REDACTED_LOG_VALUE}`);
  }
}

function sanitizeKanbanWsLogValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    if ((key === "filePath" || key === "localFilePath" || key === "path") && isLocalFilePath(value)) {
      return REDACTED_LOG_VALUE;
    }
    return redactSensitiveUrl(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeKanbanWsLogValue(item, "", seen));
  }
  if (!isRecord(value)) {
    return String(value);
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  if ("syncMode" in value && value.syncMode !== "cloud") {
    return REDACTED_LOCAL_PAYLOAD;
  }
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = isSensitiveLogKey(childKey)
      ? REDACTED_LOG_VALUE
      : sanitizeKanbanWsLogValue(childValue, childKey, seen);
  }
  seen.delete(value);
  return sanitized;
}

export function appendKanbanWsLog(app: App, entry: unknown) {
  try {
    const filePath = getDesktopLogPath(app, "kanban-ws");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      trimLogFileToLimit(filePath, KANBAN_WS_LOG_LIMIT_BYTES);
    }
    const sanitizedEntry = sanitizeKanbanWsLogValue(asLogRecord(entry));
    const record = isRecord(sanitizedEntry)
      ? sanitizedEntry
      : { event: "diagnostic", data: sanitizedEntry };
    let line = JSON.stringify({ timestamp: new Date().toISOString(), ...record });
    if (Buffer.byteLength(line, "utf8") > KANBAN_WS_LOG_LIMIT_BYTES) {
      line = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "entry-omitted",
        message: "Kanban WS log entry exceeded the 10 MiB retention limit."
      });
    }
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
    trimLogFileToLimit(filePath, KANBAN_WS_LOG_LIMIT_BYTES);
  } catch {
    // Kanban diagnostics must never interrupt the WebSocket client.
  }
}

export function installDesktopConsoleLogTee(app: App) {
  if (consoleTeeInstalled) {
    return;
  }
  consoleTeeInstalled = true;
  console.log = createConsoleTee(app, console.log.bind(console), "log");
  console.info = createConsoleTee(app, console.info.bind(console), "info");
  console.warn = createConsoleTee(app, console.warn.bind(console), "warn");
  console.error = createConsoleTee(app, console.error.bind(console), "error");
  console.debug = createConsoleTee(app, console.debug.bind(console), "debug");
}

export function readDesktopLog(
  app: App,
  target: DesktopLogTarget,
  options: ServiceLogReadOptions = {}
): ServiceLogReadResult {
  return readServiceLogFile(getDesktopLogPath(app, normalizeDesktopLogTarget(target)), options);
}

export function watchDesktopLog(
  app: App,
  subscriptionId: string,
  target: DesktopLogTarget,
  options: ServiceLogStreamOptions = {},
  onEvent: DesktopLogStreamCallback
) {
  const normalizedTarget = normalizeDesktopLogTarget(target);
  const filePath = getDesktopLogPath(app, normalizedTarget);
  let currentOffset = normalizeLogStreamOffset(options);
  let currentExists = fs.existsSync(filePath);
  let polling = false;
  let stopped = false;

  async function sendReset(message: string) {
    const result = readDesktopLog(app, normalizedTarget);
    currentOffset = result.endOffset;
    currentExists = result.exists;
    onEvent({
      subscriptionId,
      serviceId: DESKTOP_LOG_SERVICE_ID,
      source: "desktop",
      target: normalizedTarget,
      type: "reset",
      path: result.path,
      exists: result.exists,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      hasPrevious: result.hasPrevious,
      totalBytes: result.totalBytes,
      message
    });
  }

  async function poll() {
    if (polling || stopped) {
      return;
    }

    polling = true;
    try {
      if (!fs.existsSync(filePath)) {
        currentExists = false;
        return;
      }

      const stat = fs.statSync(filePath);
      const totalBytes = stat.size;
      if (totalBytes < currentOffset) {
        await sendReset("Desktop log rotated.");
        return;
      }

      currentExists = true;
      if (totalBytes <= currentOffset) {
        currentOffset = totalBytes;
        return;
      }

      const deltaBytes = totalBytes - currentOffset;
      if (deltaBytes > LOG_READ_WINDOW_BYTES) {
        await sendReset("Desktop log grew too quickly.");
        return;
      }

      const startOffset = currentOffset;
      const content = readLogRange(filePath, startOffset, totalBytes);
      currentOffset = totalBytes;
      if (!content) {
        return;
      }

      onEvent({
        subscriptionId,
        serviceId: DESKTOP_LOG_SERVICE_ID,
        source: "desktop",
        target: normalizedTarget,
        type: "append",
        path: filePath,
        exists: true,
        content,
        startOffset,
        endOffset: totalBytes,
        hasPrevious: startOffset > 0,
        totalBytes
      });
    } catch (reason) {
      onEvent({
        subscriptionId,
        serviceId: DESKTOP_LOG_SERVICE_ID,
        source: "desktop",
        target: normalizedTarget,
        type: "error",
        path: filePath,
        exists: currentExists,
        content: "",
        startOffset: currentOffset,
        endOffset: currentOffset,
        hasPrevious: currentOffset > 0,
        totalBytes: currentOffset,
        message: reason instanceof Error ? reason.message : String(reason)
      });
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, normalizeLogStreamPollInterval(options));
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const __testInternals = {
  createConsoleTee,
  stringifyConsoleArgs,
  getDesktopLogPath,
  KANBAN_WS_LOG_LIMIT_BYTES,
  trimLogFileToLimit,
  sanitizeKanbanWsLogValue
};
