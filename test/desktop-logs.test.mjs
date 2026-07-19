import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  getDesktopLogRoot,
  readDesktopLog,
  appendKanbanWsLog,
  __testInternals
} = await import("../dist-electron/main/logs/desktop.js");

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

test("desktop console tee writes main log and preserves original writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-logs-"));
  const app = createApp(root);
  const originalCalls = [];
  const writer = __testInternals.createConsoleTee(
    app,
    (...args) => originalCalls.push(args),
    "warn"
  );

  writer("hello", { route: "debug" });

  const logRoot = getDesktopLogRoot(app);
  const mainLog = fs.readFileSync(path.join(logRoot, "main.log"), "utf8");
  assert.equal(originalCalls.length, 1);
  assert.equal(originalCalls[0][0], "hello");
  assert.match(mainLog, /WARN hello/);
  assert.match(mainLog, /route/);
  assert.equal(fs.existsSync(path.join(logRoot, "error.log")), false);
});

test("desktop console error tee also writes error log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-error-logs-"));
  const app = createApp(root);
  const writer = __testInternals.createConsoleTee(app, () => undefined, "error");

  writer("boom");

  const logRoot = getDesktopLogRoot(app);
  assert.match(fs.readFileSync(path.join(logRoot, "main.log"), "utf8"), /ERROR boom/);
  assert.match(fs.readFileSync(path.join(logRoot, "error.log"), "utf8"), /ERROR boom/);
  const result = readDesktopLog(app, "error");
  assert.equal(result.exists, true);
  assert.match(result.content, /ERROR boom/);
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
        privateIssue: { syncMode: "private", title: "private task content" }
      }
    }
  });

  const logRoot = getDesktopLogRoot(app);
  const logPath = path.join(logRoot, "kanban-ws.log");
  const raw = fs.readFileSync(logPath, "utf8");
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.event, "frame");
  assert.equal(entry.envelope.payload.title, "Visible cloud issue");
  assert.equal(raw.includes("secret-access-token"), false);
  assert.equal(raw.includes("secret-url-token"), false);
  assert.equal(raw.includes("secret-bearer-token"), false);
  assert.equal(raw.includes("/Users/example/private.txt"), false);
  assert.equal(raw.includes("private task content"), false);
  assert.equal(entry.envelope.payload.privateIssue, "[REDACTED_PRIVATE_PAYLOAD]");
  assert.equal(fs.existsSync(path.join(logRoot, "main.log")), false);

  const result = readDesktopLog(app, "kanban-ws");
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
