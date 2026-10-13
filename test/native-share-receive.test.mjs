import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const compiledRoot = process.env.NATIVE_SHARE_COMPILED_ROOT || path.resolve("dist-electron");
const { receiveNativeShare, NativeShareController } = require(path.join(compiledRoot, "main/modules/native-share/index.js"));
const { NATIVE_SHARE_MAX_BYTES, NATIVE_SHARE_MAX_FILES } = require(path.join(compiledRoot, "shared/native-share.js"));
const batchId = "12345678-1234-4234-8234-123456789abc";

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-share-receive-")));
  const inbox = path.join(root, "owned", "data", "native-share");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, inbox, batch: path.join(inbox, batchId) };
}

async function extension(t, options = {}) {
  const files = options.files || [{ name: "微信聊天记录.zip", bytes: Buffer.from("chat record content") }];
  const manifest = options.manifest || { version: 1, id: batchId, files: files.map(file => ({ name: file.name, sizeBytes: file.bytes.length })) };
  const ticket = randomBytes(32).toString("base64url");
  const requests = [];
  const sockets = new Set();
  let acknowledged = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", bytes => {
      input += bytes.toString("utf8");
      if (!input.includes("\r\n\r\n")) return;
      const head = input.split("\r\n\r\n", 1)[0];
      const lines = head.split("\r\n");
      const [method, requestPath] = lines.shift().split(" ");
      const headers = Object.fromEntries(lines.map(line => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      requests.push({ method, path: requestPath, headers, address: socket.remoteAddress });
      const respond = (status, body, type = "application/octet-stream", extra = []) => {
        const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
        socket.end(Buffer.concat([Buffer.from([
          `HTTP/1.1 ${status} response`, `Content-Type: ${type}`, `Content-Length: ${content.length}`, "Connection: close", ...extra, "", ""
        ].join("\r\n")), content]));
      };
      if (headers["x-native-share-ticket"] !== ticket) { respond(403, ""); return; }
      if (options.respond?.({ socket, method, path: requestPath, headers, respond, files, manifest })) return;
      if (requestPath === `/v1/share/${batchId}/manifest` && method === "GET") {
        respond(200, Buffer.from(JSON.stringify(manifest)), "application/json");
      } else if (requestPath.startsWith(`/v1/share/${batchId}/file/`) && method === "GET") {
        const index = Number(requestPath.split("/").at(-1));
        if (!files[index]) { respond(404, ""); return; }
        respond(200, files[index].bytes);
      } else if (requestPath === `/v1/share/${batchId}/complete` && method === "POST") {
        acknowledged += 1;
        options.onComplete?.();
        respond(200, "");
      } else respond(404, "");
      socket.removeAllListeners("data");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  return { transfer: { batchId, port, ticket }, requests, files, manifest, server, close, acknowledgements: () => acknowledged };
}

function assertNoPublishedCopy(f) {
  assert.equal(fs.existsSync(f.batch), false);
  if (fs.existsSync(f.inbox)) assert.deepEqual(fs.readdirSync(f.inbox), [], "no partial batches survive a failed receive");
}

test("loopback transfers bounded bytes to Desktop-owned storage and acknowledges only after atomic publication", async t => {
  const f = workspace(t);
  const files = [{ name: "聊天记录.zip", bytes: randomBytes(256 * 1024 + 13) }, { name: "备注.txt", bytes: Buffer.alloc(0) }];
  const peer = await extension(t, { files, onComplete() {
    assert.deepEqual(fs.readdirSync(f.inbox), [batchId]);
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(f.batch, file.name)), file.bytes);
  } });
  assert.deepEqual(await receiveNativeShare(peer.transfer, f.inbox), { reused: false, acknowledged: true });
  assert.equal(peer.acknowledgements(), 1);
  assert.deepEqual(peer.requests.map(({ method, path: requestPath }) => `${method} ${requestPath}`), [
    `GET /v1/share/${batchId}/manifest`, `GET /v1/share/${batchId}/file/0`, `GET /v1/share/${batchId}/file/1`, `POST /v1/share/${batchId}/complete`
  ]);
  assert.ok(peer.requests.every(request => request.address === "127.0.0.1" && request.headers["x-native-share-ticket"] === peer.transfer.ticket));
  assert.equal(fs.statSync(f.batch).mode & 0o777, 0o700);
  for (const file of ["manifest.json", ...files.map(item => item.name)]) assert.equal(fs.statSync(path.join(f.batch, file)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.batch, ".completed.json")), false, "transport receipt does not submit or mark the chat draft as sent");
});

