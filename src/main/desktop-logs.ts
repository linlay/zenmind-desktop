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
} from "../shared/contracts";
import { getLogsRoot } from "./user-paths";
import {
  LOG_READ_WINDOW_BYTES,
  normalizeLogStreamOffset,
  normalizeLogStreamPollInterval,
  readLogRange,
  readServiceLogFile
} from "./services/manager/logs";

type ConsoleWriter = (...args: unknown[]) => void;
type DesktopLogStreamCallback = (event: ServiceLogStreamEvent) => void;

const DESKTOP_LOG_SERVICE_ID = "desktop";
let consoleTeeInstalled = false;

function getDesktopLogPath(app: App, target: DesktopLogTarget) {
  const filename = target === "error" ? "error.log" : "main.log";
  return path.join(getDesktopLogRoot(app), filename);
}

function normalizeDesktopLogTarget(target: unknown): DesktopLogTarget {
  return target === "error" ? "error" : "main";
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
  stringifyConsoleArgs
};
