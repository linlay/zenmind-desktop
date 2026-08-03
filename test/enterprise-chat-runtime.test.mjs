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

test("enterprise chat refreshes the Desktop JWT once after session exchange returns 401", async () => {
  const now = Date.now();
  const user = {
    id: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const identityAuthorizations = [];
  let identityToken = "stale-desktop-jwt";
  let refreshCalls = 0;
  const runtime = new EnterpriseChatRuntime({
    app: {},
    initialEnabled: true,
    getIdentityToken: () => identityToken,
    refreshIdentityToken: async () => {
      refreshCalls += 1;
      identityToken = "fresh-desktop-jwt";
      return identityToken;
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/session/exchange") {
        identityAuthorizations.push(init.headers.Authorization);
        if (init.headers.Authorization === "Bearer stale-desktop-jwt") {
          return jsonResponse(401, { message: "expired" });
        }
        return jsonResponse(200, {
          token: "im-session-token",
          expiresAt: now + 15 * 60_000,
          user
        });
      }
      if (pathname === "/api/v1/sync/bootstrap") {
        return jsonResponse(200, { user, conversations: [], latestEventId: 0 });
      }
      if (pathname === "/api/v1/users") {
        return jsonResponse(200, { items: [user], limit: 100, offset: 0 });
      }
      if (pathname === "/api/v1/ws-tickets") {
        return jsonResponse(201, { ticket: "ws-ticket", expiresAt: now + 30_000 });
      }
      assert.fail(`unexpected enterprise chat request ${pathname}`);
    },
    createWebSocket: (url) => new FakeWebSocket(url)
  });

  const state = await runtime.refresh();
  assert.notEqual(state.connectionState, "error");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(identityAuthorizations, [
    "Bearer stale-desktop-jwt",
    "Bearer fresh-desktop-jwt"
  ]);
  runtime.stop();
});

