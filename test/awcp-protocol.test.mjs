import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(import.meta.dirname, "..");
const domainPath = path.join(root, "src/main/modules/awcp/index.ts");
const nativePath = path.join(root, "src/main/modules/web-surfaces/awcp/guest-bridge.ts");

// Compile current sources only in memory. Native regression must exercise the
// extracted implementation, even when another agent is still preparing dist.
function loadSources(observeProtocol) {
  const cache = new Map(), dependencies = new Map(), calls = [];
  const load = filename => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = new Module(filename);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, module);
    module.require = specifier => {
      const imports = dependencies.get(filename) ?? [];
      imports.push(specifier); dependencies.set(filename, imports);
      if (!specifier.startsWith(".")) return require(specifier);
      const base = path.resolve(path.dirname(filename), specifier);
      const target = [`${base}.ts`, path.join(base, "index.ts")].find(file => fs.existsSync(file));
      assert.ok(target, `source dependency exists: ${specifier}`);
      const exported = load(target);
      if (observeProtocol && filename === nativePath && target === domainPath) {
        return new Proxy(exported, { get(object, key) {
          const value = object[key];
          if (typeof value !== "function" || key === "AwcpHostError") return value;
          return (...args) => { calls.push(key); return value(...args); };
        } });
      }
      return exported;
    };
    module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, filename);
    return module.exports;
  };
  return { protocol: load(domainPath), native: () => load(nativePath), dependencies, calls };
}

const index = (revision = "r1") => ({ revision, site: { name: "Sample", description: "Sample page operations." },
  sections: [{ section: "orders.read", title: "Read orders" }, { section: "orders.write", title: "Write orders" }] });
const section = (action = "orders.read", revision = "r1") => ({ revision, section: action,
  description: "Page-owned operation.", inputSchema: { $ref: "https://page.test/schema" } });
const invoke = (action = "orders.read", revision = "r1") => ({ revision, action, args: {} });

test("the shared AWCP entry point loads with only Buffer and exposes one frozen v1 envelope contract", () => {
  const { protocol: p, dependencies } = loadSources();
  assert.equal(p.AWCP_PROTOCOL_VERSION, 1);
  assert.equal(p.PROTOCOL_VERSION, p.AWCP_PROTOCOL_VERSION);
  assert.equal(Object.isFrozen(p.AWCP_LIMITS), true);
  assert.equal(p.AWCP_LIMITS.maxResponseBytes, 64 * 1024 * 1024);
  for (const [file, imports] of dependencies) {
    assert.ok(file.startsWith(path.dirname(domainPath)));
    assert.ok(imports.every(name => name === "./protocol" || name === "node:buffer"));
  }
  for (const name of ["validateManualPayload", "validateInvokePayload", "validateManualIndex", "validateManualSection",
    "validateManualError", "validateActionResponse", "assertJsonValue", "assertPlainRecord", "assertToken",
    "awcpHostError", "awcpPreflightFailure", "isAwcpHostError", "stableAwcpJSON"])
    assert.equal(typeof p[name], "function", name);
});

test("both transports can validate bounded manual and invocation envelopes without compiling page business Schema", () => {
  const { protocol: p } = loadSources();
  assert.deepEqual(p.validateManualPayload({}), {});
  assert.deepEqual(p.validateManualPayload({ section: "orders.read", revision: "r1" }), { section: "orders.read", revision: "r1" });
  const request = invoke();
  assert.equal(p.validateInvokePayload("request-1", request), request);
  assert.equal(p.validateManualIndex(index()).revision, "r1");
  const pageSection = section();
  assert.equal(p.validateManualSection(pageSection, "orders.read", "r1"), pageSection);
  assert.deepEqual(pageSection.inputSchema, { $ref: "https://page.test/schema" });
  for (const input of [null, [], { section: "orders.read" }, { section: "Orders.Read", revision: "r1" },
    { section: "orders.read", revision: "r1", args: {} }])
    assert.throws(() => p.validateManualPayload(input), { code: "awcp_invalid_request" });
  for (const input of [{ ...request, revision: "x".repeat(129) }, { ...request, action: "bad..action" },
    { ...request, args: [] }, { ...request, endpoint: "https://other.test" }])
    assert.throws(() => p.validateInvokePayload("request-1", input), { code: "awcp_invalid_request" });
  assert.throws(() => p.validateInvokePayload("x".repeat(129), request), { code: "awcp_invalid_request" });
  assert.throws(() => p.validateManualIndex({ ...index(), sections: [...index().sections].reverse() }), { code: "awcp_invalid_contract" });
  assert.throws(() => p.validateManualIndex({ ...index(), sections: Array.from({ length: 129 }, (_, i) => ({ section: `a${i}`, title: "a" })) }),
    { code: "awcp_invalid_contract" });
  const largeIndex = { ...index(), site: { name: "Sample", description: "界".repeat(p.AWCP_LIMITS.maxDescriptionLength) },
    sections: Array.from({ length: 128 }, (_, i) => ({ section: `action.a${String(i).padStart(3, "0")}`, title: "界".repeat(128) })) };
  assert.throws(() => p.validateManualIndex(largeIndex), { code: "awcp_invalid_contract" }, "manual limits apply to UTF-8 bytes");
  assert.throws(() => p.validateManualSection(pageSection, "orders.write", "r1"), { code: "awcp_invalid_contract" });
  assert.throws(() => p.validateManualSection({ ...pageSection, examples: Array(33).fill({}) }, "orders.read", "r1"), { code: "awcp_invalid_contract" });
  assert.throws(() => p.validateManualSection({ ...pageSection, inputSchema: { description: "x".repeat(p.AWCP_LIMITS.maxSectionBytes) } },
    "orders.read", "r1"), { code: "awcp_invalid_contract" });
});

