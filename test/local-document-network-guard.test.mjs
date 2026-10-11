import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

// Exercise current source with native CDP ACKs under test control. Nothing is
// written to dist-electron, and no HTML, network transport or Electron app runs.
const built = await build({
  entryPoints: [fileURLToPath(new URL("../src/main/modules/work-panel/local-document-network-guard.ts", import.meta.url))],
  bundle: true, minify: true, platform: "node", format: "cjs", target: "node22", write: false,
  external: ["electron"],
});
const loadGuard = new Function("module", "exports", "require", "setTimeout", "clearTimeout", built.outputFiles[0].text);
const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(t, { sendCommand, attached = false, destroyed = false, attachError } = {}) {
  const calls = [], closeRequests = [], timers = new Map();
  const debug = new EventEmitter();
  debug.attached = attached;
  debug.attachCalls = [];
  debug.detachCalls = 0;
  debug.isAttached = () => debug.attached;
  debug.attach = version => {
    debug.attachCalls.push(version);
    if (attachError) throw attachError;
    debug.attached = true;
  };
  debug.detach = () => { debug.detachCalls += 1; debug.attached = false; debug.emit("detach", {}, "detached"); };
  debug.sendCommand = async (method, params, sessionId) => {
    const call = { method, params, sessionId };
    calls.push(call);
    return sendCommand ? await sendCommand(call) : {};
  };
  const contents = new EventEmitter();
  contents.debugger = debug;
  contents.destroyed = destroyed;
  contents.isDestroyed = () => contents.destroyed;
  // close is a native shutdown request, not synchronous destruction.
  contents.close = options => closeRequests.push(options);
  const module = { exports: {} };
  loadGuard(module, module.exports, require,
    (callback, delay) => { const id = Symbol("timer"); timers.set(id, { callback, delay }); return id; },
    id => timers.delete(id));
  const guard = module.exports.createLocalDocumentNetworkGuard(contents);
  t.after(() => guard.dispose());
  return {
    guard, contents, debug, calls, closeRequests, timers,
    source: module.exports.LOCAL_DOCUMENT_NETWORK_GUARD_SOURCE,
    child: (sessionId, type) => debug.emit("message", {}, "Target.attachedToTarget", { sessionId, targetInfo: { type } }),
    dropChild: sessionId => debug.emit("message", {}, "Target.detachedFromTarget", { sessionId }),
    loseDebugger: () => { debug.attached = false; debug.emit("detach", {}, "replaced"); },
    destroy: () => { contents.destroyed = true; contents.emit("destroyed"); },
  };
}

const methods = (f, sessionId) => f.calls.filter(call => call.sessionId === sessionId).map(call => call.method);
function assertClosed(f) {
  assert.ok(f.closeRequests.length > 0, "native shutdown must be requested");
  assert.ok(f.closeRequests.every(options => options.waitForBeforeUnload === false), "document code cannot postpone shutdown");
}

test("minified guard source is self-contained, idempotent and locks transports in a fresh realm", async t => {
  const f = fixture(t);
  await f.guard.ready;
  const realm = createContext({});
  const names = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCDtlsTransport", "RTCSctpTransport", "WebTransport"];
  // Harmless stand-ins are never invoked: only property descriptors are tested.
  for (const name of names) realm[name] = function transportStandIn() {};
  const script = new Script(f.source, { filename: "local-document-network-guard.minified.js" });
  assert.equal(script.runInContext(realm), undefined, "serialization must not rely on a bundler closure");
  assert.equal(script.runInContext(realm), undefined, "preload and debugger may protect the same realm");
  for (const name of names) {
    const quoted = JSON.stringify(name);
    const descriptor = new Script(`Object.getOwnPropertyDescriptor(globalThis, ${quoted})`).runInContext(realm);
    assert.equal(descriptor.value, undefined);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(new Script(`Reflect.set(globalThis, ${quoted}, function replacement() {})`).runInContext(realm), false);
    assert.equal(new Script(`Reflect.deleteProperty(globalThis, ${quoted})`).runInContext(realm), false);
    assert.throws(() => new Script(`Object.defineProperty(globalThis, ${quoted}, {value: function replacement() {}})`).runInContext(realm),
      error => error.name === "TypeError");
  }
  assert.equal(new Script("typeof process + '/' + typeof require").runInContext(realm), "undefined/undefined");
});

