import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  terminateProcessList,
  terminateProcessTree
} = require("../dist-electron/main/services/manager/process-cleanup.js");

test("terminateProcessList treats empty process lists as cleaned up", () => {
  assert.equal(terminateProcessList([]), true);
});

test("terminateProcessTree treats already-exited pids as cleaned up", () => {
  assert.equal(terminateProcessTree(99999999), true);
});

test("terminateProcessTree uses taskkill tree mode on Windows", () => {
  const calls = [];

  const terminated = terminateProcessTree(4321, {
    platform: "win32",
    isProcessRunningImpl: (pid) => pid === 4321,
    spawnSyncImpl: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    }
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [["taskkill.exe", ["/PID", "4321", "/T", "/F"]]]);
});

test("terminateProcessTree falls back to computed process tree when taskkill fails", () => {
  const terminatedLists = [];

  const terminated = terminateProcessTree(4321, {
    platform: "win32",
    isProcessRunningImpl: (pid) => pid === 4321,
    spawnSyncImpl: () => ({ status: 1 }),
    listProcessTreePidsImpl: () => [4322, 4321],
    terminateProcessListImpl: (pids) => {
      terminatedLists.push(pids);
      return true;
    }
  });

  assert.equal(terminated, true);
  assert.deepEqual(terminatedLists, [[4322, 4321]]);
});
