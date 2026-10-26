import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentPlatformRealtimeClient } = require("../dist-electron/main/modules/agent-platform/realtime/agent-platform-realtime-client.js");

function harness(t, options = {}) {
  let now = 1_793_000_000_000;
  t.mock.method(Date, "now", () => now);
  const token = `header.${Buffer.from(JSON.stringify({ iss: "fixture", sub: "fixture-user", sid: "fixture-session" })).toString("base64url")}.signature`;
  const sockets = [];
  const client = new AgentPlatformRealtimeClient({
    app: {}, issueAccessToken: async () => ({ ok: true, token, message: "" }),
    getDesktopDeviceId: () => "fixture-device", onFrame() {},
    ...(options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
    createWebSocket() {
      const socket = {
        sent: [], closed: false, onopen: null, onmessage: null, onerror: null, onclose: null,
        send(raw) { this.sent.push(JSON.parse(raw)); },
        close() { this.closed = true; },
        emit(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); },
      };
      sockets.push(socket);
      const sessionId = `fixture-${sockets.length}`;
      queueMicrotask(() => socket.emit({ frame: "push", type: "connected", data: {
        protocolVersion: 2, sessionId, serverTime: now,
        liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
      } }));
      return socket;
    },
  });
  t.after(() => client.dispose());
  return { client, sockets, token, advance: ms => { now += ms; },
    connect: () => client.ensureConnected("http://127.0.0.1:17078", token) };
}

test("the first consumer after a suspended watchdog reconnects before sending a new query", async t => {
  const h = harness(t);
  await h.connect();
  h.advance(60 * 60_000); // Wall time advanced while the event loop did not run its overdue watchdog.
  await h.connect();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].closed, true);
  const frame = { frame: "request", type: "/api/query", id: "new-query", payload: {} };
  h.client.send(frame);
  assert.deepEqual(h.sockets[0].sent, []);
  assert.deepEqual(h.sockets[1].sent, [frame]);
});

test("direct sends cannot enter a silent connection or replay a business request", async t => {
  const h = harness(t);
  await h.connect();
  h.advance(100_001);
  assert.throws(() => h.client.send({ frame: "request", type: "/api/query", id: "must-not-send" }), /silence|connection.*unavailable/i);
  assert.equal(h.sockets[0].closed, true);
  assert.deepEqual(h.sockets[0].sent, []);
  assert.equal(h.sockets.length, 1, "send failure only schedules recovery; it does not resend a query");
});

test("recent inbound traffic keeps a connection valid across a long total lifetime", async t => {
  const h = harness(t);
  await h.connect();
  h.advance(90_000);
  h.sockets[0].emit({ frame: "push", type: "fixture.activity", data: {} });
  await new Promise(resolve => setImmediate(resolve));
  h.advance(90_000);
  await h.connect();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closed, false);
});

test("an explicitly disabled watchdog remains disabled for consumer preflight too", async t => {
  const h = harness(t, { heartbeatTimeoutMs: 0 });
  await h.connect();
  h.advance(60 * 60_000);
  await h.connect();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closed, false);
});