test("root is not ready until new-document protection and paused target discovery are acknowledged", async t => {
  const script = deferred(), targets = deferred();
  const f = fixture(t, { sendCommand: call => {
    if (call.method === "Page.addScriptToEvaluateOnNewDocument") return script.promise;
    if (call.method === "Target.setAutoAttach") return targets.promise;
    return {};
  } });
  let ready = false;
  void f.guard.ready.then(() => { ready = true; }, () => {});
  await tick();
  assert.equal(ready, false);
  assert.deepEqual(methods(f), ["Page.enable", "Page.addScriptToEvaluateOnNewDocument"]);
  const registration = f.calls.at(-1);
  assert.equal(registration.params.source, f.source);
  assert.equal(registration.params.runImmediately, true);
  script.resolve({ identifier: "guard-script" });
  await tick();
  assert.equal(ready, false);
  assert.equal(f.calls.at(-1).method, "Target.setAutoAttach");
  assert.equal(f.calls.at(-1).params.waitForDebuggerOnStart, true);
  targets.resolve({});
  await f.guard.ready;
  assert.equal(ready, true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.closeRequests, []);
});

test("a stalled root setup reaches its deadline, rejects readiness and closes the guest", async t => {
  const enabled = deferred();
  const f = fixture(t, { sendCommand: () => enabled.promise });
  const [timer] = [...f.timers.values()];
  assert.equal(timer.delay, 5000);
  timer.callback();
  await assert.rejects(f.guard.ready, /network protection is unavailable/u);
  assertClosed(f);
  assert.equal(f.timers.size, 0);
  f.guard.dispose();
  enabled.resolve({});
  await tick();
  assert.deepEqual(methods(f), ["Page.enable"], "late setup ACK cannot continue after disposal");
});

for (const scenario of ["attach fails", "another debugger is attached", "guest is already destroyed"]) {
  test(`${scenario} rejects readiness without claiming the foreign debugger`, async t => {
    const f = fixture(t, {
      attachError: scenario === "attach fails" ? new Error("native attach refused") : undefined,
      attached: scenario === "another debugger is attached",
      destroyed: scenario === "guest is already destroyed",
    });
    await assert.rejects(f.guard.ready);
    assert.deepEqual(f.calls, []);
    assert.equal(f.debug.detachCalls, 0);
    assert.equal(f.debug.attachCalls.length, scenario === "attach fails" ? 1 : 0);
    if (scenario === "guest is already destroyed") assert.deepEqual(f.closeRequests, []);
    else assertClosed(f);
  });
}

for (const rejected of ["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach"]) {
  test(`root ${rejected} failure closes without declaring readiness`, async t => {
    const f = fixture(t, { sendCommand: call => {
      if (call.method === rejected) throw new Error("native command refused");
      return {};
    } });
    await assert.rejects(f.guard.ready, /native command refused/u);
    assertClosed(f);
    assert.equal(f.calls.at(-1).method, rejected);
  });
}

for (const event of ["detach", "preload-error"]) {
  for (const phase of ["initializing", "ready"]) {
    test(`${event} closes the guest while ${phase}`, async t => {
      const pending = deferred();
      const f = fixture(t, { sendCommand: call => phase === "initializing" && call.method === "Page.enable" ? pending.promise : {} });
      if (phase === "ready") await f.guard.ready;
      if (event === "detach") f.loseDebugger();
      else f.contents.emit("preload-error", {}, "/fixed/local-document-network.js", new Error("preload failed"));
      if (phase === "initializing") await assert.rejects(f.guard.ready);
      await tick();
      assertClosed(f);
      assert.equal(f.debug.detachCalls, 0, "failure never detaches a live guest as a fallback");
      f.guard.dispose();
      pending.resolve({});
      await tick();
    });
  }
}

