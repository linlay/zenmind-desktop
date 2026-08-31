import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createDevShutdownCoordinator,
  terminateTrackedDevProcess
} from "../scripts/platform/dev-process-cleanup.mjs";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("Windows dev cleanup terminates the complete tracked process tree", async () => {
  const child = new FakeChild(4321);
  const calls = [];
  const result = await terminateTrackedDevProcess({ name: "vite", child }, {
    platform: "win32",
    taskkillTimeoutMs: 50,
    childExitTimeoutMs: 50,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const killer = new FakeChild(9001);
      queueMicrotask(() => {
        child.exit(1);
        killer.exit(0);
      });
      return killer;
    }
  });

  assert.deepEqual(calls, [{
    command: "taskkill.exe",
    args: ["/PID", "4321", "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true }
  }]);
  assert.deepEqual(result, { ok: true, name: "vite", pid: 4321 });
  assert.deepEqual(child.killSignals, []);
});

test("Windows dev cleanup skips children that have already exited", async () => {
  const child = new FakeChild(4322);
  child.exitCode = 0;
  let spawnCalls = 0;

  const result = await terminateTrackedDevProcess({ name: "electron", child }, {
    platform: "win32",
    spawnImpl: () => {
      spawnCalls += 1;
      throw new Error("must not run");
    }
  });

  assert.equal(spawnCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    name: "electron",
    pid: 4322,
    skipped: true
  });
});

test("Windows dev cleanup accepts taskkill process-not-found races", async () => {
  const child = new FakeChild(4323);
  const result = await terminateTrackedDevProcess({ name: "vite", child }, {
    platform: "win32",
    taskkillTimeoutMs: 50,
    childExitTimeoutMs: 50,
    spawnImpl: () => {
      const killer = new FakeChild(9002);
      queueMicrotask(() => {
        child.exit(0);
        killer.exit(128);
      });
      return killer;
    }
  });

  assert.equal(result.ok, true);
});

test("Windows dev cleanup reports real taskkill failures without hanging", async () => {
  const child = new FakeChild(4324);
  const startedAt = Date.now();
  const result = await terminateTrackedDevProcess({ name: "vite", child }, {
    platform: "win32",
    taskkillTimeoutMs: 10,
    childExitTimeoutMs: 10,
    spawnImpl: () => {
      const killer = new FakeChild(9003);
      queueMicrotask(() => killer.emit("error", new Error("access denied")));
      return killer;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, "access denied");
  assert.ok(Date.now() - startedAt < 500, "cleanup failure should remain bounded");
});

test("Windows dev cleanup stops waiting when taskkill itself hangs", async () => {
  const child = new FakeChild(4325);
  const killer = new FakeChild(9004);
  const result = await terminateTrackedDevProcess({ name: "vite", child }, {
    platform: "win32",
    taskkillTimeoutMs: 10,
    childExitTimeoutMs: 10,
    spawnImpl: () => killer
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, "taskkill timed out after 10ms");
  assert.deepEqual(killer.killSignals, [undefined]);
});

test("non-Windows dev cleanup preserves direct SIGTERM behavior", async () => {
  for (const platform of ["darwin", "linux"]) {
    const child = new FakeChild(platform === "darwin" ? 5001 : 5002);
    let spawnCalls = 0;
    const result = await terminateTrackedDevProcess({ name: "vite", child }, {
      platform,
      spawnImpl: () => {
        spawnCalls += 1;
      }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(spawnCalls, 0);
  }
});

test("dev shutdown is single-flight and exits only after cleanup completes", async () => {
  const child = new FakeChild(6001);
  let finishCleanup;
  const cleanupPromise = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const exits = [];
  let terminateCalls = 0;
  const shutdown = createDevShutdownCoordinator({
    records: [{ name: "vite", child }],
    platform: "win32",
    exitImpl: (code) => exits.push(code),
    terminateImpl: async () => {
      terminateCalls += 1;
      return cleanupPromise;
    }
  });

  const first = shutdown(0);
  const second = shutdown(1);
  assert.strictEqual(first, second);
  assert.equal(terminateCalls, 1);
  assert.deepEqual(exits, []);

  finishCleanup({ ok: true, name: "vite", pid: child.pid });
  assert.equal(await first, 1);
  assert.deepEqual(exits, [1]);
});

test("dev shutdown logs cleanup failures and exits non-zero", async () => {
  const errors = [];
  const exits = [];
  const shutdown = createDevShutdownCoordinator({
    records: [{ name: "vite", child: new FakeChild(6002) }],
    platform: "win32",
    exitImpl: (code) => exits.push(code),
    logger: { error: (message) => errors.push(message) },
    terminateImpl: async () => ({
      ok: false,
      name: "vite",
      pid: 6002,
      message: "taskkill timed out"
    })
  });

  assert.equal(await shutdown(0), 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors, [
    "[dev] failed to stop vite process tree pid=6002: taskkill timed out"
  ]);
});
