import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  EnterpriseChatRuntime,
  __testInternals
} = await import("../dist-electron/main/modules/enterprise-chat/runtime.js");
const {
  EnterpriseChatActionLedger,
  enterpriseChatActionScope
} = await import("../dist-electron/main/modules/enterprise-chat/action-ledger.js");

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

function createDesktopActionFixture(t, options = {}) {
  const now = Date.now();
  const userDataRoot = options.userDataRoot ?? fs.mkdtempSync(
    path.join(os.tmpdir(), "enterprise-chat-action-fixture-")
  );
  if (!options.userDataRoot) {
    t.after(() => fs.rmSync(userDataRoot, { recursive: true, force: true }));
  }
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
    createdAt: now,
    updatedAt: now
  };
  const conversation = {
    id: "direct-action",
    type: "direct",
    title: "",
    createdBy: "alice",
    lastReadSeq: 0,
    lastSeq: 0,
    unreadCount: 0,
    members: [
      { user: alice, role: "owner", joinedSeq: 1 },
      { user: bob, role: "member", joinedSeq: 1 }
    ],
    createdAt: now,
    updatedAt: now
  };
  const request = {
    id: "action-request-message",
    conversationId: conversation.id,
    seq: 1,
    senderId: "bob",
    actorUserId: "bob",
    senderDeviceId: "support-device",
    clientMessageId: "support-action-request",
    replyToId: "",
    kind: "desktop_action_request",
    body: "Open Docs",
    desktopAction: {
      requestId: "stable-action-request",
      targetDeviceId: options.targetDeviceId ?? "device-1",
      action: "desktop.website.open",
      args: { websiteId: "docs" },
      operatorNote: "Open Docs",
      expiresAt: options.expiresAt ?? now + 60_000
    },
    attachments: [],
    createdAt: now
  };
  let historyItems = options.historyItems ?? [request];
  const sockets = [];
  const executedActions = [];
  const runtime = new EnterpriseChatRuntime({
    app: {
      getVersion: () => "test",
      getPath: () => options.getUserDataRoot?.() ?? userDataRoot
    },
    initialEnabled: true,
    getServerUrl: () => "http://127.0.0.1:11956",
    getIdentityToken: () => "enterprise-sso-token",
    getDeviceInfo: () => ({ deviceId: "device-1", deviceName: "Alice Mac" }),
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/v1/session/exchange") {
        return jsonResponse(200, {
          token: "im-session-token",
          expiresAt: now + 15 * 60_000,
          user: alice
        });
      }
      if (pathname === "/api/v1/sync/bootstrap") {
        return jsonResponse(200, { user: alice, conversations: [conversation], latestEventId: 0 });
      }
      if (pathname === "/api/v1/users") {
        return jsonResponse(200, { items: [alice, bob] });
      }
      if (pathname === "/api/v1/ws-tickets") {
        return jsonResponse(201, { ticket: `ticket-${sockets.length + 1}` });
      }
      if (pathname === `/api/v1/conversations/${conversation.id}/messages`) {
        return jsonResponse(200, { items: historyItems });
      }
      if (pathname === "/api/v1/conversations") {
        return jsonResponse(200, { items: [conversation] });
      }
      return jsonResponse(404, { error: { message: "not found" } });
    },
    createWebSocket(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    executeDesktopAction: async (action) => {
      executedActions.push(action);
      if (options.executeDesktopAction) {
        return options.executeDesktopAction(action);
      }
      return {
        response: { ok: true, action: action.action, result: {} },
        message: "executed"
      };
    }
  });
  t.after(() => runtime.stop());

  async function synchronize(socket, openConversation = true) {
    socket.open();
    await waitFor(() => socket.sent.some((frame) => frame.type === "sync.resume"), "sync.resume");
    const resume = socket.sent.find((frame) => frame.type === "sync.resume");
    socket.receive({
      v: 1,
      frame: "response",
      id: resume.id,
      type: "sync.resume",
      ok: true,
      result: {}
    });
    socket.receive({
      v: 1,
      frame: "push",
      type: "sync.ready",
      payload: { eventId: 0, serverTime: now }
    });
    await waitFor(() => runtime.getState().connectionState === "connected", "sync.ready");
    if (openConversation) {
      await runtime.openConversation({ conversationId: conversation.id });
    }
    return socket;
  }

  async function connect(openConversation = true) {
    await runtime.refresh();
    return synchronize(sockets[sockets.length - 1], openConversation);
  }

  async function acknowledgeLatestActionReceipt(socket, suffix = "1") {
    await waitFor(
      () => socket.sent.some((frame) => frame.type === "message.send" && frame.payload.kind === "desktop_action_result"),
      "desktop action receipt"
    );
    const frames = socket.sent.filter(
      (frame) => frame.type === "message.send" && frame.payload.kind === "desktop_action_result"
    );
    const frame = frames[frames.length - 1];
    const resultMessage = {
      id: `action-result-${suffix}`,
      conversationId: conversation.id,
      seq: 2,
      senderId: "alice",
      actorUserId: "alice",
      senderDeviceId: "device-1",
      clientMessageId: frame.payload.clientMessageId,
      replyToId: request.id,
      kind: "desktop_action_result",
      body: frame.payload.body,
      desktopAction: frame.payload.desktopAction,
      attachments: [],
      createdAt: now + 1
    };
    historyItems = [request, resultMessage];
    socket.receive({
      v: 1,
      frame: "response",
      id: frame.id,
      type: "message.send",
      ok: true,
      result: { duplicate: suffix !== "1", message: resultMessage }
    });
    return frame;
  }

  return {
    runtime,
    sockets,
    request,
    conversation,
    executedActions,
    userDataRoot,
    connect,
    synchronize,
    acknowledgeLatestActionReceipt,
    setHistory(items) {
      historyItems = items;
    }
  };
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
    app: { getVersion: () => "test" },
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
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-chat-actions-"));
  t.after(() => fs.rmSync(userDataRoot, { recursive: true, force: true }));
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
    app: {
      getVersion: () => "test",
      getPath: (name) => {
        assert.equal(name, "userData");
        return userDataRoot;
      }
    },
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
        status: "succeeded",
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

  const rawAgentChatBytes = Buffer.from([
    '{"type":"metadata","unknown":true}',
    '{"type":"tool.output","hidden":true,"path":"C:\\\\work\\\\project"}',
    ""
  ].join("\r\n"), "utf8");
  const rawAgentChatPromise = runtime.sendRawAgentChat({
    conversationId: "direct-1",
    chatId: "agent-chat-1",
    chatName: "Raw Plan",
    clientMessageId: "client-agent-chat-1"
  }, {
    filename: "agent-chat-1.jsonl",
    bytes: rawAgentChatBytes
  });
  await waitFor(
    () => sockets[0].sent.some((frame) =>
      frame.type === "message.send" &&
      frame.payload.clientMessageId === "client-agent-chat-1"
    ),
    "raw Agent Chat message.send"
  );
  const rawAgentChatUploadRequest = requests
    .filter(({ url, init }) =>
      new URL(url).pathname === "/api/v1/files" &&
      init.method === "POST"
    )
    .at(-1);
  const rawAgentChatUpload = rawAgentChatUploadRequest.init.body.get("file");
  assert.equal(rawAgentChatUpload.name, "Raw Plan.jsonl");
  assert.equal(rawAgentChatUpload.type, "application/x-ndjson");
  assert.equal(
    Buffer.compare(Buffer.from(await rawAgentChatUpload.arrayBuffer()), rawAgentChatBytes),
    0
  );
  const rawAgentChatFrame = sockets[0].sent.find((frame) =>
    frame.type === "message.send" &&
    frame.payload.clientMessageId === "client-agent-chat-1"
  );
  assert.equal(rawAgentChatFrame.payload.conversationId, "direct-1");
  assert.equal(rawAgentChatFrame.payload.clientMessageId, "client-agent-chat-1");
  assert.equal(rawAgentChatFrame.payload.kind, "file");
  assert.equal(rawAgentChatFrame.payload.body, "");
  assert.deepEqual(rawAgentChatFrame.payload.fileIds, ["file-image-1"]);
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: rawAgentChatFrame.id,
    type: "message.send",
    ok: true,
    result: {
      duplicate: false,
      message: {
        id: "message-agent-chat-1",
        conversationId: "direct-1",
        seq: 4,
        senderId: "alice",
        clientMessageId: "client-agent-chat-1",
        kind: "file",
        body: "",
        attachments: [{
          id: "file-image-1",
          name: "Raw Plan.jsonl",
          contentType: "application/x-ndjson",
          sizeBytes: rawAgentChatBytes.length,
          sha256: "raw-agent-chat-hash",
          createdAt: now
        }],
        createdAt: now + 3
      }
    }
  });
  const rawAgentChatState = await rawAgentChatPromise;
  assert.equal(
    rawAgentChatState.activeMessages.find((item) => item.id === "message-agent-chat-1")
      .attachments[0].contentType,
    "application/x-ndjson"
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
    kind: "desktop_action_request",
    body: "Please open the website",
    desktopAction: {
      requestId: "42d6ed61-b860-448c-9a4b-99fb057cfa6c",
      targetDeviceId: "device-1",
      action: "desktop.website.open",
      args: { websiteId: "docs" },
      operatorNote: "Please open the website",
      expiresAt: now + 60_000
    },
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
  assert.equal(normalizedAction.kind, "desktop_action_request");
  assert.equal(normalizedAction.desktopAction.action, "desktop.website.open");
  assert.equal(normalizedAction.desktopActionState, "pending");
  await assert.rejects(
    runtime.executeMessageDesktopAction({ messageId: actionMessage.id }),
    /decision is required/
  );
  const executionPromise = runtime.executeMessageDesktopAction({
    messageId: actionMessage.id,
    decision: "confirm"
  });
  await waitFor(() => sockets[0].sent.some((frame) => frame.type === "message.send" && frame.payload.kind === "desktop_action_result"), "desktop action result");
  const resultFrame = sockets[0].sent.find((frame) => frame.type === "message.send" && frame.payload.kind === "desktop_action_result");
  sockets[0].receive({
    v: 1,
    frame: "response",
    id: resultFrame.id,
    type: "message.send",
    ok: true,
    result: {
      duplicate: false,
      message: {
        id: "message-action-result-1",
        conversationId: "direct-1",
        seq: 5,
        senderId: "alice",
        clientMessageId: resultFrame.payload.clientMessageId,
        replyToId: actionMessage.id,
        kind: "desktop_action_result",
        body: "executed",
        desktopAction: resultFrame.payload.desktopAction,
        createdAt: now + 3
      }
    }
  });
  const execution = await executionPromise;
  assert.equal(execution.confirmed, true);
  assert.equal(execution.disposition, "completed");
  assert.equal(execution.deliveryState, "delivered");
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0].conversationId, "direct-1");
  assert.equal(
    runtime.getState().activeMessages.find((item) => item.id === actionMessage.id).desktopActionHandled,
    true
  );
  assert.equal(
    (await runtime.executeMessageDesktopAction({
      messageId: actionMessage.id,
      decision: "confirm"
    })).disposition,
    "already_handled"
  );
  assert.equal(
    (await runtime.executeMessageDesktopAction({
      messageId: "message-1",
      decision: "confirm"
    })).disposition,
    "not_executable"
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

test("enterprise chat creates safe raw Agent Chat filenames on macOS and Windows", () => {
  const title = "Quarter: Plan/Alpha\\Beta?.jsonl";

  assert.equal(
    __testInternals.safeRawAgentChatFilename(title, "chat-1", "darwin"),
    "Quarter_ Plan_Alpha_Beta?.jsonl"
  );
  assert.equal(
    __testInternals.safeRawAgentChatFilename(title, "chat-1", "win32"),
    "Quarter_ Plan_Alpha_Beta_.jsonl"
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
    kind: "desktop_action_request",
    body: "",
    desktopAction: {
      requestId: "request-unknown",
      targetDeviceId: "device-1",
      action: "desktop.unknown.action",
      args: {},
      expiresAt: now + 60_000
    },
    createdAt: now
  });
  assert.equal(forged.kind, "desktop_action_request");
  assert.equal(forged.desktopAction, undefined);
});

