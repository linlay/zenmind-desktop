import test from "node:test";
import assert from "node:assert/strict";
const { createShareReceiverRouter } = await import("../dist-electron/main/modules/shares/receiver.js");
const description = (id = "one", version = 1) => ({ protocolVersion: 1, id, kind: "independent-business", title: "Frozen", actions: ["preview", "desktop"], desktop: { receiverId: "test.receiver", contextVersion: version, context: { id: "frozen-context", version: "1.2.3" } } });
const registration = activate => ({ receiverId: "test.receiver", owner: { type: "builtin", id: "test-business" }, contextVersions: [1], activate });
const endpoint = receive => ({ generation: "first", isCurrent: () => true, receive });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("exact registry dispatches a non-market receiver with server context and a fresh intent", async () => {
  const requests = []; let reads = 0;
  const router = createShareReceiverRouter({ resolve: async id => { reads++; return description(id); } });
  const dispose = router.register(registration(async () => endpoint(async input => { requests.push(input); return { status: "received" }; })));
  assert.equal((await router.receive("one")).status, "received");
  assert.equal((await router.receive("one")).status, "received");
  assert.equal(reads, 4); assert.notEqual(requests[0].intentId, requests[1].intentId);
  assert.deepEqual(requests[0].context, description().desktop.context);
  assert.equal(requests[0].receiverId, "test.receiver"); assert.equal(requests[0].shareId, "one");
  dispose(); assert.equal((await router.receive("one")).status, "unsupported"); router.dispose();
});

test("bad registrations, conflicts, missing receivers and unsupported versions stay local", async () => {
  let activations = 0;
  const router = createShareReceiverRouter({ resolve: async () => description("one", 2) });
  for (const changed of [{ receiverId: "test.receiver\n" }, { receiverId: "bad/id" }, { contextVersions: [] }, { contextVersions: [1, 1] }, { contextVersions: [0] }, { owner: { type: "page", id: "self-reported" } }]) {
    assert.throws(() => router.register({ ...registration(async () => {}), ...changed }), /registration/);
  }
  assert.equal((await router.receive("one")).status, "unsupported");
  router.register(registration(async () => { activations++; return endpoint(async () => ({ status: "received" })); }));
  assert.throws(() => router.register(registration(async () => {})), /duplicate/);
  assert.equal((await router.receive("one")).status, "unsupported"); assert.equal(activations, 0); router.dispose();
});

for (const scenario of ["revoked", "changed-context", "closed", "generation", "throw", "invalid-result"]) test(`handoff isolates ${scenario}`, async () => {
  let reads = 0, deliveries = 0; const live = endpoint(async () => {
    deliveries++; if (scenario === "throw") throw new Error("receiver failed");
    return { status: scenario === "invalid-result" ? "install-everything" : "received" };
  });
  const router = createShareReceiverRouter({ resolve: async () => {
    reads++;
    if (reads === 2) {
      if (scenario === "revoked") throw new Error("404");
      if (scenario === "changed-context") return { ...description(), desktop: { ...description().desktop, context: { changed: true } } };
      if (scenario === "closed") live.isCurrent = () => false;
      if (scenario === "generation") live.generation = "new-instance";
    }
    return description();
  } });
  router.register(registration(async () => live));
  assert.equal((await router.receive("one")).status, "unavailable");
  assert.equal(deliveries, ["throw", "invalid-result"].includes(scenario) ? 1 : 0); router.dispose();
});

test("uninstall while waiting and a late ready cannot deliver into the replacement instance", async () => {
  const ready = deferred(); let deliveries = 0;
  const router = createShareReceiverRouter({ resolve: async () => description() });
  const unregister = router.register(registration(() => ready.promise));
  const operation = router.receive("one"); await tick(); unregister();
  router.register(registration(async () => endpoint(async () => { deliveries++; return { status: "received" }; })));
  ready.resolve(endpoint(async () => assert.fail("late old endpoint")));
  assert.equal((await operation).status, "unavailable"); assert.equal(deliveries, 0);
  assert.equal((await router.receive("one")).status, "received"); assert.equal(deliveries, 1); router.dispose();
});

test("activation and acknowledgement have one finite deadline; a new opening cancels pending work", async () => {
  for (const phase of ["ready", "ack"]) {
    const router = createShareReceiverRouter({ timeoutMs: 15, resolve: async () => description() });
    router.register(registration(async () => phase === "ready" ? new Promise(() => {}) : endpoint(() => new Promise(() => {}))));
    assert.equal((await router.receive("one")).status, "unavailable"); router.dispose();
  }
  const first = deferred(); const received = [];
  const router = createShareReceiverRouter({ resolve: async id => id === "old" ? first.promise : description(id) });
  router.register(registration(async () => endpoint(async request => { received.push(request); return { status: "received" }; })));
  const old = router.receive("old"); const current = router.receive("new");
  assert.equal((await old).status, "unavailable"); assert.equal((await current).status, "received");
  first.resolve(description("old")); await tick(); assert.deepEqual(received.map(item => item.shareId), ["new"]); router.dispose();
});

test("transport retries keep the intent and leave duplicate business effects with the receiver", async () => {
  const seen = new Set(); let effects = 0;
  const router = createShareReceiverRouter({ resolve: async () => description() });
  router.register(registration(async () => endpoint(async request => {
    if (!seen.has(request.intentId)) { seen.add(request.intentId); effects++; }
    return { status: "received" };
  })));
  await router.receive("one", "same-transport-intent"); await router.receive("one", "same-transport-intent");
  assert.equal(effects, 1); await router.receive("one"); assert.equal(effects, 2); router.dispose();
  assert.equal((await router.receive("one")).status, "unavailable");
});

test("a cancelled resolve that already settled cannot activate an old receiver", async () => {
  const activated = [];
  const router = createShareReceiverRouter({ resolve: async id => description(id) });
  router.register(registration(async input => { activated.push(input.intentId); return endpoint(async () => ({ status: "received" })); }));
  const old = router.receive("old", "old-intent");
  let current;
  await new Promise(resolve => queueMicrotask(() => { current = router.receive("new", "new-intent"); resolve(); }));
  assert.equal((await old).status, "unavailable"); assert.equal((await current).status, "received");
  assert.deepEqual(activated, ["new-intent"]); router.dispose();
});