test("source-specific chat exports share the same transport without content parsing or source-specific protocol fields", async t => {
  // Synthetic formats exercise the shared transport contract, not real vendor integration.
  const files = [
    { name: "wechat.zip", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
    { name: "feishu.json", bytes: Buffer.from('{"messages":[{"text":"sample"}]}') },
    { name: "wecom.html", bytes: Buffer.from("<p>sample message</p>") },
    { name: "qq.txt", bytes: Buffer.from("sample message") }
  ];
  const f = workspace(t);
  const peer = await extension(t, { files });
  assert.deepEqual(await receiveNativeShare(peer.transfer, f.inbox), { reused: false, acknowledged: true });
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(f.batch, file.name)), file.bytes);
  assert.ok(peer.requests.every(request => request.headers["x-native-share-ticket"] === peer.transfer.ticket));
  assert.ok(peer.requests.every(request => !("x-cutej-share-ticket" in request.headers)));
});

test("a controller uses received files as a draft and repeats a new handoff without replacing its nonce or bytes", async t => {
  const f = workspace(t);
  const shown = [];
  let active;
  const controller = new NativeShareController({ platform: "darwin", inbox: f.inbox, getDefaultAgentKey: () => "xiaojun",
    isTargetActive: target => JSON.stringify(target) === JSON.stringify(active),
    showMainWindow(route) {
      shown.push(route);
      const url = new URL(route, "https://desktop.test");
      active = { batchId: url.searchParams.get("shareBatch"), agentKey: "xiaojun", newChat: url.searchParams.get("newChat") };
    }
  });
  t.after(() => controller.dispose());
  const first = await extension(t);
  await controller.open(batchId, first.transfer);
  const target = { ...active };
  const repeated = await extension(t, { files: [{ name: "changed.txt", bytes: Buffer.from("must not replace") }] });
  await controller.open(batchId, repeated.transfer);
  assert.deepEqual(active, target);
  assert.equal(new Set(shown).size, 1);
  assert.deepEqual(repeated.requests.map(request => request.method), ["POST"], "a cached batch requires only a source acknowledgement");
  assert.deepEqual(fs.readFileSync(path.join(f.batch, first.files[0].name)), first.files[0].bytes);
  assert.equal(fs.existsSync(path.join(f.batch, "changed.txt")), false);
  const description = await controller.read({ ...active, operation: "describe" });
  assert.equal(description.ok, true);
  assert.equal(description.files[0].name, first.files[0].name);
});