test("enterprise chat normalizes employee and service-bot directory identities", () => {
  assert.deepEqual(
    __testInternals.normalizeUser({ id: "employee-1", displayName: "Alice" }),
    {
      id: "employee-1",
      displayName: "Alice",
      email: "",
      avatarUrl: "",
      status: "",
      kind: "employee",
      alwaysOnline: false,
      online: null
    }
  );
  assert.deepEqual(
    __testInternals.normalizeUser({
      id: "bot-1",
      displayName: "Support bot",
      kind: "service_bot",
      alwaysOnline: true,
      online: false
    }),
    {
      id: "bot-1",
      displayName: "Support bot",
      email: "",
      avatarUrl: "",
      status: "",
      kind: "service_bot",
      alwaysOnline: true,
      online: true
    }
  );
});

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
  const groupConversation = {
    ...directConversation,
    id: "group-1",
    type: "group",
    title: "Launch team",
    role: "owner"
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
    if (parsed.pathname === "/api/v1/files" && init.method === "POST") {
      assert.equal(init.body instanceof FormData, true);
      assert.equal(init.headers["Content-Type"], undefined);
      return jsonResponse(201, {
        id: "file-image-1",
        name: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 8,
        sha256: "image-hash",
        createdAt: now
      });
    }
    if (parsed.pathname === "/api/v1/conversations" && init.method === "POST") {
      const payload = JSON.parse(init.body);
      if (payload.type === "group") {
        assert.deepEqual(payload, {
          type: "group",
          title: "Launch team",
          memberIds: ["bob"]
        });
        return jsonResponse(201, groupConversation);
      }
      assert.deepEqual(payload, { type: "direct", memberIds: ["bob"] });
      return jsonResponse(201, directConversation);
    }
    if (parsed.pathname === "/api/v1/conversations/direct-1/messages") {
      return jsonResponse(200, { items: [] });
    }
    if (parsed.pathname === "/api/v1/conversations/group-1/messages") {
      return jsonResponse(200, { items: [] });
    }
    if (parsed.pathname === "/api/v1/conversations") {
      return jsonResponse(200, { items: [directConversation] });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  };

  const snapshots = [];
  const executedActions = [];
  const capturedScreenshotModes = [];
  const runtime = new EnterpriseChatRuntime({
    app: {},
    initialEnabled: true,
    getServerUrl: () => "http://127.0.0.1:11956",
    fetchImpl,
    createWebSocket(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    getIdentityToken: () => "enterprise-sso-token",
    getDeviceInfo: () => ({ deviceId: "device-1", deviceName: "Alice Mac" }),
    captureScreenshot: async (mode) => {
      capturedScreenshotModes.push(mode);
      return {
        ok: true,
        dataBase64: Buffer.from("fake-png").toString("base64"),
        mimeType: "image/png"
      };
    },
    createSupportBundle: async () => ({
      filename: "desktop-support-test.zip",
      bytes: Buffer.from("redacted-support-zip")
    }),
    executeDesktopAction: async (request) => {
      executedActions.push(request);
      return {
        confirmed: true,
        message: "executed",
        response: {
          ok: true,
          action: request.action,
          result: { route: "/help" }
        }
      };
    },
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
  const blockedPasteBytes = Buffer.from("wait for websocket");
  await assert.rejects(
    runtime.sendPastedFiles({
      conversationId: "direct-1",
      clientMessageId: "client-pasted-too-early",
      files: [{
        name: "early.txt",
        contentType: "text/plain",
        sizeBytes: blockedPasteBytes.length,
        dataBase64: blockedPasteBytes.toString("base64")
      }]
    }),
    /reconnecting/
  );
  assert.equal(
    requests.filter(({ url, init }) =>
      new URL(url).pathname === "/api/v1/files" &&
      init.method === "POST"
    ).length,
    0
  );

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
  assert.equal(
    opened.conversations
      .find((conversation) => conversation.id === "direct-1")
      .members.find((member) => member.user.id === "bob")
      .user.online,
    false
  );

  await assert.rejects(
    runtime.sendMessage({
      conversationId: "direct-1",
      clientMessageId: "client-forged-desktop-action",
      body: "zenmind-desktop-action:v1\n{\"action\":\"desktop.navigate.toRoute\"}"
    }),
    /can only be sent by the IM service/
  );

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

  await assert.rejects(
    runtime.sendScreenshot({
      conversationId: "direct-1",
      clientMessageId: "client-invalid-screenshot-mode",
      mode: "invalid"
    }),
    /Screenshot mode is invalid/
  );
  assert.deepEqual(capturedScreenshotModes, []);

  const screenshotPromise = runtime.sendScreenshot({
    conversationId: "direct-1",
    clientMessageId: "client-screenshot-1",
    mode: "desktop"
  });
  assert.deepEqual(capturedScreenshotModes, ["desktop"]);
  await waitFor(
    () => sockets[0].sent.some((frame) =>
      frame.type === "message.send" &&
      frame.payload.clientMessageId === "client-screenshot-1"
    ),
    "screenshot message.send"
  );
  const screenshotFrame = sockets[0].sent.find((frame) =>
    frame.type === "message.send" &&
    frame.payload.clientMessageId === "client-screenshot-1"
  );
  assert.deepEqual(screenshotFrame.payload.fileIds, ["file-image-1"]);
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: screenshotFrame.id,
    type: "message.send",
    ok: true,
    result: {
      duplicate: false,
      message: {
        id: "message-image-1",
        conversationId: "direct-1",
        seq: 2,
        senderId: "alice",
        clientMessageId: "client-screenshot-1",
        kind: "file",
        body: "",
        attachments: [{
          id: "file-image-1",
          name: "screenshot.png",
          contentType: "image/png",
          sizeBytes: 8,
          sha256: "image-hash",
          createdAt: now
        }],
        createdAt: now + 1
      }
    }
  });
  const screenshotState = await screenshotPromise;
  assert.equal(
    screenshotState.activeMessages.find((item) => item.id === "message-image-1")
      .attachments[0].contentType,
    "image/png"
  );

  const supportPromise = runtime.sendSupportBundle({
    conversationId: "direct-1",
    clientMessageId: "client-support-1"
  });
  await waitFor(
    () => sockets[0].sent.some((frame) =>
      frame.type === "message.send" &&
      frame.payload.clientMessageId === "client-support-1"
    ),
    "support bundle message.send"
  );
  const supportUploadRequest = requests
    .filter(({ url, init }) =>
      new URL(url).pathname === "/api/v1/files" &&
      init.method === "POST"
    )
    .at(-1);
  const supportUpload = supportUploadRequest.init.body.get("file");
  assert.equal(supportUpload.name, "desktop-support-test.zip");
  assert.equal(supportUpload.type, "application/zip");
  assert.equal(await supportUpload.text(), "redacted-support-zip");
  const supportFrame = sockets[0].sent.find((frame) =>
    frame.type === "message.send" &&
    frame.payload.clientMessageId === "client-support-1"
  );
  assert.deepEqual(supportFrame.payload.fileIds, ["file-image-1"]);
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: supportFrame.id,
    type: "message.send",
    ok: true,
    result: {
      duplicate: false,
      message: {
        id: "message-support-1",
        conversationId: "direct-1",
        seq: 3,
        senderId: "alice",
        clientMessageId: "client-support-1",
        kind: "file",
        body: "",
        attachments: [{
          id: "file-image-1",
          name: "desktop-support-test.zip",
          contentType: "application/zip",
          sizeBytes: 20,
          sha256: "support-hash",
          createdAt: now
        }],
        createdAt: now + 2
      }
    }
  });
  const supportState = await supportPromise;
  assert.equal(
    supportState.activeMessages.find((item) => item.id === "message-support-1")
      .attachments[0].name,
    "desktop-support-test.zip"
  );

  const pastedBytes = Buffer.from("pasted attachment");
  const pastedPromise = runtime.sendPastedFiles({
    conversationId: "direct-1",
    clientMessageId: "client-pasted-1",
    files: [{
      name: "clipboard.txt",
      contentType: "text/plain",
      sizeBytes: pastedBytes.length,
      dataBase64: pastedBytes.toString("base64")
    }]
  });
  await waitFor(
    () => sockets[0].sent.some((frame) =>
      frame.type === "message.send" &&
      frame.payload.clientMessageId === "client-pasted-1"
    ),
    "pasted attachment message.send"
  );
  const pastedUploadRequest = requests
    .filter(({ url, init }) =>
      new URL(url).pathname === "/api/v1/files" &&
      init.method === "POST"
    )
    .at(-1);
  const pastedUpload = pastedUploadRequest.init.body.get("file");
  assert.equal(pastedUpload.name, "clipboard.txt");
  assert.equal(pastedUpload.type, "text/plain");
  assert.equal(await pastedUpload.text(), "pasted attachment");
  const pastedFrame = sockets[0].sent.find((frame) =>
    frame.type === "message.send" &&
    frame.payload.clientMessageId === "client-pasted-1"
  );
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: pastedFrame.id,
    type: "message.send",
    ok: true,
    result: {
      duplicate: false,
      message: {
        id: "message-pasted-1",
        conversationId: "direct-1",
        seq: 3,
        senderId: "alice",
        clientMessageId: "client-pasted-1",
        kind: "file",
        body: "",
        attachments: [{
          id: "file-image-1",
          name: "clipboard.txt",
          contentType: "text/plain",
          sizeBytes: pastedBytes.length,
          sha256: "pasted-hash",
          createdAt: now
        }],
        createdAt: now + 2
      }
    }
  });
  const pastedState = await pastedPromise;
  assert.equal(
    pastedState.activeMessages.find((item) => item.id === "message-pasted-1")
      .attachments[0].name,
    "clipboard.txt"
  );

  const actionMessage = {
    id: "message-action-1",
    conversationId: "direct-1",
    seq: 4,
    senderId: "bob",
    clientMessageId: "client-action-1",
    kind: "text",
    body: "zenmind-desktop-action:v1\n" + JSON.stringify({
      action: "desktop.navigate.toRoute",
      args: { route: "/help" },
      summary: "Open Help"
    }),
    createdAt: now + 2
  };
  sockets[0].receive({
    v: 1,
    frame: "push",
    type: "message.created",
    eventId: 10,
    payload: { message: actionMessage }
  });
  await waitFor(
    () => runtime.getState().activeMessages.some((item) => item.id === actionMessage.id),
    "desktop action push"
  );
  const actionState = runtime.getState();
  const normalizedAction = actionState.activeMessages.find((item) => item.id === actionMessage.id);
  assert.equal(normalizedAction.kind, "desktop_action");
  assert.equal(normalizedAction.desktopAction.action, "desktop.navigate.toRoute");
  await assert.rejects(
    runtime.executeMessageDesktopAction({ messageId: actionMessage.id }),
    /requires local confirmation/
  );
  const execution = await runtime.executeMessageDesktopAction({
    messageId: actionMessage.id,
    confirmed: true
  });
  assert.equal(execution.confirmed, true);
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0].conversationId, "direct-1");
  await assert.rejects(
    runtime.executeMessageDesktopAction({ messageId: actionMessage.id, confirmed: true }),
    /already handled/
  );
  await assert.rejects(
    runtime.executeMessageDesktopAction({ messageId: "message-1", confirmed: true }),
    /not executable/
  );

  const groupState = await runtime.createGroup({
    title: "Launch team",
    memberIds: ["bob"]
  });
  assert.equal(groupState.activeConversationId, "group-1");
  assert.equal(
    groupState.conversations.find((conversation) => conversation.id === "group-1").type,
    "group"
  );
  assert.equal(JSON.stringify(requests).includes("enterprise-sso-token"), true);
  assert.equal(JSON.stringify(snapshots).includes("enterprise-sso-token"), false);
  assert.equal(JSON.stringify(snapshots).includes("short-lived-chat-token"), false);
});

