import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TunnelHubWebSocketClient, connectTunnelHubWebSocket } = require("../dist-electron/main/modules/tunnel/websocket-client.js");
const { TunnelHubYamuxSession } = require("../dist-electron/main/modules/tunnel/yamux.js");
const MAX_BYTES = 64 << 20;

class FakeSocket extends EventEmitter {
  writes = [];
  ended = false;
  destroyed = false;
  resumes = 0;
  pause() { return this; }
  resume() { this.resumes += 1; return this; }
  write(data) { this.writes.push(data); return true; }
  end(data) { if (data) this.writes.push(data); this.ended = true; return this; }
  destroy() { this.destroyed = true; return this; }
}

function frame(opcode, payload = Buffer.alloc(0), fin = true, length = payload.byteLength) {
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
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode: wire[0] & 0xf, masked: Boolean(wire[1] & 0x80), payload };
}

function fixture(initialData = Buffer.alloc(0), start = true) {
  const socket = new FakeSocket();
  const client = new TunnelHubWebSocketClient(socket, initialData);
  const messages = [];
  const errors = [];
  const closes = [];
  client.on("message", message => messages.push(message));
  client.on("error", error => errors.push(error));
  client.on("close", () => closes.push(socket.ended || socket.destroyed));
  if (start) client.startReceiving();
  return { client, socket, messages, errors, closes, feed: data => socket.emit("data", data) };
}

for (const type of [0x1, 0x2]) {
  for (const size of [0, 125, 126, 20666, 37679, 65535, 65536]) {
    test(`type=${type} size=${size}: fragmented and complete messages survive TCP cuts`, () => {
      const f = fixture();
      const payload = Buffer.alloc(size, 0x61);
      const split = Math.floor(size / 2);
      const wire = Buffer.concat([
        frame(type, payload.subarray(0, split), false),
        frame(0, Buffer.alloc(0), false),
        frame(0, payload.subarray(split)),
        frame(type, payload)
      ]);
      for (let offset = 0; offset < wire.length;) {
        const length = offset < 10 ? 1 : 4093;
        f.feed(wire.subarray(offset, offset + length));
        offset += length;
      }
      assert.deepEqual(f.errors, []);
      assert.equal(f.messages.length, 2);
      for (const message of f.messages) {
        assert.equal(message.type, type);
        assert.deepEqual(message.payload, payload);
      }
    });
  }
}

test("UTF-8 stays intact and Ping is answered before the final continuation", () => {
  const f = fixture();
  const payload = Buffer.from("中文🙂分片");
  f.feed(frame(1, payload.subarray(0, 1), false));
  f.feed(frame(9, Buffer.from("heartbeat")));
  f.feed(frame(0xA, Buffer.from("pong")));
  assert.equal(f.messages.length, 0);
  assert.equal(f.socket.writes.length, 1);
  assert.deepEqual(clientFrame(f.socket.writes[0]), {
    opcode: 0xA, masked: true, payload: Buffer.from("heartbeat")
  });
  f.feed(frame(0, payload.subarray(1)));
  assert.equal(f.messages[0].payload.toString(), payload.toString());
});

test("Hub-style large binary fragment and empty final continuation form one message", () => {
  const f = fixture();
  const payload = Buffer.alloc(20666, 0x62);
  f.feed(frame(2, payload, false));
  assert.equal(f.messages.length, 0);
  f.feed(frame(0));
  assert.deepEqual(f.messages, [{ type: 2, payload }]);
});

test("empty continuations do not change the message and the next message is independent", () => {
  const f = fixture();
  f.feed(frame(2, Buffer.alloc(0), false));
  for (let i = 0; i < 10000; i += 1) f.feed(frame(0, Buffer.alloc(0), false));
  f.feed(frame(0, Buffer.from([1, 2, 3])));
  f.feed(frame(1, Buffer.from("next")));
  assert.deepEqual(f.messages, [{ type: 2, payload: Buffer.from([1, 2, 3]) }, { type: 1, payload: Buffer.from("next") }]);
});

for (const [name, frames, error] of [
  ["orphan continuation", [frame(0)], /continuation/],
  ["interleaved data message", [frame(2, Buffer.alloc(0), false), frame(1)], /interleaved/],
  ["fragmented Ping", [frame(9, Buffer.alloc(0), false)], /control/],
  ["fragmented Pong", [frame(0xA, Buffer.alloc(0), false)], /control/],
  ["fragmented Close", [frame(8, Buffer.alloc(0), false)], /control/],
  ["oversize control", [frame(9, Buffer.alloc(0), true, 126)], /control/],
  ["reserved opcode", [frame(3)], /opcode/],
  ["oversize frame header", [frame(2, Buffer.alloc(0), true, MAX_BYTES + 1)], /too large/]
]) {
  test(`${name} fails without delivering partial data`, () => {
    const f = fixture();
    for (const data of frames) f.feed(data);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, error);
    assert.equal(f.socket.ended, true);
    assert.equal(clientFrame(f.socket.writes[0]).payload.readUInt16BE(), 1002);
    f.feed(frame(1, Buffer.from("late")));
    assert.deepEqual(f.messages, []);
    assert.equal(f.errors.length, 1);
  });
}

test("aggregate size is rejected from the next header before its body arrives", () => {
  const f = fixture();
  f.feed(frame(2, Buffer.alloc(32 << 20), false));
  f.feed(frame(0, Buffer.alloc(0), true, 33 << 20));
  assert.match(f.errors[0].message, /message too large/);
  assert.equal(f.socket.ended, true);
  assert.deepEqual(f.messages, []);
});