test("the protocol rejects non-JSON values without invoking accessors and preserves deterministic bytes", () => {
  const { protocol: p } = loadSources();
  const cycle = {}; cycle.self = cycle;
  let accessed = 0;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { accessed++; return "private"; } });
  const symbol = { [Symbol("hidden")]: "value" };
  for (const value of [cycle, accessor, symbol, { n: NaN }, { n: Infinity }, { n: 1n }, { absent: undefined }, new Date(), [, 1]])
    assert.throws(() => p.assertJsonValue(value, "AWCP data", "awcp_invalid_response"), { code: "awcp_invalid_response" });
  assert.equal(accessed, 0);
  assert.equal(p.stableAwcpJSON({ z: [{ beta: 2, alpha: 1 }], a: null }), '{"a":null,"z":[{"alpha":1,"beta":2}]}');
  assert.equal(p.stableAwcpJSON({ a: null, z: [{ alpha: 1, beta: 2 }] }), p.stableAwcpJSON({ z: [{ beta: 2, alpha: 1 }], a: null }));
});

test("shared responses preserve correlation, page errors, limits and the host/preflight distinction", () => {
  const { protocol: p } = loadSources();
  const success = { ok: true, requestId: "request-1", action: "orders.read", result: { items: [1] } };
  const failure = { ok: false, requestId: "request-1", action: "orders.read",
    error: { code: "action.fields", message: "Invalid field.", details: { fields: ["name"] } } };
  assert.equal(p.validateActionResponse(success, "request-1", "orders.read"), success);
  assert.equal(p.validateActionResponse(failure, "request-1", "orders.read"), failure);
  assert.throws(() => p.validateActionResponse(success, "request-2", "orders.read"), { code: "awcp_response_mismatch" });
  assert.throws(() => p.validateActionResponse({ ...failure, error: { code: "unknown", message: "No." } }, "request-1", "orders.read"),
    { code: "awcp_invalid_response" });
  assert.throws(() => p.validateActionResponse({ ...failure, error: { ...failure.error, details: "x".repeat(p.AWCP_LIMITS.maxErrorDetailsBytes) } },
    "request-1", "orders.read"), { code: "awcp_invalid_response" });
  assert.equal(p.validateManualError({ error: { code: "stale_revision", message: "Read again.", section: "orders.read" } }, "orders.read"), "stale_revision");
  assert.throws(() => p.validateManualError({ error: { code: "stale_revision", message: "Read again.", section: "other.read" } }, "orders.read"),
    { code: "awcp_invalid_contract" });
  const preflight = p.awcpPreflightFailure("manual_required", "Read the manual.");
  assert.equal(preflight.statusCode, 400);
  assert.deepEqual(preflight.details, { reason: "manual_required", stage: "desktop_preflight", executionStarted: false });
  assert.equal(p.isAwcpHostError(preflight), true);
  assert.equal(preflight instanceof p.AwcpHostError, true);
  assert.equal(p.isAwcpHostError(new Error("Page error")), false);
  assert.equal(p.awcpHostError("awcp_duplicate_request", "Duplicate.").statusCode, 409);
  assert.equal(p.awcpHostError("awcp_invalid_response", "Malformed.").statusCode, 502);
});