test("enterprise chat projects only current-device Desktop actions as pending", async (t) => {
  const fixture = createDesktopActionFixture(t, { targetDeviceId: "another-device" });
  await fixture.connect();

  const message = fixture.runtime.getState().activeMessages[0];
  assert.equal(message.desktopActionState, "not_executable");
  const result = await fixture.runtime.executeMessageDesktopAction({
    messageId: message.id,
    decision: "confirm"
  });
  assert.equal(result.disposition, "not_executable");
  assert.equal(result.deliveryState, "not_applicable");
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat allows only one concurrent execution for a Desktop action", async (t) => {
  let finishExecution;
  const fixture = createDesktopActionFixture(t, {
    executeDesktopAction: () => new Promise((resolve) => {
      finishExecution = resolve;
    })
  });
  const socket = await fixture.connect();
  const first = fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "confirm"
  });
  await waitFor(() => fixture.executedActions.length === 1, "first Desktop action execution");

  const duplicate = await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "confirm"
  });
  assert.equal(duplicate.disposition, "already_handled");
  assert.equal(fixture.executedActions.length, 1);

  finishExecution({
    response: { ok: true, action: fixture.request.desktopAction.action, result: {} },
    message: "executed"
  });
  await fixture.acknowledgeLatestActionReceipt(socket);
  const completed = await first;
  assert.equal(completed.disposition, "completed");
  assert.equal(completed.deliveryState, "delivered");
});