test("a complete message at the 64 MiB limit is accepted", () => {
  const f = fixture();
  const half = Buffer.alloc(32 << 20, 0x63);
  f.feed(frame(2, half, false));
  f.feed(frame(0, half));
  assert.deepEqual(f.errors, []);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].payload.length, MAX_BYTES);
  assert.equal(f.messages[0].payload[0], 0x63);
  assert.equal(f.messages[0].payload[MAX_BYTES - 1], 0x63);
});

test("initial bytes wait for explicit activation and are consumed once", () => {
  const f = fixture(frame(1, Buffer.from("initial")), false);
  f.feed(frame(1, Buffer.from("following")));
  assert.deepEqual(f.messages, []);
  f.client.startReceiving();
  f.client.startReceiving();
  assert.deepEqual(f.messages.map(message => message.payload.toString()), ["initial", "following"]);
  assert.equal(f.socket.resumes, 1);
});

for (const method of ["close", "destroy"]) {
  test(`${method} before activation discards initial bytes without resuming`, () => {
    const f = fixture(frame(1, Buffer.from("queued")), false);
    f.client[method]();
    f.client.startReceiving();
    f.feed(frame(1, Buffer.from("late")));
    assert.deepEqual(f.messages, []);
    assert.equal(f.socket.resumes, 0);
    assert.deepEqual(f.closes, []);
  });
}

for (const method of ["close", "destroy"]) {
  test(`${method} keeps active-close semantics and stops messages in the same batch`, () => {
    const f = fixture();
    f.client.once("message", () => f.client[method]());
    f.feed(Buffer.concat([frame(1, Buffer.from("first")), frame(1, Buffer.from("late")), frame(9)]));
    f.socket.emit("end");
    f.socket.emit("close");
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.closes, []);
    assert.throws(() => f.client.sendBinary(Buffer.alloc(0)), /closed/);
  });
}

test("remote Close drops pending fragments and any data following it", () => {
  const f = fixture();
  f.feed(frame(2, Buffer.from("partial"), false));
  f.feed(Buffer.concat([frame(8), frame(0, Buffer.from("late"))]));
  f.socket.emit("end");
  f.socket.emit("close");
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.closes, [true]);
});

test("Socket errors and closure do not deliver an unfinished message", () => {
  const f = fixture();
  f.feed(frame(1, Buffer.from("partial"), false));
  const error = new Error("connection reset");
  f.socket.emit("error", error);
  f.socket.emit("end");
  f.socket.emit("close");
  f.feed(frame(0));
  assert.deepEqual(f.errors, [error]);
  assert.deepEqual(f.closes, [false]);
  assert.deepEqual(f.messages, []);
});

function tunnelFrame(type, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(id), 1);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

test("multiplexed streams stay separate and one failure closes all pending reads once", async () => {
  const f = fixture();
  const session = new TunnelHubYamuxSession(f.client);
  const streams = new Map();
  let closes = 0;
  let errors = 0;
  session.on("stream", stream => streams.set(stream.id, stream));
  session.on("error", () => { errors += 1; });
  session.on("close", () => { closes += 1; });
  const data = Buffer.concat([
    tunnelFrame(1, 2), tunnelFrame(1, 4),
    tunnelFrame(2, 2, Buffer.from("upload")), tunnelFrame(2, 4, Buffer.from("desktop"))
  ]);
  f.feed(frame(2, data.subarray(0, 19), false));
  f.feed(frame(9));
  f.feed(frame(0, data.subarray(19)));
  assert.equal((await streams.get(2).readExactly(6)).toString(), "upload");
  assert.equal((await streams.get(4).readExactly(7)).toString(), "desktop");
  const reads = Promise.allSettled([streams.get(2).readExactly(1), streams.get(4).readExactly(1)]);
  f.feed(frame(0));
  f.socket.emit("close");
  assert.ok((await reads).every(result => result.status === "rejected"));
  assert.equal(errors, 1);
  assert.equal(closes, 1);
});

for (const fragmented of [false, true]) {
  test(`Upgrade with initial message, fragmented=${fragmented}`, async t => {
    const sockets = new Set();
    const payload = Buffer.from("welcome 中文🙂");
    const initialData = fragmented
      ? Buffer.concat([frame(1, payload.subarray(0, 1), false), frame(0, payload.subarray(1))])
      : frame(1, payload);
    const server = http.createServer();
    server.on("upgrade", (request, socket) => {
      sockets.add(socket);
      const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(Buffer.concat([
        Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
        initialData
      ]));
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = await connectTunnelHubWebSocket(`ws://127.0.0.1:${server.address().port}`);
    t.after(() => client.destroy());
    const messages = [];
    client.on("message", message => messages.push(message));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(messages, []);
    const received = new Promise(resolve => client.once("message", resolve));
    client.startReceiving();
    await received;
    assert.deepEqual(messages, [{ type: 1, payload }]);
  });
}

for (const failure of ["status", "accept", "timeout", "error", "close"]) {
  test(`failed handshake cleans its listeners and timer: ${failure}`, async t => {
    const socket = new FakeSocket();
    t.mock.method(net, "connect", () => socket);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const connection = connectTunnelHubWebSocket("ws://127.0.0.1:1", { timeoutMs: 100 });
    const rejected = assert.rejects(connection);
    socket.emit("connect");
    if (failure === "status") socket.emit("data", Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n"));
    if (failure === "accept") socket.emit("data", Buffer.from("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: invalid\r\n\r\n"));
    if (failure === "timeout") t.mock.timers.tick(100);
    if (failure === "error") socket.emit("error", new Error("connection reset"));
    if (failure === "close") socket.emit("close");
    await rejected;
    assert.equal(socket.destroyed, true);
    for (const event of ["connect", "data", "error", "close"]) assert.equal(socket.listenerCount(event), 0);
    t.mock.timers.tick(1000);
  });
}
