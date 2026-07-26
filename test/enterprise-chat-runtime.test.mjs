import assert from "node:assert/strict";
import test from "node:test";

const {
  EnterpriseChatRuntime,
  __testInternals
} = await import("../dist-electron/main/enterprise-chat-runtime.js");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function waitFor(check, message = "condition") {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 1000) {
        reject(new Error(`Timed out waiting for ${message}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }
}

test("enterprise chat exchanges the SSO token and completes a direct message flow", async (t) => {
  const sockets = [];
  const requests = [];
  const now = Date.now();
  const alice = {
    id: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const bob = {
    id: "bob",
    displayName: "Bob",
    email: "bob@example.com",
    status: "active",
    online: true,
    createdAt: now,
    updatedAt: now
  };
  const directConversation = {
    id: "direct-1",
    type: "direct",
    title: "",
    createdBy: "alice",
    lastReadSeq: 0,
    lastSeq: 0,
    unreadCount: 0,
    members: [
      { user: alice, role: "owner", joinedSeq: 1, createdAt: now },
      { user: bob, role: "member", joinedSeq: 1, createdAt: now }
    ],
    createdAt: now,
    updatedAt: now
  };

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v1/session/exchange") {
      assert.equal(init.headers.Authorization, "Bearer enterprise-sso-token");
      return jsonResponse(200, {
        token: "short-lived-chat-token",
        expiresAt: now + 15 * 60_000,
        user: alice,
        deviceId: "device-1"
      });
    }
    assert.equal(init.headers.Authorization, "Bearer short-lived-chat-token");
    if (parsed.pathname === "/api/v1/sync/bootstrap") {
      return jsonResponse(200, {
        user: alice,
        conversations: [],
        latestEventId: 0,
        serverTime: now
      });
    }
    if (parsed.pathname === "/api/v1/users") {
      return jsonResponse(200, { items: [alice, bob], limit: 100, offset: 0 });
    }
    if (parsed.pathname === "/api/v1/ws-tickets") {
      return jsonResponse(201, { ticket: "ticket-1", expiresAt: now + 30_000 });
    }
    if (parsed.pathname === "/api/v1/conversations" && init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), {
        type: "direct",
        memberIds: ["bob"]
      });
      return jsonResponse(201, directConversation);
    }
    if (parsed.pathname === "/api/v1/conversations/direct-1/messages") {
      return jsonResponse(200, { items: [] });
    }
    if (parsed.pathname === "/api/v1/conversations") {
      return jsonResponse(200, { items: [directConversation] });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };

  const snapshots = [];
  const runtime = new EnterpriseChatRuntime({
    app: {},
    serverUrl: "http://127.0.0.1:11956",
    fetchImpl,
    createWebSocket(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    getIdentityToken: () => "enterprise-sso-token",
    getDeviceInfo: () => ({ deviceId: "device-1", deviceName: "Alice Mac" }),
    onStateChanged: (snapshot) => snapshots.push(snapshot)
  });
  t.after(() => runtime.stop());

  const connecting = await runtime.refresh();
  assert.equal(connecting.connectionState, "connecting");
  assert.equal(connecting.users.length, 1);
  assert.equal(connecting.users[0].id, "bob");
  assert.equal(connecting.users[0].online, true);
  assert.equal(sockets.length, 1);
  assert.equal(new URL(sockets[0].url).searchParams.get("ticket"), "ticket-1");

  sockets[0].open();
  assert.equal(sockets[0].sent[0].type, "sync.resume");
  sockets[0].receive({
    v: 1,
    frame: "push",
    type: "sync.ready",
    payload: { eventId: 0, serverTime: now }
  });
  await waitFor(() => runtime.getState().connectionState === "connected", "sync.ready");
  assert.equal(runtime.getState().connectionState, "connected");
  sockets[0].receive({
    v: 1,
    frame: "push",
    type: "presence.changed",
    payload: { userId: "bob", online: false }
  });
  await waitFor(() => runtime.getState().users[0]?.online === false, "presence.changed");

  const opened = await runtime.openDirectConversation({ userId: "bob" });
  assert.equal(opened.activeConversationId, "direct-1");
  assert.equal(opened.activeMessages.length, 0);

  const sendPromise = runtime.sendMessage({
    conversationId: "direct-1",
    clientMessageId: "client-message-1",
    body: "hello"
  });
  await waitFor(() => sockets[0].sent.some((frame) => frame.type === "message.send"), "message.send");
  const sendFrame = sockets[0].sent.find((frame) => frame.type === "message.send");
  const message = {
    id: "message-1",
    conversationId: "direct-1",
    seq: 1,
    senderId: "alice",
    clientMessageId: "client-message-1",
    kind: "text",
    body: "hello",
    createdAt: now
  };
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: sendFrame.id,
    type: "message.send",
    ok: true,
    result: { message, duplicate: false }
  });
  const sent = await sendPromise;
  assert.equal(sent.activeMessages.length, 1);
  assert.equal(sent.activeMessages[0].body, "hello");
  assert.equal(JSON.stringify(requests).includes("enterprise-sso-token"), true);
  assert.equal(JSON.stringify(snapshots).includes("enterprise-sso-token"), false);
  assert.equal(JSON.stringify(snapshots).includes("short-lived-chat-token"), false);
});

test("enterprise chat remains signed out without an SSO access token", async (t) => {
  const runtime = new EnterpriseChatRuntime({
    app: {},
    getIdentityToken: () => null,
    fetchImpl: async () => {
      assert.fail("fetch should not run while signed out");
    }
  });
  t.after(() => runtime.stop());

  assert.equal((await runtime.refresh()).connectionState, "signed_out");
  assert.equal((await runtime.setEnabled(false)).connectionState, "disabled");
});

test("enterprise chat honors an initially disabled persisted setting", async (t) => {
  const runtime = new EnterpriseChatRuntime({
    app: {},
    initialEnabled: false,
    getIdentityToken: () => "identity-token",
    fetchImpl: async () => {
      assert.fail("fetch should not run while enterprise chat is disabled");
    }
  });
  t.after(() => runtime.stop());

  const snapshot = await runtime.refresh();

  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.connectionState, "disabled");
});

test("enterprise chat server URL accepts loopback HTTP and requires TLS remotely", () => {
  assert.equal(
    __testInternals.normalizeServerUrl("http://localhost:11956/"),
    "http://localhost:11956"
  );
  assert.equal(
    __testInternals.normalizeServerUrl("https://chat.example.com/"),
    "https://chat.example.com"
  );
  assert.throws(
    () => __testInternals.normalizeServerUrl("http://chat.example.com"),
    /must use HTTPS/
  );
});

test("enterprise chat distinguishes account status from explicit presence", () => {
  assert.equal(
    __testInternals.normalizeUser({ id: "active-user", status: "active" }).online,
    null
  );
  assert.equal(
    __testInternals.normalizeUser({
      id: "connected-user",
      status: "active",
      online: true
    }).online,
    true
  );
  assert.equal(
    __testInternals.normalizeUser({
      id: "disconnected-user",
      status: "active",
      online: false
    }).online,
    false
  );
});
