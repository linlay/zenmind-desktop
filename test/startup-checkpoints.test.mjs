import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { beginStartupCheckpoints, runStartupCheckpoint } = require("../dist-electron/main/support/logging/startup-checkpoints.js");

test("checkpoint wrapper preserves results and errors without logging credentials", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only diagnostics");
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const result = { token: "secret-token" };
  assert.equal(await runStartupCheckpoint("identity-center", "capability", "issue", () => result), result);
  const failure = new Error("secret-command-output");
  await assert.rejects(runStartupCheckpoint("identity-center", "capability", "issue", async () => { throw failure; }),
    (error) => error === failure);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /status=succeeded/);
  assert.match(lines[3], /status=failed/);
  assert.ok(lines.every((line) => !line.includes("secret")));
  t.mock.timers.tick(10_000);
  assert.equal(lines.length, 4);
});

test("macOS bypasses the additional diagnostics and preserves the operation", async (t) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  const timer = t.mock.method(globalThis, "setInterval", () => { throw new Error("unexpected diagnostic timer"); });
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    const result = {};
    assert.equal(await runStartupCheckpoint("identity-center", "capability", "issue", () => result), result);
    const failure = new Error("original failure");
    await assert.rejects(runStartupCheckpoint("identity-center", "capability", "issue", () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(lines, []);
    assert.equal(timer.mock.callCount(), 0);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("slow checkpoints report waiting, finish the previous stage, and stop timers on failure", (t) => {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const checkpoints = beginStartupCheckpoints("agent-platform", "initialize");
  checkpoints.next("execute-deploy");
  assert.match(lines[0], /stage=execute-deploy status=started elapsedMs=\d+/);
  t.mock.timers.tick(5_000);
  assert.match(lines[1], /stage=execute-deploy status=waiting/);
  checkpoints.next("read-final-state");
  assert.match(lines[2], /stage=execute-deploy status=succeeded/);
  assert.match(lines[3], /stage=read-final-state status=started/);
  checkpoints.end("failed");
  assert.match(lines[4], /stage=read-final-state status=failed/);
  checkpoints.end("failed");
  t.mock.timers.tick(15_000);
  assert.equal(lines.length, 5);
});

test("concurrent services have independent operation IDs and cleanup", (t) => {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const first = beginStartupCheckpoints("identity-center", "initialize");
  const second = beginStartupCheckpoints("agent-webclient", "initialize");
  first.next("read-initial-state");
  second.next("read-initial-state");
  assert.notEqual(lines[0].match(/id=\d+/)[0], lines[1].match(/id=\d+/)[0]);
  first.end("skipped");
  t.mock.timers.tick(5_000);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /serviceId=agent-webclient .*status=waiting/);
  second.end();
  t.mock.timers.tick(10_000);
  assert.equal(lines.length, 5);
});
