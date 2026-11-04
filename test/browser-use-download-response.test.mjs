import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

export function compileDownloadTransfer(target) {
  const sources = [
    ["chrome-download-response", "src/main/modules/browser-use/chrome-download-response.ts"],
    ["chrome-file-transfer", "src/main/modules/browser-use/chrome-file-transfer.ts"],
    ["browser-file-transfer", "src/main/support/browser-files/transfer.ts"],
  ];
  for (const [name, file] of sources) {
    // The shared transfer rules are compiled beside the module under test.
    const source = fs.readFileSync(path.join(root, file), "utf8").replaceAll('"../../support/browser-files/transfer"', '"./browser-file-transfer"');
    fs.writeFileSync(path.join(target, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
}
const compiled = fs.mkdtempSync(path.join(os.tmpdir(), "browser-response-unit-"));
compileDownloadTransfer(compiled);
const { ChromeTransferStore } = require(path.join(compiled, "chrome-file-transfer.js"));
test.after(() => fs.rmSync(compiled, { recursive: true, force: true }));

function fixture(bytes = Buffer.from("fixture,one\n"), overrides = {}) {
  const calls = [];
  const session = Object.assign(new EventEmitter(), {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Fetch.enable" && overrides.enableError) throw new Error("Synthetic protocol rejection");
      if (method === "Fetch.getResponseBody") return overrides.read ? overrides.read() : { body: bytes.toString("base64"), base64Encoded: true };
      return {};
    },
    async detach() { calls.push({ method: "detach" }); },
  });
  const page = new EventEmitter();
  const tab = { page, desktopPageId: "fixture-page", createDownloadSession: async () => session };
  const headers = [
    { name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.csv" },
    { name: "Content-Type", value: "text/csv; charset=utf-8" },
    { name: "Content-Length", value: String(bytes.length) },
  ];
  const pause = (id = "fixture-request", extra = {}) => session.emit("Fetch.requestPaused", {
    requestId: id, resourceType: "Document", request: { url: "https://fixture.test/report" },
    responseStatusCode: 200, responseHeaders: headers, ...extra,
  });
  return { tab, session, calls, pause, bytes, headers };
}
async function finished(store) {
  for (let i = 0; i < 300; i++) {
    const entries = store.list("fixture-page");
    if (entries.length && entries.every(entry => entry.status !== "pending")) return entries;
    await setImmediate();
  }
  throw new Error("Response capture did not finish");
}
async function portReleased(f) {
  for (let i = 0; i < 300; i++) {
    if (!f.session.listenerCount("Fetch.requestPaused")) return;
    await setImmediate();
  }
  throw new Error("The one-shot response port was not released");
}
function preservedOriginal(f) {
  assert.equal(f.calls.some(call => /failRequest|fulfillRequest|takeResponseBody|^IO\./u.test(call.method)), false,
    "importing a copy must never consume, cancel or reconstruct the browser response");
}

test("one explicit attachment capture copies the body and continues the untouched response once", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); f.pause();
    const [entry] = await finished(store);
    assert.equal(entry.fileName, "报告.csv");
    const result = await store.read("fixture-page", entry.downloadId);
    assert.deepEqual(Buffer.from(result.data, "base64"), f.bytes);
    assert.deepEqual(await store.read("fixture-page", entry.downloadId), result);
    await assert.rejects(store.read("another-page", entry.downloadId), { code: "download_not_found" });
    await portReleased(f);
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 1);
    assert.deepEqual(f.calls.find(call => call.method === "Fetch.continueResponse").params, { requestId: "fixture-request" });
    assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
    assert.equal(f.tab.page.listenerCount("download"), 1);
    const before = f.calls.length;
    f.pause("unrelated-later-download"); await setImmediate();
    assert.equal(f.calls.length, before, "the completed capture must not intercept later user downloads");
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("watching a page does not install a response interceptor", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  try { store.watch(f.tab); f.pause(); await setImmediate(); assert.deepEqual(f.calls, []); }
  finally { await store.shutdown(); }
});

test("ordinary documents, inline PDFs and non-HTTP responses continue without consuming capture permission", async () => {
  for (const extra of [
    { responseHeaders: [{ name: "Content-Type", value: "text/html" }] },
    { responseHeaders: [{ name: "Content-Disposition", value: "inline; filename=document.pdf" }] },
    { request: { url: "blob:https://fixture.test/private" } },
  ]) {
    const f = fixture(), store = new ChromeTransferStore();
    try {
      await store.prepare(f.tab); f.pause("ordinary", extra); await setImmediate();
      assert.deepEqual(store.list("fixture-page"), []);
      assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
      assert.equal(f.calls.some(call => call.method === "Fetch.getResponseBody"), false);
      f.pause("explicit-attachment"); assert.equal((await finished(store))[0].status, "complete");
      preservedOriginal(f);
    } finally { await store.shutdown(); }
  }
});

test("5 MiB, unknown length and encoded attachments bypass body reads and preserve the original download", async () => {
  for (const headers of [
    [{ name: "Content-Length", value: String(5 * 1024 * 1024) }],
    [],
    [{ name: "Content-Length", value: "20" }, { name: "Content-Encoding", value: "gzip" }],
    [{ name: "Content-Length", value: "20" }, { name: "Transfer-Encoding", value: "chunked" }],
    [{ name: "Content-Length", value: "20" }, { name: "Content-Length", value: "21" }],
  ]) {
    const f = fixture(), store = new ChromeTransferStore();
    try {
      await store.prepare(f.tab);
      f.pause("unimportable", { responseHeaders: [{ name: "Content-Disposition", value: "attachment; filename=normal.bin" }, ...headers] });
      assert.equal((await finished(store))[0].status, "failed"); await portReleased(f);
      assert.equal(f.calls.some(call => call.method === "Fetch.getResponseBody"), false);
      assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
      preservedOriginal(f);
    } finally { await store.shutdown(); }
  }
});

test("failed Fetch preparation releases the response port and permits a fresh capture attempt", async () => {
  const f = fixture(undefined, { enableError: true }), store = new ChromeTransferStore();
  try {
    await assert.rejects(store.prepare(f.tab), /Synthetic protocol rejection/u);
    assert.equal(f.calls.filter(call => call.method === "detach").length, 1);
    assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0);
    await assert.rejects(store.prepare(f.tab), /Synthetic protocol rejection/u);
    assert.equal(f.calls.filter(call => call.method === "Fetch.enable").length, 2);
  } finally { await store.shutdown(); }
});

