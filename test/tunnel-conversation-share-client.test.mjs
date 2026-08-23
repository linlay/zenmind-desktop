import test from "node:test";
import assert from "node:assert/strict";

const {
  TunnelConversationShareClient,
  TunnelConversationShareError
} = await import("../dist-electron/main/assistant/core/tunnel-conversation-share-client.js");

const target = {
  origin: "https://tunnel.example.test",
  accessToken: "secret-site-token"
};

function record(overrides = {}) {
  return {
    id: "share_abc",
    url: "https://share.example.test/share/share_abc",
    createdAt: "2026-08-17T10:00:00.000Z",
    expiresAt: "2026-09-16T10:00:00.000Z",
    lastAccessedAt: null,
    ...overrides
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

test("Tunnel client forwards the original HTML Buffer and exact creation protocol", async () => {
  const html = Buffer.from("<!doctype html><title>opaque</title>");
  const requests = [];
  const client = new TunnelConversationShareClient(async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse(record(), 201);
  });

  const result = await client.create({
    target,
    conversationId: "chat_1",
    expiration: "30d",
    html
  });

  assert.equal(result.shareId, "share_abc");
  assert.equal(result.createdAt, Date.parse("2026-08-17T10:00:00.000Z"));
  assert.equal(result.expiresAt, Date.parse("2026-09-16T10:00:00.000Z"));
  assert.equal(requests[0].url, "https://tunnel.example.test/api/desktop/shares");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "manual");
  assert.equal(requests[0].init.body, html);
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-site-token");
  assert.equal(requests[0].init.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(requests[0].init.headers["Content-Length"], String(html.byteLength));
  assert.equal(requests[0].init.headers["X-Conversation-Document-Version"], "1");
  assert.equal(requests[0].init.headers["X-Conversation-ID"], "chat_1");
  assert.equal(requests[0].init.headers["X-Conversation-Share-Expiration"], "30d");
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test("Tunnel client requires explicit null metadata for permanent shares", async () => {
  const client = new TunnelConversationShareClient(async () =>
    jsonResponse(record({ id: "share_permanent", expiresAt: null }), 201)
  );
  const result = await client.create({
    target,
    conversationId: "chat_1",
    expiration: "permanent",
    html: Buffer.from("html")
  });

  assert.equal(result.shareId, "share_permanent");
  assert.equal(result.expiresAt, null);
  assert.equal(result.lastAccessedAt, null);
});

test("Tunnel client lists RFC3339 metadata and rejects duplicate IDs", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      items: [record({ expiresAt: null, lastAccessedAt: "2026-08-17T10:05:00.000Z" })]
    }),
    jsonResponse({ items: [record(), record()] })
  ];
  const client = new TunnelConversationShareClient(async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift();
  });

  const records = await client.list(target, "chat / 1");
  assert.equal(records[0].lastAccessedAt, Date.parse("2026-08-17T10:05:00.000Z"));
  assert.equal(records[0].expiresAt, null);
  assert.equal(requests[0].url, "https://tunnel.example.test/api/desktop/shares?conversationId=chat+%2F+1");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.redirect, "manual");

  await assert.rejects(
    () => client.list(target, "chat_1"),
    (error) => error instanceof TunnelConversationShareError && error.kind === "invalid_response"
  );
});

test("Tunnel client revokes directly and preserves Tunnel 404 semantics", async () => {
  const requests = [];
  const responses = [new Response(null, { status: 204 }), jsonResponse({ error: "private body" }, 404)];
  const client = new TunnelConversationShareClient(async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift();
  });

  await client.revoke(target, "opaque-abc_123");
  assert.equal(requests[0].url, "https://tunnel.example.test/api/desktop/shares/opaque-abc_123");
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].init.redirect, "manual");

  await assert.rejects(
    () => client.revoke(target, "opaque-abc_123"),
    (error) => {
      assert.equal(error.kind, "rejected");
      assert.equal(error.status, 404);
      assert.doesNotMatch(error.message, /private body|secret-site-token/u);
      return true;
    }
  );
});

test("Tunnel client rejects unsafe targets before network access", async () => {
  let calls = 0;
  const client = new TunnelConversationShareClient(async () => {
    calls += 1;
    return jsonResponse({ items: [] });
  });
  for (const origin of [
    "http://tunnel.example.test",
    "https://tunnel.example.test/path",
    "https://127.0.0.2:18181",
    "https://demo.localhost:18181",
    "https://0.0.0.0:18181"
  ]) {
    await assert.rejects(
      () => client.list({ ...target, origin }, "chat_1"),
      (error) => error instanceof TunnelConversationShareError && error.kind === "invalid_request",
      origin
    );
  }
  await assert.rejects(() => client.list({ ...target, accessToken: "bad token" }, "chat_1"));
  assert.equal(calls, 0);
});

test("Tunnel client rejects redirects, invalid JSON, oversized JSON, URLs, RFC3339 and time order", async () => {
  const oversized = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
  const responses = [
    new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
    new Response("{broken", { status: 201, headers: { "content-type": "application/json" } }),
    new Response(oversized, { status: 201, headers: { "content-type": "application/json" } }),
    jsonResponse(record({ url: "http://share.example.test/share/share_abc" }), 201),
    jsonResponse(record({ createdAt: "2026-02-30T10:00:00.000Z" }), 201),
    jsonResponse(record({ expiresAt: "2026-08-17T09:00:00.000Z" }), 201),
    jsonResponse({ ...record(), unexpected: true }, 201),
    new Response(JSON.stringify(record()), { status: 201, headers: { "content-type": "text/plain" } })
  ];
  const client = new TunnelConversationShareClient(async () => responses.shift());

  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(
      () => client.create({
        target,
        conversationId: "chat_1",
        expiration: "30d",
        html: Buffer.from("html")
      }),
      (error) => error instanceof TunnelConversationShareError,
      `case ${index}`
    );
  }
});

test("Tunnel client classifies timeout and network failures without leaking details", async () => {
  const timeoutClient = new TunnelConversationShareClient(async () => {
    throw new DOMException("secret-site-token", "TimeoutError");
  });
  const networkClient = new TunnelConversationShareClient(async () => {
    throw new Error("response body with secret-site-token");
  });

  await assert.rejects(
    () => timeoutClient.list(target, "chat_1"),
    (error) => {
      assert.equal(error.kind, "timeout");
      assert.doesNotMatch(error.message, /secret-site-token/u);
      return true;
    }
  );
  await assert.rejects(
    () => networkClient.list(target, "chat_1"),
    (error) => {
      assert.equal(error.kind, "unavailable");
      assert.doesNotMatch(error.message, /secret-site-token|response body/u);
      return true;
    }
  );
});

test("Tunnel client enforces the local 20 MiB HTML boundary without fetching", async () => {
  let called = false;
  const client = new TunnelConversationShareClient(async () => {
    called = true;
    return jsonResponse(record(), 201);
  });

  await assert.rejects(
    () => client.create({
      target,
      conversationId: "chat_1",
      expiration: "30d",
      html: Buffer.alloc(20 * 1024 * 1024 + 1)
    }),
    (error) => error instanceof TunnelConversationShareError && error.status === 413
  );
  assert.equal(called, false);
});
