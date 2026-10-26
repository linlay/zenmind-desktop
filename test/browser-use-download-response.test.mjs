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
  let offset = 0;
  const session = Object.assign(new EventEmitter(), {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Fetch.enable" && overrides.enableError) throw new Error("Synthetic protocol rejection");
      if (method === "Fetch.takeResponseBodyAsStream") return { stream: "fixture-stream" };
      if (method === "IO.read") {
        if (overrides.read) return overrides.read();
        const data = bytes.subarray(offset, offset + 64 * 1024); offset += data.length;
        return { data: data.toString("base64"), base64Encoded: true, eof: offset >= bytes.length };
      }
      return {};
    },
    async detach() { calls.push({ method: "detach" }); },
  });
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => session }) });
  const tab = { page, desktopPageId: "fixture-page", createDownloadSession: async () => session };
  const pause = (id = "fixture-request", extra = {}) => session.emit("Fetch.requestPaused", {
    requestId: id, resourceType: "Document", request: { url: "https://fixture.test/report" },
    responseStatusCode: 200, responseStatusText: "OK",
    responseHeaders: [{ name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.csv" },
      { name: "Content-Type", value: "text/csv; charset=utf-8" }], ...extra,
  });
  return { tab, session, calls, pause, bytes };
}
async function finished(store) {
  for (let i = 0; i < 300; i++) {
    const entries = store.list("fixture-page");
    if (entries.length && entries.every(entry => entry.status !== "pending")) return entries;
    await setImmediate();
  }
  throw new Error("Response capture did not finish");
}

test("attachment response uses a page-scoped port, bounded IO and the same fulfilled bytes", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab);
    f.pause();
    const entries = await finished(store);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fileName, "报告.csv");
    const result = await store.read("fixture-page", entries[0].downloadId);
    assert.deepEqual(Buffer.from(result.data, "base64"), f.bytes);
    assert.deepEqual(f.calls.find(call => call.method === "Fetch.enable").params.patterns,
      [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }]);
    assert.equal(f.calls.filter(call => call.method === "Fetch.takeResponseBodyAsStream").length, 1);
    assert.equal(f.calls.find(call => call.method === "IO.read").params.size, 64 * 1024);
    const fulfilled = f.calls.find(call => call.method === "Fetch.fulfillRequest");
    assert.deepEqual(Buffer.from(fulfilled.params.body, "base64"), f.bytes);
    assert.equal(f.calls.some(call => call.method === "IO.close"), true);
    assert.equal(f.calls.some(call => /fetch|navigate/iu.test(call.method) && !call.method.startsWith("Fetch.")), false);
    await assert.rejects(store.read("another-page", entries[0].downloadId), { code: "download_not_found" });
  } finally { await store.shutdown(); }
});

test("ordinary documents, inline PDFs and non-HTTP responses continue without import", async () => {
  for (const extra of [
    { responseHeaders: [{ name: "Content-Type", value: "text/html" }] },
    { responseHeaders: [{ name: "Content-Disposition", value: "inline; filename=document.pdf" }] },
    { request: { url: "blob:https://fixture.test/private" } },
  ]) {
    const f = fixture(), store = new ChromeTransferStore();
    try {
      await store.prepare(f.tab); f.pause("ordinary", extra); await setImmediate();
      assert.deepEqual(store.list("fixture-page"), []);
      assert.equal(f.calls.some(call => call.method === "Fetch.continueResponse"), true);
      assert.equal(f.calls.some(call => call.method === "Fetch.takeResponseBodyAsStream"), false);
    } finally { await store.shutdown(); }
  }
});

test("failed Fetch preparation releases its response port and does not cache a broken state", async () => {
  const f = fixture(undefined, { enableError: true }), store = new ChromeTransferStore();
  try {
    await assert.rejects(store.prepare(f.tab), /Synthetic protocol rejection/u);
    assert.equal(f.calls.filter(call => call.method === "detach").length, 1);
    assert.equal(f.session.listenerCount("Fetch.requestPaused"), 0);
    await assert.rejects(store.prepare(f.tab), /Synthetic protocol rejection/u);
    assert.equal(f.calls.filter(call => call.method === "Fetch.enable").length, 2);
  } finally { await store.shutdown(); }
});

test("a missing private response port is rejected without attempting a Browser target attachment", async () => {
  const f = fixture(), store = new ChromeTransferStore();
  delete f.tab.createDownloadSession;
  f.tab.page.context = () => { throw new Error("Public Browser-target session must not be attempted"); };
  try { await assert.rejects(store.prepare(f.tab), { code: "capability_unavailable" }); }
  finally { await store.shutdown(); }
});

test("response mode suppresses native duplicate imports and preserves the bounded failure notice", async () => {
  const f = fixture(), store = new ChromeTransferStore(); let nativeReads = 0;
  try {
    await store.prepare(f.tab);
    for (let index = 0; index < 9; index++) {
      f.pause(`request-${index}`);
      await finished(store);
    }
    const native = { suggestedFilename: () => "duplicate.csv", createReadStream: async () => { nativeReads++; }, cancel: async () => {} };
    store.captureDownload(f.tab, native); f.tab.page.emit("download", native);
    const entries = store.list("fixture-page");
    assert.equal(entries.length, 9);
    assert.equal(entries.filter(entry => entry.status === "complete").length, 8);
    assert.equal(entries.at(-1).error, "file_transfer_limit");
    assert.equal(nativeReads, 0);
    assert.equal(f.calls.filter(call => call.method === "Fetch.failRequest").length, 1);
  } finally { await store.shutdown(); }
});

test("oversized responses fail before publication and cannot be continued after stream consumption", async () => {
  const f = fixture(Buffer.alloc(4 * 1024 * 1024 + 1)), store = new ChromeTransferStore();
  try {
    await store.prepare(f.tab); f.pause();
    const entries = await finished(store);
    assert.equal(entries[0].status, "failed");
    assert.equal(entries[0].error, "file_transfer_limit");
    assert.equal(f.calls.some(call => call.method === "Fetch.fulfillRequest"), false);
    assert.equal(f.calls.some(call => call.method === "Fetch.failRequest"), true);
    assert.equal(f.calls.some(call => call.method === "Fetch.continueResponse"), false);
    await assert.rejects(store.read("fixture-page", entries[0].downloadId), { code: "download_failed" });
  } finally { await store.shutdown(); }
});

test("shutdown is awaited and a late stream result cannot publish bytes", async () => {
  let finish;
  const f = fixture(undefined, { read: () => new Promise(resolve => { finish = resolve; }) }), store = new ChromeTransferStore();
  await store.prepare(f.tab); f.pause();
  for (let i=0;i<100&&!finish;i++) await setImmediate();
  assert.ok(finish);
  await store.shutdown();
  finish({ data: "late response", eof: true }); await setImmediate();
  assert.deepEqual(store.list("fixture-page"), []);
  assert.equal(f.calls.some(call => call.method === "Fetch.fulfillRequest"), false);
  assert.equal(f.calls.some(call => call.method === "Fetch.failRequest"), true);
  assert.equal(f.calls.some(call => call.method === "Fetch.disable"), true);
  assert.equal(f.calls.some(call => call.method === "detach"), true);
});