test("partial HTTP responses are never published as complete downloads", async () => {
  for (const [status, range] of [[206, false], [206, true], [200, true]]) {
    const f = fixture(), store = new ChromeTransferStore();
    try {
      await store.prepare(f.tab);
      f.pause("partial", { responseStatusCode: status, responseHeaders: [
        ...f.headers, ...(range ? [{ name: "Content-Range", value: `bytes 0-${f.bytes.length - 1}/1000` }] : []),
      ] });
      const [entry] = await finished(store); await portReleased(f);
      assert.equal(entry.status, "failed"); assert.equal(entry.error, "download_failed");
      assert.equal(f.calls.some(call => call.method === "Fetch.getResponseBody"), false);
      assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
      preservedOriginal(f);
    } finally { await store.shutdown(); }
  }
});

test("Run cancellation while a response port is being created cannot enable a late capture", async () => {
  const f = fixture(), store = new ChromeTransferStore(); let deliver;
  f.tab.createDownloadSession = () => new Promise(resolve => { deliver = resolve; });
  const preparing = store.prepare(f.tab);
  const rejected = assert.rejects(preparing, { code: "cancelled" });
  const stopped = store.endRun();
  deliver(f.session); await Promise.all([rejected, stopped]);
  assert.equal(f.calls.some(call => call.method === "Fetch.enable"), false);
  assert.equal(f.calls.filter(call => call.method === "detach").length, 1);
  assert.deepEqual(store.list("fixture-page"), []); await store.shutdown();
});