test("enterprise chat retries only the receipt after reconnecting during action completion", async (t) => {
  const fixture = createDesktopActionFixture(t);
  const firstSocket = await fixture.connect();
  const execution = fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "confirm"
  });
  await waitFor(
    () => firstSocket.sent.some((frame) => frame.type === "message.send" && frame.payload.kind === "desktop_action_result"),
    "first action receipt"
  );

  const refresh = fixture.runtime.refresh();
  const firstResult = await execution;
  assert.equal(firstResult.deliveryState, "pending");
  await refresh;
  const secondSocket = fixture.sockets[fixture.sockets.length - 1];
  await fixture.synchronize(secondSocket, false);
  const retriedFrame = await fixture.acknowledgeLatestActionReceipt(secondSocket, "2");
  assert.equal(retriedFrame.payload.clientMessageId, "desktop-action-result:stable-action-request");
  assert.equal(fixture.executedActions.length, 1);

  const reopenPromise = fixture.runtime.openConversation({
    conversationId: fixture.conversation.id
  });
  await waitFor(
    () => secondSocket.sent.some((frame) => frame.type === "receipt.read"),
    "receipt.read after reopening"
  );
  const readFrame = secondSocket.sent.find((frame) => frame.type === "receipt.read");
  secondSocket.receive({
    v: 1,
    frame: "response",
    id: readFrame.id,
    type: "receipt.read",
    ok: true,
    result: {}
  });
  const reopened = await reopenPromise;
  assert.equal(reopened.activeMessages[0].desktopActionState, "handled");
  const replay = await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "confirm"
  });
  assert.equal(replay.disposition, "already_handled");
  assert.equal(fixture.executedActions.length, 1);
});

