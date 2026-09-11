import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createBridgePidReader } = require("../dist-electron/main/modules/services/manager/bridge-pid-reader.js");
const { writePidFile } = require("../dist-electron/main/modules/services/manager/pid-files.js");
const childProcess = require("node:child_process");
const commandRunner = require("../dist-electron/main/modules/services/manager/command-runner.js");
const { matchProcessInstallDirAsync } = require("../dist-electron/main/modules/services/manager/process-identity.js");

function fixture() {
  let now = 0, alive = true, identity = { pid: 42, key: "first" }, calls = 0;
  let match = async () => "matched";
  const read = createBridgePidReader({
    readIdentity: async () => identity,
    isRunning: () => alive,
    match: (...args) => { calls++; return match(...args); },
    now: () => now,
  });
  return { read: () => read(["pid-file"], "install"), get calls() { return calls; },
    advance: (ms) => { now += ms; }, setAlive: (value) => { alive = value; },
    setIdentity: (value) => { identity = value; }, setMatch: (value) => { match = value; } };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("cold concurrent requests share asynchronous verification, warm requests do not spawn", async () => {
  const f = fixture(); let complete;
  f.setMatch(() => new Promise((resolve) => { complete = resolve; }));
  const first = f.read(), second = f.read();
  await turn();
  assert.equal(f.calls, 1);
  complete("matched");
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(await f.read(), 42);
  assert.equal(f.calls, 1);
});

test("recent success refreshes without blocking, failure revokes it", async () => {
  const f = fixture(); assert.equal(await f.read(), 42);
  f.advance(1500); let complete;
  f.setMatch(() => new Promise((resolve) => { complete = resolve; }));
  assert.equal(await f.read(), 42);
  assert.equal(await f.read(), 42);
  assert.equal(f.calls, 2);
  complete("mismatched"); await turn();
  assert.equal(await f.read(), null);
});

test("expired observation waits and unknown identity fails closed", async () => {
  const f = fixture(); await f.read(); f.advance(10001);
  let complete, settled = false;
  f.setMatch(() => new Promise((resolve) => { complete = resolve; }));
  const pending = f.read().then((result) => { settled = true; return result; });
  await turn(); assert.equal(settled, false);
  complete("unknown"); assert.equal(await pending, null);
});

test("process exit and removed PID files immediately invalidate recent success", async () => {
  const f = fixture(); await f.read(); f.setAlive(false);
  assert.equal(await f.read(), null);
  f.setAlive(true); assert.equal(await f.read(), 42); assert.equal(f.calls, 2);
  f.setIdentity(null); assert.equal(await f.read(), null);
});

test("late old-process completion cannot replace a newly verified PID", async () => {
  const f = fixture(); let complete;
  f.setMatch(() => new Promise((resolve) => { complete = resolve; }));
  const old = f.read(); await turn();
  f.setIdentity({ pid: 43, key: "new-generation" }); f.setMatch(async () => "matched");
  assert.equal(await f.read(), 43);
  complete("matched"); assert.equal(await old, null);
  assert.equal(await f.read(), 43);
});

test("rewritten PID identity revalidates even when PID number is unchanged", async () => {
  const f = fixture(); await f.read();
  f.setIdentity({ pid: 42, key: "replacement-file" }); f.setMatch(async () => "mismatched");
  assert.equal(await f.read(), null); assert.equal(f.calls, 2);
});

test("query rejection is contained and retried without resurrecting old success", async () => {
  const f = fixture(); f.setMatch(async () => { throw Error("query failed"); });
  assert.equal(await f.read(), null); f.advance(1001); f.setMatch(async () => "matched");
  assert.equal(await f.read(), 42);
});

test("unchanged PID writes preserve file identity, changed PID still persists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-pid-write-"));
  try {
    const filename = path.join(root, "service.pid"); writePidFile(filename, 42);
    fs.utimesSync(filename, new Date(0), new Date(0));
    writePidFile(filename, 42); assert.equal(fs.statSync(filename).mtimeMs, 0);
    writePidFile(filename, 43); assert.equal(fs.readFileSync(filename, "utf8").trim(), "43");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const windows of [true, false]) {
  test(`${windows ? "Windows" : "macOS"} identity probe uses bounded asynchronous execution`, async () => {
    const originalExec = childProcess.execFile, originalPlatform = commandRunner.IS_WINDOWS;
    try {
      commandRunner.IS_WINDOWS = windows;
      let command, args, options;
      childProcess.execFile = (c, a, o, done) => {
        command = c; args = a; options = o;
        setImmediate(() => done(null, windows ? "C:\\services\\platform\\server.exe" : "/opt/services/platform/server"));
      };
      assert.equal(await matchProcessInstallDirAsync(42, windows ? "C:\\services\\platform" : "/opt/services/platform"), "matched");
      if (windows) { assert.match(command, /powershell\.exe$/i); assert.ok(args.includes("-NonInteractive")); assert.equal(options.windowsHide, true); }
      else { assert.equal(command, "ps"); assert.deepEqual(args, ["-p", "42", "-o", "command="]); }
      assert.ok(options.timeout > 0 && options.timeout <= 3000);
      childProcess.execFile = (_c, _a, _o, done) => setImmediate(() => done(Error("timeout"), ""));
      assert.equal(await matchProcessInstallDirAsync(42, "/missing"), "unknown");
    } finally { childProcess.execFile = originalExec; commandRunner.IS_WINDOWS = originalPlatform; }
  });
}
