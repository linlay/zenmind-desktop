import test from "node:test";
import assert from "node:assert/strict";

const { registerShellIpcHandlers } = await import("../dist-electron/main/modules/shell/ipc.js");

test("clipboard.writePng accepts a bounded PNG and rejects invalid image data", async () => {
  const handlers = new Map();
  const written = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 272, height: 272 }) };
  registerShellIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => undefined,
  }, {
    clipboard: { writeImage: (value) => written.push(value) },
    nativeImage: { createFromBuffer: () => image },
  });

  const writePng = handlers.get("clipboard.writePng");
  const pngBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24)]);
  pngBytes.writeUInt32BE(272, 16);
  pngBytes.writeUInt32BE(272, 20);
  const png = pngBytes.toString("base64");
  assert.deepEqual(await writePng({}, png), { ok: true });
  assert.deepEqual(written, [image]);
  assert.equal((await writePng({}, Buffer.from("not a png").toString("base64"))).ok, false);
  const oversizedPng = Buffer.from(pngBytes);
  oversizedPng.writeUInt32BE(2048, 16);
  assert.equal((await writePng({}, oversizedPng.toString("base64"))).ok, false);
  assert.equal((await writePng({}, "A".repeat(2 * 1024 * 1024 + 1))).ok, false);
  assert.deepEqual(written, [image]);
});
