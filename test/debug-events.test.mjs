import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createDebugEventStore,
  sanitizeDebugHeaders
} = require("../dist-electron/main/debug/debug-events.js");

test("debug header sanitizer redacts auth, cookie, token, and secret headers", () => {
  assert.deepEqual(sanitizeDebugHeaders({
    Authorization: "Bearer local-token",
    Cookie: "sid=abc",
    "Set-Cookie": ["sid=abc", "theme=dark"],
    "X-Api-Key": "key",
    "X-Access-Token": "token",
    "X-Client-Secret": "secret",
    "X-Trace-Id": "trace-1"
  }), {
    Authorization: "<redacted>",
    Cookie: "<redacted>",
    "Set-Cookie": "<redacted>",
    "X-Api-Key": "<redacted>",
    "X-Access-Token": "<redacted>",
    "X-Client-Secret": "<redacted>",
    "X-Trace-Id": "trace-1"
  });
});

test("debug event store records registered webview request lifecycle", () => {
  const store = createDebugEventStore({ maxEvents: 10, now: () => 2000 });
  const emitted = [];
  const unsubscribe = store.subscribe((event) => emitted.push(event));
  store.registerSurface({
    webContentsId: 42,
    kind: "plugin",
    surfaceId: "agent-webclient",
    surfaceLabel: "智能助理",
    tabId: "tab-1",
    url: "https://app.example.test"
  });

  store.recordRequestHeaders({
    id: 100,
    webContentsId: 42,
    url: "https://api.example.test/users",
    method: "POST",
    resourceType: "xhr",
    requestHeaders: {
      Authorization: "Bearer local-token",
      "X-Trace-Id": "trace-1"
    },
    timestamp: 1000
  });
  store.recordResponseStarted({
    id: 100,
    webContentsId: 42,
    url: "https://api.example.test/users",
    method: "POST",
    resourceType: "xhr",
    statusCode: 201,
    statusLine: "HTTP/1.1 201 Created",
    responseHeaders: {
      "Content-Type": ["application/json"],
      "Set-Cookie": ["sid=abc"]
    },
    fromCache: false,
    timestamp: 1015
  });
  store.recordRequestCompleted({
    id: 100,
    webContentsId: 42,
    url: "https://api.example.test/users",
    method: "POST",
    resourceType: "xhr",
    statusCode: 201,
    statusLine: "HTTP/1.1 201 Created",
    responseHeaders: {
      "Content-Type": ["application/json"]
    },
    fromCache: false,
    timestamp: 1028
  });
  unsubscribe();

  const [event] = store.listEvents();
  assert.equal(store.listEvents().length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(event.kind, "request");
  assert.equal(event.webContentsId, 42);
  assert.equal(event.source.surfaceLabel, "智能助理");
  assert.equal(event.method, "POST");
  assert.equal(event.statusCode, 201);
  assert.equal(event.durationMs, 28);
  assert.equal(event.requestHeaders.Authorization, "<redacted>");
  assert.equal(event.requestHeaders["X-Trace-Id"], "trace-1");
  assert.equal(event.responseHeaders["Set-Cookie"], "<redacted>");
});

test("debug event store ignores unregistered webviews and truncates old events", () => {
  const store = createDebugEventStore({ maxEvents: 2, now: () => 5000 });
  store.recordConsoleMessage({
    webContentsId: 999,
    level: "error",
    message: "ignored",
    line: 1,
    sourceId: "https://ignored.example.test"
  });
  assert.deepEqual(store.listEvents(), []);

  store.registerSurface({ webContentsId: 7, kind: "external", surfaceLabel: "国小君" });
  store.recordConsoleMessage({ webContentsId: 7, level: "info", message: "one", line: 1, sourceId: "a" });
  store.recordConsoleMessage({ webContentsId: 7, level: "warning", message: "two", line: 2, sourceId: "b" });
  store.recordConsoleMessage({ webContentsId: 7, level: "error", message: "three", line: 3, sourceId: "c" });

  assert.deepEqual(store.listEvents().map((event) => event.message), ["two", "three"]);
});