test("preparation awaiting an earlier port release cannot rearm after its Run ended", async () => {
  const f = fixture(), store = new ChromeTransferStore(), send = f.session.send;
  let finishDisable;
  f.session.send = async (method, params) => {
    if (method === "Fetch.disable") {
      f.calls.push({ method, params });
      return new Promise(resolve => { finishDisable = resolve; });
    }
    return send(method, params);
  };
  try {
    await store.prepare(f.tab); f.pause(); await finished(store);
    for (let i = 0; i < 50 && !finishDisable; i++) await setImmediate();
    assert.equal(typeof finishDisable, "function");
    const preparing = store.prepare(f.tab);
    const rejected = assert.rejects(preparing, { code: "cancelled" });
    const stopped = store.endRun(); finishDisable(); await Promise.all([rejected, stopped]);
    assert.equal(f.calls.filter(call => call.method === "Fetch.enable").length, 1);
    assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0);
    assert.deepEqual(store.list("fixture-page"), []);
    f.session.send = send;
    await store.prepare(f.tab); await store.endRun();
    assert.equal(f.calls.filter(call => call.method === "Fetch.enable").length, 2, "a new Run may prepare normally");
  } finally { f.session.send = send; await store.shutdown(); }
});

test("the one-shot capture window expires without retaining a network interceptor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); t.mock.timers.tick(10_000); await portReleased(f);
    f.pause("after-expiry"); await setImmediate();
    assert.deepEqual(store.list("fixture-page"), []);
    assert.equal(f.calls.some(call => call.method === "Fetch.getResponseBody"), false);
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("full import capacity continues the ninth original response without attempting a body copy", async () => {
  const f = fixture(Buffer.from("x")), store = new ChromeTransferStore();
  try {
    for (let index = 0; index < 9; index++) {
      await store.prepare(f.tab); f.pause(`request-${index}`); await finished(store); await portReleased(f);
    }
    const entries = store.list("fixture-page");
    assert.equal(entries.length, 9); assert.equal(entries.filter(entry => entry.status === "complete").length, 8);
    assert.equal(entries.at(-1).error, "file_transfer_limit");
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 8);
    assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 9);
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("persistence acknowledgements recycle entry and byte budgets beyond eight downloads", async () => {
  const f = fixture(Buffer.from("x")), store = new ChromeTransferStore();
  try {
    for (let index = 0; index < 12; index++) {
      await store.prepare(f.tab); f.pause(`saved-${index}`); const [entry] = await finished(store); await portReleased(f);
      const result = await store.read("fixture-page", entry.downloadId);
      assert.throws(() => store.releaseDownload("unshared", entry.downloadId, result.sha256), { code: "download_not_found" });
      assert.throws(() => store.releaseDownload("fixture-page", entry.downloadId, "0".repeat(64)), { code: "download_not_ready" });
      const acknowledgement = store.releaseDownload("fixture-page", entry.downloadId, result.sha256);
      assert.deepEqual(acknowledgement, { released: true, downloadId: entry.downloadId, sha256: result.sha256 });
      assert.deepEqual(store.releaseDownload("fixture-page", entry.downloadId, result.sha256), acknowledgement);
      assert.deepEqual(store.list("fixture-page"), []); assert.equal(store.retainedBytes, 0);
    }
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 12);
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("byte capacity is checked before body receipt and persistence acknowledgement recycles it", async () => {
  const f = fixture(Buffer.alloc(4 * 1024 * 1024)), store = new ChromeTransferStore();
  try {
    for (let index = 0; index < 5; index++) {
      await store.prepare(f.tab); f.pause(`budget-${index}`); await finished(store); await portReleased(f);
    }
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 4);
    assert.equal(store.retainedBytes, 16 * 1024 * 1024);
    const entry = store.list("fixture-page").find(item => item.status === "complete");
    const saved = await store.read("fixture-page", entry.downloadId);
    store.releaseDownload("fixture-page", entry.downloadId, saved.sha256);
    await store.prepare(f.tab); f.pause("after-budget-ack"); await finished(store); await portReleased(f);
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 5);
    assert.equal(store.retainedBytes, 16 * 1024 * 1024); preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("failed imports do not consume download slots or accumulate byte reservations", async () => {
  const f = fixture(Buffer.from("x"), { read: () => ({ body: "mismatch", base64Encoded: false }) }), store = new ChromeTransferStore();
  try {
    for (let index = 0; index < 12; index++) {
      await store.prepare(f.tab); f.pause(`failed-${index}`); await finished(store); await portReleased(f);
      assert.equal(store.entries.size, 0); assert.equal(store.retainedBytes, 0);
      assert.equal(store.list("fixture-page").length, 1);
    }
    assert.equal(f.calls.filter(call => call.method === "Fetch.getResponseBody").length, 12);
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("Run cancellation drains the real body read before continuing and discards its late copy", async () => {
  let complete;
  const f = fixture(undefined, { read: () => new Promise(resolve => { complete = resolve; }) }), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); f.pause();
    for (let i = 0; i < 50 && !complete; i++) await setImmediate();
    assert.equal(typeof complete, "function");
    const stopping = store.endRun(); await setImmediate();
    assert.deepEqual(store.list("fixture-page"), []);
    assert.equal(f.calls.some(call => call.method === "Fetch.disable" || call.method === "Fetch.continueResponse"), false);
    await assert.rejects(store.prepare(f.tab), { code: "download_capture_busy" });
    complete({ body: f.bytes.toString("base64"), base64Encoded: true }); await stopping;
    assert.deepEqual(store.list("fixture-page"), []); assert.equal(store.retainedBytes, 0);
    assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
    assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0);
    await store.prepare(f.tab); await store.endRun();
    preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("page close removes its listeners and cached copies without leaving capacity behind", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); f.pause(); await finished(store); await portReleased(f);
    f.tab.page.emit("close"); await setImmediate();
    assert.deepEqual(store.list("fixture-page"), []); assert.equal(store.retainedBytes, 0);
    assert.equal(f.tab.page.listenerCount("download"), 0); assert.equal(f.tab.page.listenerCount("crash"), 0);
    assert.equal(store.listeners.size, 0);
  } finally { await store.shutdown(); }
});

test("cancelling an unstarted capture preserves earlier completed copies and page watchers", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); f.pause(); const [entry] = await finished(store); await portReleased(f);
    const original = await store.read("fixture-page", entry.downloadId);
    await store.prepare(f.tab); await store.cancelCapture("fixture-page");
    assert.deepEqual(await store.read("fixture-page", entry.downloadId), original);
    assert.equal(f.tab.page.listenerCount("download"), 1);
    assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0);
    const before = f.calls.length; f.pause("later-user-download"); await setImmediate();
    assert.equal(f.calls.length, before); preservedOriginal(f);
  } finally { await store.shutdown(); }
});

test("page close during a read still continues its real response and cannot publish a late buffer", async () => {
  let complete;
  const f = fixture(undefined, { read: () => new Promise(resolve => { complete = resolve; }) }), store = new ChromeTransferStore();
  await store.prepare(f.tab); f.pause();
  for (let i = 0; i < 50 && !complete; i++) await setImmediate();
  f.tab.page.emit("close"); await setImmediate();
  assert.deepEqual(store.list("fixture-page"), []); assert.equal(store.listeners.size, 0);
  assert.equal(f.calls.some(call => call.method === "Fetch.disable"), false);
  complete({ body: f.bytes.toString("base64"), base64Encoded: true }); await store.shutdown();
  assert.deepEqual(store.list("fixture-page"), []); assert.equal(store.retainedBytes, 0);
  assert.equal(f.calls.filter(call => call.method === "Fetch.continueResponse").length, 1);
  assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0); preservedOriginal(f);
});
