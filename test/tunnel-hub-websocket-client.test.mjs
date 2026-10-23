import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { connectTunnelHubWebSocket } = require("../dist-electron/main/modules/tunnel/websocket-client.js");
const { TunnelHubYamuxSession } = require("../dist-electron/main/modules/tunnel/yamux.js");
const MAX_BYTES = 64 << 20;

function frame(opcode, payload = Buffer.alloc(0), fin = true, length = payload.length) {
  const header = Buffer.alloc(length < 126 ? 2 : length <= 0xffff ? 4 : 10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = length < 126 ? length : length <= 0xffff ? 126 : 127;
  if (length >= 126 && length <= 0xffff) header.writeUInt16BE(length, 2);
  if (length > 0xffff) header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function clientFrame(wire) {
  const tag = wire[1] & 0x7f;
  const header = tag < 126 ? 2 : tag === 126 ? 4 : 10;
  const mask = wire.subarray(header, header + 4);
  const payload = Buffer.from(wire.subarray(header + 4));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode: wire[0] & 0xf, masked: Boolean(wire[1] & 0x80), payload };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "WebSocket event did not arrive");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, initial = Buffer.alloc(0), start = true) {
  let socket;
  const server = http.createServer();
  server.on("upgrade", (request, peer) => {
    socket = peer;
    assert.equal(request.url, "/relay?target=desktop");
    assert.equal(request.headers["x-test"], "desktop");
    assert.equal(request.headers["x-test-multi"], "one, two");
    assert.equal(request.headers["sec-websocket-extensions"], undefined);
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    peer.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), initial]));
  });
  t.after(async () => { socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = await connectTunnelHubWebSocket(`ws://127.0.0.1:${server.address().port}/relay?target=desktop`, {
    headers: { "X-Test": "desktop", "X-Test-Multi": ["one", "two"] }
  });
  t.after(() => client.destroy());
  const messages = [], errors = [], closes = [];
  client.on("message", message => messages.push(message));
  client.on("error", error => errors.push(error));
  client.on("close", () => closes.push(true));
  if (start) client.startReceiving();
  return { client, socket, messages, errors, closes, feed: data => socket.write(data) };
}

for (const type of [1, 2]) {
  for (const size of [0, 125, 126, 20666, 37679, 65535, 65536]) {
    test(`type=${type} size=${size}: fragmented and complete messages survive TCP cuts`, async t => {
      const f = await fixture(t);
      const payload = Buffer.alloc(size, 0x61);
      const split = Math.floor(size / 2);
      const wire = Buffer.concat([frame(type, payload.subarray(0, split), false), frame(0, Buffer.alloc(0), false),
        frame(0, payload.subarray(split)), frame(type, payload)]);
      for (let offset = 0; offset < wire.length;) {
        const length = offset < 10 ? 1 : 4093;
        f.feed(wire.subarray(offset, offset + length));
        offset += length;
      }
      await until(() => f.messages.length === 2);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.messages, [{ type, payload }, { type, payload }]);
    });
  }
}

test("UTF-8 stays intact and Ping is answered before the final continuation", async t => {
  const f = await fixture(t);
  const payload = Buffer.from("中文🙂分片");
  const pong = once(f.socket, "data");
  f.feed(frame(1, payload.subarray(0, 1), false));
  f.feed(frame(9, Buffer.from("heartbeat")));
  assert.deepEqual(clientFrame((await pong)[0]), { opcode: 10, masked: true, payload: Buffer.from("heartbeat") });
  assert.equal(f.messages.length, 0);
  f.feed(frame(0, payload.subarray(1)));
  await until(() => f.messages.length === 1);
  assert.deepEqual(f.messages, [{ type: 1, payload }]);
});

test("many empty continuations and an empty final continuation keep the next message independent", async t => {
  const f = await fixture(t);
  const payload = Buffer.alloc(20666, 0x62);
  f.feed(Buffer.concat([frame(2, payload, false), ...Array.from({ length: 20000 }, () => frame(0, Buffer.alloc(0), false)),
    frame(0), frame(1, Buffer.from("next"))]));
  await until(() => f.messages.length === 2);
  assert.deepEqual(f.messages, [{ type: 2, payload }, { type: 1, payload: Buffer.from("next") }]);
});

for (const [name, frames] of [
  ["orphan continuation", [frame(0)]],
  ["interleaved data message", [frame(2, Buffer.alloc(0), false), frame(1)]],
  ["fragmented Ping", [frame(9, Buffer.alloc(0), false)]],
  ["fragmented Pong", [frame(10, Buffer.alloc(0), false)]],
  ["fragmented Close", [frame(8, Buffer.alloc(0), false)]],
  ["oversize control", [frame(9, Buffer.alloc(0), true, 126)]],
  ["reserved opcode", [frame(3)]],
  ["oversize frame header", [frame(2, Buffer.alloc(0), true, MAX_BYTES + 1)]],
  ["aggregate size", [frame(2, Buffer.alloc(32 << 20), false), frame(0, Buffer.alloc(0), true, 33 << 20)]]
]) {
  test(`${name} fails without delivering partial data`, async t => {
    const f = await fixture(t);
    for (const data of frames) f.feed(data);
    await until(() => f.errors.length === 1);
    assert.deepEqual(f.messages, []);
  });
}

