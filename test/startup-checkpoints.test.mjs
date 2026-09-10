import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { beginStartupCheckpoints } = require("../dist-electron/main/support/logging/startup-checkpoints.js");

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