for (const type of ["worker", "shared_worker", "service_worker", "iframe"]) {
  test(`${type} resumes only after its protection and nested auto-attach ACKs`, async t => {
    const protection = deferred(), descendants = deferred();
    const id = `child-${type}`;
    const protectionMethod = type === "iframe" ? "Page.addScriptToEvaluateOnNewDocument" : "Runtime.evaluate";
    const f = fixture(t, { sendCommand: call => {
      if (call.sessionId === id && call.method === protectionMethod) return protection.promise;
      if (call.sessionId === id && call.method === "Target.setAutoAttach") return descendants.promise;
      return {};
    } });
    await f.guard.ready;
    f.child(id, type);
    await tick();
    assert.deepEqual(methods(f, id), [type === "iframe" ? "Page.enable" : "Runtime.enable", protectionMethod]);
    const installed = f.calls.find(call => call.sessionId === id && call.method === protectionMethod);
    assert.equal(installed.params[type === "iframe" ? "source" : "expression"], f.source);
    protection.resolve(type === "iframe" ? { identifier: "child-guard" } : { result: { type: "undefined" } });
    await tick();
    assert.equal(methods(f, id).at(-1), "Target.setAutoAttach");
    assert.equal(methods(f, id).includes("Runtime.runIfWaitingForDebugger"), false);
    descendants.resolve({});
    await tick();
    assert.equal(methods(f, id).at(-1), "Runtime.runIfWaitingForDebugger");
    assert.deepEqual(f.closeRequests, []);
  });
}

for (const failure of ["script exception", "native command failure"]) {
  test(`worker ${failure} closes the guest without resuming unprotected code`, async t => {
    const f = fixture(t, { sendCommand: call => {
      if (call.sessionId === "failed-worker" && call.method === "Runtime.evaluate") {
        if (failure === "script exception") return { exceptionDetails: { text: "policy failed" } };
        throw new Error("native worker command refused");
      }
      return {};
    } });
    await f.guard.ready;
    f.child("failed-worker", "worker");
    await tick();
    assertClosed(f);
    assert.deepEqual(methods(f, "failed-worker"), ["Runtime.enable", "Runtime.evaluate"]);
  });
}

test("a child removed during protection is never resumed and does not close the surviving document", async t => {
  const protection = deferred();
  const f = fixture(t, { sendCommand: call => call.sessionId === "removed-worker" && call.method === "Runtime.evaluate" ? protection.promise : {} });
  await f.guard.ready;
  f.child("removed-worker", "worker");
  await tick();
  f.dropChild("removed-worker");
  protection.reject(new Error("Session not found"));
  await tick();
  assert.deepEqual(methods(f, "removed-worker"), ["Runtime.enable", "Runtime.evaluate"]);
  assert.deepEqual(f.closeRequests, []);
});

test("dispose retains native protection, removes observers and never resumes an in-flight child", async t => {
  const protection = deferred();
  const f = fixture(t, { sendCommand: call => call.sessionId === "pending-worker" && call.method === "Runtime.evaluate" ? protection.promise : {} });
  await f.guard.ready;
  f.child("pending-worker", "worker");
  await tick();
  f.guard.dispose();
  f.guard.dispose();
  assert.equal(f.debug.isAttached(), true, "native new-document registrations stay effective until destruction");
  assert.equal(f.debug.detachCalls, 0);
  assert.equal(f.debug.listenerCount("message"), 0);
  assert.equal(f.debug.listenerCount("detach"), 0);
  assert.equal(f.contents.listenerCount("preload-error"), 0);
  assert.equal(f.contents.listenerCount("destroyed"), 0);
  assert.equal(f.timers.size, 0);
  const before = f.calls.length;
  protection.resolve({ result: { type: "undefined" } });
  f.child("late-worker", "worker");
  f.contents.emit("preload-error", {}, "ignored", new Error("late error"));
  await tick();
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.closeRequests, []);
});

test("destroying the guest rejects pending setup and ignores its late ACK", async t => {
  const enabled = deferred();
  const f = fixture(t, { sendCommand: () => enabled.promise });
  f.destroy();
  await assert.rejects(f.guard.ready);
  enabled.resolve({});
  await tick();
  assert.deepEqual(methods(f), ["Page.enable"]);
  assert.deepEqual(f.closeRequests, []);
  assert.equal(f.debug.detachCalls, 0);
  assert.equal(f.debug.listenerCount("message"), 0);
  assert.equal(f.contents.listenerCount("preload-error"), 0);
  assert.equal(f.timers.size, 0);
});