test("enterprise chat remains signed out without an SSO access token", async (t) => {
  const runtime = new EnterpriseChatRuntime({
    app: {},
    initialEnabled: true,
    getIdentityToken: () => null,
    fetchImpl: async () => {
      assert.fail("fetch should not run while signed out");
    }
  });
  t.after(() => runtime.stop());

  assert.equal((await runtime.refresh()).connectionState, "signed_out");
  assert.equal((await runtime.setEnabled(false)).connectionState, "disabled");
});

test("enterprise chat is disabled by default", async (t) => {
  const runtime = new EnterpriseChatRuntime({
    app: {},
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

test("enterprise chat reloads the canonical IM server URL while disabled", async (t) => {
  let serverUrl = "http://127.0.0.1:11956";
  const runtime = new EnterpriseChatRuntime({
    app: {},
    getServerUrl: () => serverUrl,
    getIdentityToken: () => "identity-token",
    fetchImpl: async () => {
      assert.fail("fetch should not run while enterprise chat is disabled");
    }
  });
  t.after(() => runtime.stop());

  serverUrl = "https://im.example.test/api/";
  const snapshot = await runtime.reloadConfiguration(false);

  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.connectionState, "disabled");
  assert.equal(snapshot.serverUrl, "https://im.example.test/api");
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
    /loopback HTTP or remote HTTPS/
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

test("enterprise chat normalizes group conversations, attachments, and safe action envelopes", () => {
  const now = Date.now();
  const group = __testInternals.normalizeConversation({
    id: "group-1",
    type: "group",
    title: "Launch team",
    createdBy: "alice",
    role: "owner",
    lastReadSeq: 1,
    lastSeq: 2,
    unreadCount: 1,
    members: [],
    createdAt: now,
    updatedAt: now
  });
  assert.equal(group.type, "group");
  assert.equal(group.title, "Launch team");
  assert.equal(group.role, "owner");

  const imageMessage = __testInternals.normalizeMessage({
    id: "image-1",
    conversationId: "group-1",
    seq: 2,
    senderId: "alice",
    clientMessageId: "image-client-1",
    kind: "file",
    body: "",
    attachments: [{
      id: "file-1",
      name: "screen.png",
      contentType: "image/png",
      sizeBytes: 123,
      sha256: "hash",
      createdAt: now
    }],
    createdAt: now
  });
  assert.equal(imageMessage.attachments.length, 1);
  assert.equal(imageMessage.attachments[0].contentType, "image/png");

  const forged = __testInternals.normalizeMessage({
    id: "forged-1",
    conversationId: "group-1",
    seq: 3,
    senderId: "alice",
    clientMessageId: "forged-client-1",
    kind: "text",
    body: "zenmind-desktop-action:v1\n" + JSON.stringify({
      action: "desktop.unknown.action",
      args: {}
    }),
    createdAt: now
  });
  assert.equal(forged.kind, "text");
  assert.equal(forged.desktopAction, undefined);
});