test("macOS without an explicit Desktop inbox never falls back to extension containers", async () => {
  const controller = new NativeShareController({ platform: "darwin", homePath: "/Users/unused", bundleId: "example.legacy",
    getDefaultAgentKey: () => "xiaojun", showMainWindow() { throw Error("must not navigate"); }, isTargetActive: () => false });
  await assert.rejects(controller.open(batchId), { code: "invalid_request" });
  const result = await controller.read({ batchId, newChat: "1700000000000", agentKey: "xiaojun", operation: "describe" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
});

test("handoff capabilities reject endpoint injection, unsafe ports and noncanonical tickets before connecting", async t => {
  const f = workspace(t);
  const peer = await extension(t);
  const inputs = [
    ...[0, -1, 65536, 1.5, NaN].map(port => ({ ...peer.transfer, port })),
    { ...peer.transfer, batchId: "../outside" }, { ...peer.transfer, ticket: "short" },
    { ...peer.transfer, ticket: `${peer.transfer.ticket}\r\nHeader: injected` },
    { ...peer.transfer, host: "remote.example" }, { ...peer.transfer, url: "http://remote.example/file" },
    { ...peer.transfer, ticket: "_".repeat(43) }
  ];
  for (const transfer of inputs) await assert.rejects(receiveNativeShare(transfer, f.inbox), { code: "invalid_request" });
  assert.equal(peer.requests.length, 0);
  assert.equal(fs.existsSync(f.inbox), false);
});

test("an incorrect valid-length ticket cannot copy a new batch", async t => {
  const f = workspace(t);
  const peer = await extension(t);
  await assert.rejects(receiveNativeShare({ ...peer.transfer, ticket: randomBytes(32).toString("base64url") }, f.inbox), { code: "invalid_batch" });
  assertNoPublishedCopy(f);
  assert.equal(peer.acknowledgements(), 0);
});

test("redirects never contact another endpoint or acknowledge the source", async t => {
  const f = workspace(t);
  let followed = 0;
  const destination = net.createServer(socket => { followed += 1; socket.end(); });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const peer = await extension(t, { respond({ respond }) {
    respond(302, "", "application/json", [`Location: http://127.0.0.1:${destination.address().port}/private`]);
    return true;
  } });
  await assert.rejects(receiveNativeShare(peer.transfer, f.inbox), { code: "invalid_batch" });
  assert.equal(followed, 0);
  assertNoPublishedCopy(f);
});

test("unsafe manifest names, counts, versions and declared budgets fail before opening file requests", async t => {
  const invalid = [
    { version: 2, id: batchId, files: [] },
    ...["../secret", "folder\\file", ".completed.json", "manifest.json", "bad\0name"].map(name => ({ version: 1, id: batchId, files: [{ name, sizeBytes: 1 }] })),
    { version: 1, id: batchId, files: [{ name: "chat.zip", sizeBytes: NATIVE_SHARE_MAX_BYTES + 1 }] },
    { version: 1, id: batchId, files: Array.from({ length: NATIVE_SHARE_MAX_FILES + 1 }, (_, index) => ({ name: `${index}.txt`, sizeBytes: 0 })) }
  ];
  for (const manifest of invalid) {
    const f = workspace(t);
    const peer = await extension(t, { manifest });
    await assert.rejects(receiveNativeShare(peer.transfer, f.inbox), { code: "invalid_batch" });
    assert.equal(peer.requests.length, 1);
    assertNoPublishedCopy(f);
  }
});

test("malformed fixed-length responses, encodings and oversized headers cannot publish partial data", async t => {
  const malformed = [
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Encoding: gzip\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 65537\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
    `HTTP/1.1 200 OK\r\nX-Too-Large: ${"x".repeat(8192)}\r\n\r\n`,
    "HTTP/1.1 200 OK\r\nContent-Length: +2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\n\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}"
  ];
  for (const response of malformed) {
    const f = workspace(t);
    const peer = await extension(t, { respond({ socket }) { socket.end(response); return true; } });
    await assert.rejects(receiveNativeShare(peer.transfer, f.inbox), { code: "invalid_batch" });
    assertNoPublishedCopy(f);
    assert.equal(peer.acknowledgements(), 0);
  }
});

test("truncated, trailing or mismatched file bodies fail and leave no public batch", async t => {
  for (const [length, body] of [[18, "too short"], [18, "x".repeat(19)], [19, "x".repeat(19)]]) {
    const f = workspace(t);
    const peer = await extension(t, { files: [{ name: "chat.zip", bytes: Buffer.alloc(18) }], respond({ socket, path: requestPath }) {
      if (!requestPath.includes("/file/")) return false;
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`);
      return true;
    } });
    await assert.rejects(receiveNativeShare(peer.transfer, f.inbox), { code: "invalid_batch" });
    assertNoPublishedCopy(f);
  }
});

test("a peer that stops responding or does not close its connection times out without a partial batch", async t => {
  for (const response of ["", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}"] ) {
    const f = workspace(t);
    const peer = await extension(t, { respond({ socket }) { if (response) socket.write(response); return true; } });
    await assert.rejects(receiveNativeShare(peer.transfer, f.inbox, { timeoutMs: 100, socketTimeoutMs: 30 }), { code: "io_error" });
    assertNoPublishedCopy(f);
  }
});

test("symlink inbox parents, public batch directories and cached attachments cannot escape owned storage", async t => {
  for (const component of ["parent", "root", "batch", "file"]) {
    const f = workspace(t);
    const peer = await extension(t);
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "private original");
    if (component === "parent") fs.symlinkSync(outside, path.join(f.root, "owned"));
    if (component === "root") { fs.mkdirSync(path.dirname(f.inbox), { recursive: true }); fs.symlinkSync(outside, f.inbox); }
    if (component === "batch") { fs.mkdirSync(f.inbox, { recursive: true }); fs.symlinkSync(outside, f.batch); }
    if (component === "file") {
      fs.mkdirSync(f.batch, { recursive: true });
      fs.writeFileSync(path.join(f.batch, "manifest.json"), JSON.stringify({ version: 1, id: batchId, files: [{ name: "private.txt", sizeBytes: 16 }] }));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(f.batch, "private.txt"));
    }
    await assert.rejects(receiveNativeShare(peer.transfer, f.inbox));
    assert.equal(peer.requests.length, 0);
    assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "private original");
  }
});

test("disk write failure removes only its own staging directory and never acknowledges the source", async t => {
  const f = workspace(t);
  fs.mkdirSync(f.inbox, { recursive: true });
  const unrelated = path.join(f.inbox, "unrelated-data");
  fs.writeFileSync(unrelated, "keep existing work");
  const peer = await extension(t);
  const originalOpen = fs.promises.open;
  fs.promises.open = async (openedPath, ...args) => {
    const handle = await originalOpen.call(fs.promises, openedPath, ...args);
    if (String(openedPath).endsWith(".zip")) handle.write = async () => { throw Object.assign(new Error("full disk"), { code: "ENOSPC", syscall: "write" }); };
    return handle;
  };
  try { await assert.rejects(receiveNativeShare(peer.transfer, f.inbox), { code: "ENOSPC" }); }
  finally { fs.promises.open = originalOpen; }
  assert.deepEqual(fs.readdirSync(f.inbox), ["unrelated-data"]);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep existing work");
  assert.equal(peer.acknowledgements(), 0);
});

test("lost source acknowledgement preserves the full copy and retries can acknowledge without recopying", async t => {
  const f = workspace(t);
  const diagnostics = [];
  const first = await extension(t, { respond({ socket, method }) { if (method === "POST") { socket.destroy(); return true; } return false; } });
  assert.deepEqual(await receiveNativeShare(first.transfer, f.inbox, { onAcknowledgementError(error) { diagnostics.push(error); } }), { reused: false, acknowledged: false });
  assert.deepEqual(fs.readFileSync(path.join(f.batch, first.files[0].name)), first.files[0].bytes);
  assert.equal(diagnostics.length, 1);
  const repeated = await extension(t);
  assert.deepEqual(await receiveNativeShare(repeated.transfer, f.inbox), { reused: true, acknowledged: true });
  assert.deepEqual(repeated.requests.map(request => request.method), ["POST"]);
  await repeated.close();
  assert.deepEqual(await receiveNativeShare(repeated.transfer, f.inbox), { reused: true, acknowledged: false }, "expired capabilities do not destroy an already received draft");
  assert.deepEqual(fs.readFileSync(path.join(f.batch, first.files[0].name)), first.files[0].bytes);
});