test("a complete message at the 64 MiB limit is accepted", async t => {
  const f = await fixture(t);
  const half = Buffer.alloc(32 << 20, 0x63);
  f.feed(frame(2, half, false));
  f.feed(frame(0, half));
  await until(() => f.messages.length === 1);
  assert.equal(f.messages[0].payload.length, MAX_BYTES);
  assert.equal(f.messages[0].payload[0], 0x63);
  assert.equal(f.messages[0].payload[MAX_BYTES - 1], 0x63);
  assert.throws(() => f.client.sendBinary(Buffer.alloc(MAX_BYTES + 1)), /too large/);
});

for (const fragmented of [false, true]) {
  test(`Upgrade data waits for explicit activation, fragmented=${fragmented}`, async t => {
    const payload = Buffer.from("welcome 中文🙂");
    const initial = fragmented ? Buffer.concat([frame(1, payload.subarray(0, 1), false), frame(0, payload.subarray(1))]) : frame(1, payload);
    const f = await fixture(t, initial, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.messages, []);
    f.feed(frame(1, Buffer.from("following")));
    f.client.startReceiving();
    f.client.startReceiving();
    await until(() => f.messages.length === 2);
    assert.deepEqual(f.messages, [{ type: 1, payload }, { type: 1, payload: Buffer.from("following") }]);
  });
}

for (const method of ["close", "destroy"]) {
  for (const start of [false, true]) {
    test(`${method} discards queued data and stops delivery in the same batch, active=${start}`, async t => {
      const f = await fixture(t, Buffer.concat([frame(1, Buffer.from("first")), frame(1, Buffer.from("late")), frame(9)]), false);
      if (start) {
        f.client.once("message", () => f.client[method]());
        f.client.startReceiving();
      } else f.client[method]();
      f.client.startReceiving();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(f.messages.length, start ? 1 : 0);
      assert.deepEqual(f.closes, []);
      assert.throws(() => f.client.sendBinary(Buffer.alloc(0)), /closed/);
    });
  }
}

test("outgoing Buffer JSON stays text while stream data stays binary and masked", async t => {
  const f = await fixture(t);
  for (const type of [1, 2]) {
    const received = once(f.socket, "data");
    const payload = Buffer.from(type === 1 ? '{"type":"tunnel.open"}' : "stream");
    f.client.sendMessage(type, payload);
    assert.deepEqual(clientFrame((await received)[0]), { opcode: type, masked: true, payload });
  }
});

function tunnelFrame(type, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(id), 1);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

test("multiplexed streams stay separate and a protocol failure closes pending reads once", async t => {
  const f = await fixture(t);
  const session = new TunnelHubYamuxSession(f.client);
  const streams = new Map();
  let closes = 0, errors = 0;
  session.on("stream", stream => streams.set(stream.id, stream));
  session.on("error", () => errors++);
  session.on("close", () => closes++);
  const data = Buffer.concat([tunnelFrame(1, 2), tunnelFrame(1, 4),
    tunnelFrame(2, 2, Buffer.from("upload")), tunnelFrame(2, 4, Buffer.from("desktop"))]);
  f.feed(Buffer.concat([frame(2, data.subarray(0, 19), false), frame(9), frame(0, data.subarray(19))]));
  await until(() => streams.size === 2);
  assert.equal((await streams.get(2).readExactly(6)).toString(), "upload");
  assert.equal((await streams.get(4).readExactly(7)).toString(), "desktop");
  const reads = Promise.allSettled([streams.get(2).readExactly(1), streams.get(4).readExactly(1)]);
  f.feed(frame(0));
  assert.ok((await reads).every(result => result.status === "rejected"));
  assert.equal(errors, 1);
  assert.equal(closes, 1);
});

for (const failure of ["status", "accept", "timeout", "close"]) {
  test(`handshake rejects ${failure}`, async t => {
    let socket;
    const server = http.createServer();
    server.on("upgrade", (_req, peer) => {
      socket = peer;
      if (failure === "status") peer.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      if (failure === "accept") peer.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n");
      if (failure === "close") peer.destroy();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
    await assert.rejects(connectTunnelHubWebSocket(`ws://127.0.0.1:${server.address().port}`, { timeoutMs: 50 }));
  });
}


test("a remote close drops unfinished fragments and following data and emits close once", async t => {
  const f = await fixture(t);
  f.feed(Buffer.concat([frame(2, Buffer.from("partial"), false), frame(8), frame(0, Buffer.from("late"))]));
  f.socket.end();
  await until(() => f.closes.length === 1);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.errors, []);
});

test("malformed Upgrade data reports its error after the consumer can attach", async t => {
  const f = await fixture(t, frame(0));
  await until(() => f.errors.length === 1);
  assert.deepEqual(f.messages, []);
});
