import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  getDesktopLogRoot,
  readDesktopLog,
  appendKanbanWsLog,
  __testInternals
} = await import("../dist-electron/main/logs/desktop.js");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_PLATFORM = "linux";

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "Library", "Application Support");
      }
      return homePath;
    }
  };
}

test("desktop console tee batches main log writes and preserves original writer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-logs-"));
  const app = createApp(root);
  const originalCalls = [];
  const writer = __testInternals.createConsoleTee(
    app,
    (...args) => originalCalls.push(args),
    "warn",
    { platform: TEST_PLATFORM },
  );

  writer("hello", { route: "debug" });

  const logRoot = getDesktopLogRoot(app, TEST_PLATFORM);
  assert.equal(fs.existsSync(path.join(logRoot, "main.log")), false);
  await __testInternals.flushDesktopLogs(app, 500);
  const mainLog = fs.readFileSync(path.join(logRoot, "main.log"), "utf8");
  assert.equal(originalCalls.length, 1);
  assert.equal(originalCalls[0][0], "hello");
  assert.match(mainLog, /WARN hello/);
  assert.match(mainLog, /route/);
  assert.equal(fs.existsSync(path.join(logRoot, "error.log")), false);
});

test("desktop console error tee also writes error log", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-error-logs-"));
  const app = createApp(root);
  const writer = __testInternals.createConsoleTee(
    app,
    () => undefined,
    "error",
    { platform: TEST_PLATFORM },
  );

  writer("boom");

  const logRoot = getDesktopLogRoot(app, TEST_PLATFORM);
  await __testInternals.flushDesktopLogs(app, 500);
  assert.match(fs.readFileSync(path.join(logRoot, "main.log"), "utf8"), /ERROR boom/);
  assert.match(fs.readFileSync(path.join(logRoot, "error.log"), "utf8"), /ERROR boom/);
  const result = readDesktopLog(app, "error", {}, TEST_PLATFORM);
  assert.equal(result.exists, true);
  assert.match(result.content, /ERROR boom/);
});

test("desktop console serialization bounds depth, arrays, and strings", () => {
  const serialized = __testInternals.stringifyConsoleArgs([
    {
      nested: { one: { two: { three: { four: { five: "too-deep" } } } } },
      items: Array.from({ length: 80 }, (_, index) => `item-${index}`),
    },
    "x".repeat(__testInternals.DESKTOP_LOG_MAX_STRING_LENGTH + 100),
  ]);

  assert.equal(__testInternals.DESKTOP_LOG_MAX_DEPTH, 4);
  assert.equal(__testInternals.DESKTOP_LOG_MAX_ARRAY_LENGTH, 50);
  assert.equal(serialized.includes("item-79"), false);
  assert.match(serialized, /truncated 100 chars/u);
});

test("desktop console queue uses the 50ms or 64KB flush policy", () => {
  assert.equal(__testInternals.DESKTOP_LOG_FLUSH_INTERVAL_MS, 50);
  assert.equal(__testInternals.DESKTOP_LOG_FLUSH_BYTES, 64 * 1024);
});

test("renderer diagnostics keep warnings out of error.log and flush before quit", () => {
  const runtimeSource = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app", "runtime.ts"),
    "utf8",
  );
  const shellHandlersSource = fs.readFileSync(
    path.join(projectRoot, "src", "main", "ipc", "shell-handlers.ts"),
    "utf8",
  );
  const appEventsSource = fs.readFileSync(
    path.join(projectRoot, "src", "main", "app", "app-events.ts"),
    "utf8",
  );

  assert.match(shellHandlersSource, /diagnosticLevel/u);
  assert.match(runtimeSource, /diagnosticLevel === "warn"[\s\S]*?console\.warn/u);
  assert.match(runtimeSource, /else \{[\s\S]*?safeConsoleError\("\[renderer-diagnostic\]"/u);
  assert.match(runtimeSource, /if \(!isDesktopDevelopmentRuntime\(app\)\) return;/u);
  assert.match(appEventsSource, /flushDesktopLogs\(500\)/u);
});

test("kanban websocket entries use an independent, sanitized JSONL log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-kanban-ws-logs-"));
  const app = createApp(root);

  appendKanbanWsLog(app, {
    event: "frame",
    direction: "send",
    envelope: {
      type: "sync.hello",
      payload: {
        title: "Visible cloud issue",
        accessToken: "secret-access-token",
        endpoint: "wss://kanban.example.test/ws?token=secret-url-token",
        authorization: "Bearer secret-bearer-token",
        filePath: "/Users/example/private.txt",
        localIssue: { syncMode: "local", title: "local task content" },
        legacyLocalIssue: { syncMode: "private", title: "legacy local task content" }
      }
    }
  }, TEST_PLATFORM);

  const logRoot = getDesktopLogRoot(app, TEST_PLATFORM);
  const logPath = path.join(logRoot, "kanban-ws.log");
  const raw = fs.readFileSync(logPath, "utf8");
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.event, "frame");
  assert.equal(entry.envelope.payload.title, "Visible cloud issue");
  assert.equal(raw.includes("secret-access-token"), false);
  assert.equal(raw.includes("secret-url-token"), false);
  assert.equal(raw.includes("secret-bearer-token"), false);
  assert.equal(raw.includes("/Users/example/private.txt"), false);
  assert.equal(raw.includes("local task content"), false);
  assert.equal(raw.includes("legacy local task content"), false);
  assert.equal(entry.envelope.payload.localIssue, "[REDACTED_LOCAL_PAYLOAD]");
  assert.equal(entry.envelope.payload.legacyLocalIssue, "[REDACTED_LOCAL_PAYLOAD]");
  assert.equal(fs.existsSync(path.join(logRoot, "main.log")), false);

  const result = readDesktopLog(app, "kanban-ws", {}, TEST_PLATFORM);
  assert.equal(result.exists, true);
  assert.equal(result.path, logPath);
  assert.match(result.content, /Visible cloud issue/);
});

test("kanban websocket log trimming keeps complete JSONL records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-kanban-ws-log-trim-"));
  const logPath = path.join(root, "kanban-ws.log");
  fs.writeFileSync(logPath, [
    JSON.stringify({ event: "older", payload: "x".repeat(128) }),
    JSON.stringify({ event: "latest" })
  ].join("\n") + "\n", "utf8");

  __testInternals.trimLogFileToLimit(logPath, 64);

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.deepEqual(lines.map((line) => JSON.parse(line).event), ["latest"]);
});