function nativeHarness(t) {
  const loaded = loadSources(true), { protocol: p } = loaded;
  const { AwcpGuestBridge, AWCP_LIMITS } = loaded.native();
  const guest = Object.assign(new EventEmitter(), { id: 101, destroyed: false, isDestroyed() { return this.destroyed; } });
  const tab = { tabId: "tab-one", webContentsId: guest.id };
  const container = { id: "container", targetGeneration: "generation", activeTabId: tab.tabId, tabs: [tab] };
  const releases = new Set(), scripts = [];
  let released = false;
  const scope = {
    readContainer() { if (released) throw p.awcpHostError("site_control_unavailable", "Released."); return container; },
    validateTab(value) { assert.equal(value, tab); },
    onRelease(callback) { releases.add(callback); return () => releases.delete(callback); },
    release() { if (released) return; released = true; for (const callback of [...releases]) callback(); releases.clear(); },
  };
  let invokeHandler = envelope => ({ ok: true, requestId: envelope.requestId, action: envelope.action, result: { saved: true } });
  guest.executeJavaScript = async script => {
    scripts.push(script);
    if (script.includes("actualVersion")) return { present: true, entryType: "object", actualVersion: 1, manualType: "function", invokeType: "function" };
    if (script.includes(".manual(")) return script.includes("section") ? section() : index();
    if (script.includes(".invoke(")) {
      const match = /JSON\.parse\((.*)\)\)/u.exec(script);
      return invokeHandler(JSON.parse(JSON.parse(match[1])));
    }
    if (script.includes(".cancel(")) return true;
    assert.fail("Unexpected native page script.");
  };
  const bridge = new AwcpGuestBridge({ findWebContentsById: id => id === guest.id ? guest : undefined });
  t.after(() => { bridge.dispose(); scope.release(); });
  return { ...loaded, bridge, guest, scope, scripts, AWCP_LIMITS, releases,
    setInvoke(handler) { invokeHandler = handler; },
    async discover() {
      await bridge.manual("manual-index", {}, scope);
      await bridge.manual("manual-section", { section: "orders.read", revision: "r1" }, scope);
    } };
}

test("the native guest consumes the same protocol helpers and keeps mandatory manual bindings", async t => {
  const h = nativeHarness(t), p = h.protocol;
  assert.equal(h.AWCP_LIMITS, p.AWCP_LIMITS, "legacy native exports refer to the shared domain constants");
  await assert.rejects(h.bridge.invoke("too-early", invoke(), h.scope), error => error instanceof p.AwcpHostError &&
    error.code === "awcp_preflight_rejected" && error.details.reason === "manual_required");
  assert.equal(h.scripts.some(script => script.includes(".invoke(")), false);
  await h.discover();
  const result = await h.bridge.invoke("request-1", invoke(), h.scope);
  assert.deepEqual(result, { ok: true, requestId: "request-1", action: "orders.read", result: { saved: true } });
  for (const name of ["validateManualPayload", "validateManualIndex", "validateManualSection", "validateManualError",
    "validateInvokePayload", "validateActionResponse", "awcpPreflightFailure"])
    assert.ok(h.calls.includes(name), `native guest reuses ${name}`);
  h.guest.emit("did-navigate-in-page", {}, "https://page.test/changed", true);
  await assert.rejects(h.bridge.invoke("after-navigation", invoke(), h.scope), error => error instanceof p.AwcpHostError &&
    error.code === "awcp_preflight_rejected" && error.details.reason === "page_changed");
  h.bridge.dispose(); h.scope.release();
  assert.equal(h.guest.eventNames().length, 0);
  assert.equal(h.releases.size, 0);
});

test("native in-flight cancellation remains pinned to its exact guest and preserves shared host error identity", async t => {
  const h = nativeHarness(t);
  await h.discover();
  h.setInvoke(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = h.bridge.invoke("pending-invoke", invoke(), h.scope, controller.signal);
  const rejected = assert.rejects(pending, error => h.protocol.isAwcpHostError(error) && error.code === "awcp_cancelled");
  for (let i = 0; i < 10 && !h.scripts.some(script => script.includes(".invoke(")); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.scripts.some(script => script.includes(".invoke(")));
  controller.abort();
  await rejected;
  assert.equal(h.scripts.filter(script => script.includes('globalThis.awcp?.cancel("pending-invoke")')).length, 1);
  assert.equal(h.bridge.cancel("pending-invoke"), false);
  h.bridge.dispose(); h.scope.release();
  assert.equal(h.guest.eventNames().length, 0);
});