test("enterprise chat closes a stale action path after sync reset without executing it", async (t) => {
  const fixture = createDesktopActionFixture(t);
  const socket = await fixture.connect();
  assert.equal(fixture.runtime.getState().activeMessages[0].desktopActionState, "pending");

  socket.receive({
    v: 1,
    frame: "push",
    type: "sync.reset_required",
    payload: {}
  });
  await waitFor(() => fixture.runtime.getState().activeMessages.length === 0, "sync reset snapshot");
  const result = await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "decline"
  });
  assert.equal(result.disposition, "not_executable");
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat records an offline decline and queues its receipt", async (t) => {
  const fixture = createDesktopActionFixture(t);
  const socket = await fixture.connect();
  socket.readyState = 3;

  const result = await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "decline"
  });
  assert.equal(result.status, "declined");
  assert.equal(result.disposition, "completed");
  assert.equal(result.deliveryState, "pending");
  assert.equal(fixture.runtime.getState().activeMessages[0].desktopActionState, "handled");
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat marks an expired action handled without presenting or executing it", async (t) => {
  const fixture = createDesktopActionFixture(t, { expiresAt: Date.now() - 1 });
  const socket = await fixture.connect();
  const message = fixture.runtime.getState().activeMessages[0];
  assert.equal(message.desktopActionState, "handled");
  assert.equal(fixture.executedActions.length, 0);
  const receipt = await fixture.acknowledgeLatestActionReceipt(socket);
  assert.equal(receipt.payload.desktopAction.status, "expired");
});

