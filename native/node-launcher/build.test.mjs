import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNodeLauncherArch, verifyNodeLauncherPE, buildNodeLauncher } from "../../scripts/build-node-launcher.mjs";

function pe(machine, subsystem = 2) {
  const data = Buffer.alloc(256); data.writeUInt16LE(0x5a4d, 0); data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80); data.writeUInt16LE(machine, 0x84); data.writeUInt16LE(0x20b, 0x98); data.writeUInt16LE(subsystem, 0xdc);
  return data;
}
test("Windows architecture aliases and native PE validation", () => {
  assert.equal(normalizeNodeLauncherArch("x64"), "amd64");
  assert.equal(verifyNodeLauncherPE(pe(0x8664), "amd64"), true);
  assert.equal(verifyNodeLauncherPE(pe(0xaa64), "arm64"), true);
  assert.throws(() => verifyNodeLauncherPE(pe(0x8664), "arm64"), /architecture/);
  assert.throws(() => verifyNodeLauncherPE(pe(0x8664, 3), "x64"), /GUI/);
  assert.throws(() => verifyNodeLauncherPE(Buffer.from("not executable"), "x64"), /PE/);
  assert.throws(() => normalizeNodeLauncherArch("ia32"), /Unsupported/);
});
test("non-Windows build is an explicit no-op without probing files or Go", async () => {
  assert.equal(await buildNodeLauncher("/does/not/exist", { os: "darwin", arch: "arm64" }), null);
});
