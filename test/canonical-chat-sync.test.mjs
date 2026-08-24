import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CANONICAL_CHAT_SYNC_REQUEST_CHANNEL,
  CANONICAL_CHAT_SYNC_RESULT_CHANNEL,
  classifyAgentWebclientNewChatRegistration,
  createCanonicalAgentChatRoute,
  createPreparedAgentChatRoute,
  readAgentWebclientCanonicalChatSource,
  readAgentWebclientNewChatSource,
  resolveAgentWebclientNewChatRegistrationOutcome,
} = require("../dist-electron/shared/canonical-chat-sync.js");
const {
  registerCanonicalChatSyncIpc,
} = require("../dist-electron/main/ipc/canonical-chat-sync.js");

test("canonical Chat route promotion preserves unrelated query parameters and hash", () => {
  const source = "/agent/%E7%BC%96%E7%A8%8B?newChat=nonce-1&mode=review&mode=compact#draft";
  assert.deepEqual(readAgentWebclientNewChatSource(source), {
    agentKey: "编程",
    newChat: "nonce-1",
  });
  assert.equal(
    createCanonicalAgentChatRoute(source, {
      agentKey: "编程",
      newChat: "nonce-1",
      chatId: "chat-canonical",
    }),
    "/agent/%E7%BC%96%E7%A8%8B?mode=review&mode=compact&chatId=chat-canonical#draft",
  );
  assert.equal(
    createCanonicalAgentChatRoute(source, {
      agentKey: "编程",
      newChat: "stale",
      chatId: "chat-canonical",
    }),
    "",
  );
});

test("new Chat preparation accepts only the exact canonical source route", () => {
  assert.equal(
    createPreparedAgentChatRoute(
      "/agent/%E7%BC%96%E7%A8%8B?chatId=chat-old&history=1#events",
      {
        agentKey: "编程",
        sourceChatId: "chat-old",
        newChat: "1783680000000",
      },
    ),
    "/agent/%E7%BC%96%E7%A8%8B?newChat=1783680000000",
  );
  assert.equal(
    createPreparedAgentChatRoute("/agent/coder?chatId=other", {
      agentKey: "coder",
      sourceChatId: "chat-old",
      newChat: "1783680000000",
    }),
    "",
  );
  assert.equal(
    createPreparedAgentChatRoute(
      "/agent/coder?chatId=chat-old&newChat=1783680000000",
      {
        agentKey: "coder",
        sourceChatId: "chat-old",
        newChat: "1783680000001",
      },
    ),
    "",
  );
  assert.equal(
    createPreparedAgentChatRoute("/agent/coder?chatId=chat-old", {
      agentKey: "coder",
      sourceChatId: "chat-old",
      newChat: "nonce",
    }),
    "",
  );
});

test("new Chat registration waits for the source guest and acknowledges only the coherent target", () => {
  const base = {
    sourceRoute: "/agent/coder?chatId=chat-old",
    targetRoute: "/agent/coder?newChat=1783680000000",
    pageRouteIdentity: "/agent/coder?newChat=1783680000000",
  };
  const sourcePending = classifyAgentWebclientNewChatRegistration({
    ...base,
    guestUrl: "http://127.0.0.1:17080/agent/coder?chatId=chat-old",
  });
  assert.equal(sourcePending, "source_pending");
  assert.equal(
    resolveAgentWebclientNewChatRegistrationOutcome(sourcePending, false),
    "wait",
  );
  assert.equal(
    resolveAgentWebclientNewChatRegistrationOutcome(sourcePending, true),
    "wait",
  );

  const targetReady = classifyAgentWebclientNewChatRegistration({
    ...base,
    guestUrl: "http://127.0.0.1:17080/agent/coder?newChat=1783680000000",
  });
  assert.equal(targetReady, "target_ready");
  assert.equal(
    resolveAgentWebclientNewChatRegistrationOutcome(targetReady, true),
    "acknowledge",
  );
  assert.equal(
    resolveAgentWebclientNewChatRegistrationOutcome(targetReady, false),
    "fail",
  );
});

test("new Chat registration rejects incoherent route and owner identities", () => {
  const base = {
    sourceRoute: "/agent/coder?chatId=chat-old",
    targetRoute: "/agent/coder?newChat=1783680000000",
    pageRouteIdentity: "/agent/coder?newChat=1783680000000",
    guestUrl: "http://127.0.0.1:17080/agent/coder?newChat=1783680000000",
  };
  for (const input of [
    { ...base, sourceRoute: "/agent/other?chatId=chat-old" },
    { ...base, pageRouteIdentity: "/agent/coder?newChat=1783680000001" },
    { ...base, guestUrl: "http://127.0.0.1:17080/agent/other?newChat=1783680000000" },
    { ...base, guestUrl: "http://127.0.0.1:17080/agent/coder?chatId=chat-other" },
    { ...base, ownerChatId: "chat-old" },
  ]) {
    const state = classifyAgentWebclientNewChatRegistration(input);
    assert.equal(state, "invalid");
    assert.equal(
      resolveAgentWebclientNewChatRegistrationOutcome(state, true),
      "fail",
    );
    assert.equal(
      resolveAgentWebclientNewChatRegistrationOutcome(state, false),
      "fail",
    );
  }
});

test("Main Chat route identity parsers reject ambiguous canonical and new Chat sources", () => {
  assert.deepEqual(
    readAgentWebclientCanonicalChatSource("/agent/coder?chatId=chat-1"),
    { agentKey: "coder", chatId: "chat-1" },
  );
  assert.deepEqual(
    readAgentWebclientNewChatSource("/agent/coder?newChat=nonce-1"),
    { agentKey: "coder", newChat: "nonce-1" },
  );
  for (const source of [
    "/agent/coder?chatId=",
    "/agent/coder?chatId=chat-1&chatId=",
    "/agent/coder?chatId=chat-1&newChat=nonce-1",
    "/agent/coder/child?chatId=chat-1",
  ]) {
    assert.equal(readAgentWebclientCanonicalChatSource(source), null, source);
  }
  for (const source of [
    "/agent/coder?newChat=",
    "/agent/coder?newChat=nonce-1&newChat=",
    "/agent/coder?newChat=nonce-1&chatId=",
    "/agent/coder/child?newChat=nonce-1",
  ]) {
    assert.equal(readAgentWebclientNewChatSource(source), null, source);
  }
});

test("canonical Chat IPC accepts an ACK only from the owning renderer", async () => {
  const listeners = new Map();
  const sent = [];
  const renderer = {
    id: 7,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const coordinator = registerCanonicalChatSyncIpc({
    on(channel, listener) { listeners.set(channel, listener); },
  }, {
    resolveRenderer: (id) => id === renderer.id ? renderer : null,
    timeoutMs: 100,
  });
  const pending = coordinator.request(renderer.id, {
    sourceId: "surface:query-1",
    surfaceId: "main-chat",
    registrationId: "registration-1",
    guestWebContentsId: 41,
    agentKey: "coder",
    newChat: "nonce-1",
    chatId: "chat-1",
  });
  assert.equal(sent[0].channel, CANONICAL_CHAT_SYNC_REQUEST_CHANNEL);
  listeners.get(CANONICAL_CHAT_SYNC_RESULT_CHANNEL)(
    { sender: { id: 8 } },
    { requestId: sent[0].payload.requestId, ok: true },
  );
  listeners.get(CANONICAL_CHAT_SYNC_RESULT_CHANNEL)(
    { sender: renderer },
    { requestId: sent[0].payload.requestId, ok: true },
  );
  assert.deepEqual(await pending, {
    requestId: sent[0].payload.requestId,
    ok: true,
  });
});