test("enterprise chat reconciles a historical Desktop action result without a local ledger", async (t) => {
  const fixture = createDesktopActionFixture(t);
  const resultMessage = {
    id: "historical-action-result",
    conversationId: fixture.conversation.id,
    seq: 2,
    senderId: "alice",
    actorUserId: "alice",
    senderDeviceId: "device-1",
    clientMessageId: "desktop-action-result:stable-action-request",
    replyToId: fixture.request.id,
    kind: "desktop_action_result",
    body: "executed",
    desktopAction: {
      requestId: fixture.request.desktopAction.requestId,
      targetDeviceId: fixture.request.desktopAction.targetDeviceId,
      action: fixture.request.desktopAction.action,
      status: "succeeded",
      message: "executed",
      completedAt: Date.now()
    },
    attachments: [],
    createdAt: Date.now()
  };
  fixture.setHistory([fixture.request, resultMessage]);
  await fixture.connect();

  const request = fixture.runtime.getState().activeMessages.find(
    (message) => message.id === fixture.request.id
  );
  assert.equal(request.desktopActionState, "handled");
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat reports but does not retry an execution interrupted by restart", async (t) => {
  const fixture = createDesktopActionFixture(t);
  const scope = enterpriseChatActionScope(
    "http://127.0.0.1:11956",
    "alice",
    "device-1"
  );
  const ledger = new EnterpriseChatActionLedger(
    path.join(fixture.userDataRoot, "enterprise-chat-action-ledger.json")
  );
  ledger.claim({
    scope,
    messageId: fixture.request.id,
    requestId: fixture.request.desktopAction.requestId,
    conversationId: fixture.conversation.id,
    targetDeviceId: "device-1",
    action: fixture.request.desktopAction.action
  });

  const socket = await fixture.connect(false);
  const receipt = await fixture.acknowledgeLatestActionReceipt(socket);
  assert.equal(receipt.payload.desktopAction.status, "failed");
  assert.match(receipt.payload.body, /outcome is unknown/);
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat fails confirmation closed when the ledger cannot be written", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-chat-ledger-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blockedUserDataRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedUserDataRoot, "blocked");
  const fixture = createDesktopActionFixture(t, { userDataRoot: blockedUserDataRoot });
  await fixture.connect();

  const result = await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "confirm"
  });
  assert.equal(result.disposition, "not_executable");
  assert.match(result.message, /idempotency state/);
  assert.equal(fixture.executedActions.length, 0);
});

test("enterprise chat resolves the action ledger after the final Electron userData path is installed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-chat-ledger-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialUserDataRoot = path.join(root, "initial");
  const finalUserDataRoot = path.join(root, "final");
  let currentUserDataRoot = initialUserDataRoot;
  const fixture = createDesktopActionFixture(t, {
    userDataRoot: initialUserDataRoot,
    getUserDataRoot: () => currentUserDataRoot
  });
  currentUserDataRoot = finalUserDataRoot;
  const socket = await fixture.connect();
  socket.readyState = 3;
  await fixture.runtime.executeMessageDesktopAction({
    messageId: fixture.request.id,
    decision: "decline"
  });

  assert.equal(
    fs.existsSync(path.join(finalUserDataRoot, "enterprise-chat-action-ledger.json")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(initialUserDataRoot, "enterprise-chat-action-ledger.json")),
    false
  );
});

test("enterprise chat ledger migrates legacy handled IDs and does not retry interrupted executions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-chat-ledger-migration-"));
  const ledgerPath = path.join(root, "enterprise-chat-action-ledger.json");
  try {
    fs.writeFileSync(ledgerPath, JSON.stringify({ messageIds: ["legacy-message"] }));
    const scope = enterpriseChatActionScope("https://im.example.test", "alice", "device-1");
    const first = new EnterpriseChatActionLedger(ledgerPath);
    assert.equal(first.hasLegacyMessage("legacy-message"), true);
    first.claim({
      scope,
      messageId: "interrupted-message",
      requestId: "interrupted-request",
      conversationId: "direct-1",
      targetDeviceId: "device-1",
      action: "desktop.website.open"
    });

    const restarted = new EnterpriseChatActionLedger(ledgerPath);
    const recovered = restarted.recoverExecuting(scope);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].phase, "terminal");
    assert.equal(recovered[0].status, "failed");
    assert.equal(recovered[0].deliveryState, "pending");
    assert.match(recovered[0].resultMessage, /outcome is unknown/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
