import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browser-native-transfer-"));
const ts = require("typescript");
for (const [name, file] of [
  ["chrome-download-response", "src/main/modules/browser-use/chrome-download-response.ts"],
  ["chrome-file-transfer", "src/main/modules/browser-use/chrome-file-transfer.ts"],
  ["browser-file-transfer", "src/main/support/browser-files/transfer.ts"],
]) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    .replaceAll('"../../support/browser-files/transfer"', '"./browser-file-transfer"');
  fs.writeFileSync(path.join(temporary, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { ChromeTransferStore, decodeBrowserUploadFiles, BROWSER_FILE_MAX_BYTES } = require(path.join(temporary, "chrome-file-transfer.js"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const { RealtimeDebugTraceBuffer, serializeAgentRealtimeDebugValue } =
  require("../dist-electron/main/modules/agent-platform/realtime/realtime-debug-trace.js");

test("browser file traces omit bytes without hiding ordinary data or chunk diagnostics", () => {
  const buffer = new RealtimeDebugTraceBuffer();
  const append = data => buffer.append({ layer: "platform-ws", direction: "desktop-to-platform", data }).data;
  const bytes = Buffer.from("private fixture file").toString("base64");
  const upload = { lane: "primary", frame: "request", type: "desktop.cdp.call", payload: {
    method: "Surface.uploadFiles", params: { files: [{ name: "fixture.txt", mimeType: "text/plain", data: bytes }] },
  } };
  const download = { lane: "primary", frame: "response", type: "desktop.cdp.call", data: {
    method: "Surface.readDownload", result: { fileName: "fixture.txt", mimeType: "text/plain", data: bytes, sha256: "fixture-digest" },
  } };
  assert.equal(append(upload).payload.params.files[0].data, "<REDACTED>");
  assert.equal(append(upload).payload.params.files[0].name, "fixture.txt");
  assert.equal(append(download).data.result.data, "<REDACTED>");
  assert.equal(append(download).data.result.sha256, "fixture-digest");
  assert.equal(JSON.stringify(buffer.snapshot()).includes(bytes), false);
  assert.equal(upload.payload.params.files[0].data, bytes);
  assert.equal(download.data.result.data, bytes);
  for (const frame of [
    { frame: "response", type: "/api/example", data: { mimeType: "text/plain", sha256: "checksum", data: "ordinary data", chunk: "ordinary chunk" } },
    { frame: "response", type: "/api/example", data: { method: "Surface.readDownload", result: { data: "ordinary data" } } },
    { frame: "stream", event: { type: "text.delta", encoding: "base64", chunk: "ordinary encoded message" } },
    { frame: "stream", event: { type: "desktop.bridge.response.delta", encoding: "utf8", chunk: "ordinary text" } },
    { frame: "stream", event: { type: "desktop.bridge.response.delta", encoding: "base64", chunk: "ordinary bridge response" } },
    { frame: "stream", event: { type: "desktop.cdp.screenshot.delta", encoding: "base64", chunk: "screenshot retains main diagnostics" } },
  ]) assert.deepEqual(append(frame), frame);
});

test("large browser downloads carry local trace scope without changing ordinary bridge chunks or wire bytes", async () => {
  const { createDesktopRequests } = require("../dist-electron/main/modules/agent-platform/realtime/desktop-requests.js");
  const { AgentPlatformRealtimeClient } = require("../dist-electron/main/modules/agent-platform/realtime/agent-platform-realtime-client.js");
  for (const [type, method, hidden] of [
    ["desktop.cdp.call", "Surface.readDownload", true],
    ["desktop.cdp.call", "Surface.getState", false],
    ["desktop.action", "Surface.readDownload", false],
  ]) {
    const buffer = new RealtimeDebugTraceBuffer(), wire = [];
    const client = {
      state: { phase: "connected" },
      socket: { send: raw => wire.push(JSON.parse(raw)) },
      options: { onTrace: (_direction, frame, browserFileTransfer) => buffer.append({
        layer: "platform-ws", direction: "desktop-to-platform", data: { lane: "primary", ...frame }, browserFileTransfer,
      }) },
      send: AgentPlatformRealtimeClient.prototype.send,
    };
    const requests = createDesktopRequests({ clients: { primary: client } });
    const result = { method, result: { mimeType: "text/plain", data: "SYNTHETIC_CONTENT".repeat(20000), sha256: "fixture-digest" } };
    await requests.sendDesktopBridgeSuccess("trace-scope", type, result, new AbortController().signal);
    const chunks = wire.filter(frame => frame.frame === "stream");
    assert.ok(chunks.length > 1, "exercise the real response chunking path");
    assert.deepEqual(JSON.parse(Buffer.concat(chunks.map(frame => Buffer.from(frame.event.chunk, "base64"))).toString()), result);
    assert.ok(wire.every(frame => !("browserFileTransfer" in frame)), "trace scope is not part of the protocol");
    const traces = buffer.snapshot().filter(entry => entry.data.frame === "stream");
    for (let index = 0; index < chunks.length; index++) {
      const ordinaryPreview = serializeAgentRealtimeDebugValue({ lane: "primary", ...chunks[index] });
      assert.equal(traces[index].data.event.chunk, hidden ? "<REDACTED>" : ordinaryPreview.event.chunk);
      assert.equal(traces[index].data.event.seq, chunks[index].event.seq);
    }
  }
});

function download(name, bytes, overrides = {}) {
  return { suggestedFilename: () => name, createReadStream: async () => Readable.from([bytes]),
    failure: async () => null, cancel: async () => {}, ...overrides };
}
async function finished(store, pageId) {
  for (let count = 0; count < 100; count++) {
    const entries = store.list(pageId);
    if (entries.length && entries.every(entry => entry.status !== "pending")) return entries;
    await setImmediate();
  }
  throw new Error("Download fixture did not finish");
}

test("uploads accept authorized bytes only, reject paths/malformed data and enforce the total wire budget", () => {
  const encoded = { name: "采购说明.csv", mimeType: "text/csv", data: Buffer.from("sku,quantity\nA,6\n").toString("base64") };
  const result = decodeBrowserUploadFiles([encoded]);
  assert.equal(result[0].buffer.toString(), "sku,quantity\nA,6\n");
  assert.equal(decodeBrowserUploadFiles([{ ...encoded, mimeType: "text/plain; charset=utf-8" }])[0].mimeType, "text/plain");
  assert.equal(decodeBrowserUploadFiles([{ ...encoded, name: ".gitignore" }])[0].name, ".gitignore");
  assert.equal(decodeBrowserUploadFiles([{ ...encoded, name: `${"a".repeat(201)}.txt` }])[0].name.length, 205);
  assert.throws(() => decodeBrowserUploadFiles([{ ...encoded, mimeType: "text/plain;\r\nX-Header: x" }]), { code: "invalid_params" });
  assert.throws(() => decodeBrowserUploadFiles([{ ...encoded, path: "/private/file" }]), { code: "invalid_params" });
  for (const name of ["../file.csv", "C:\\file.csv", "CON.txt", "hidden."]) {
    assert.throws(() => decodeBrowserUploadFiles([{ ...encoded, name }]), { code: "invalid_params" });
  }
  for (const data of ["%%%%", "YQ==AAAA", "YQ=", "Y==="]) {
    assert.throws(() => decodeBrowserUploadFiles([{ ...encoded, data }]), { code: "invalid_params" });
  }
  const half = Buffer.alloc(BROWSER_FILE_MAX_BYTES / 2 + 1).toString("base64");
  assert.throws(() => decodeBrowserUploadFiles([{ ...encoded, data: half }, { ...encoded, data: half }]), { code: "file_transfer_limit" });
});

test("downloads are page scoped, repeated reads are stable, and duplicate host events are deduplicated", async () => {
  const store = new ChromeTransferStore();
  const page = new EventEmitter();
  const tab = { desktopPageId: "page-a", page };
  store.watch(tab);
  await store.prepare(tab);
  const item = download("../../CON.txt", Buffer.from("fixture result"));
  store.captureDownload(tab, item);
  page.emit("download", item);
  const entries = await finished(store, "page-a");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fileName, "download-CON.txt");
  const first = await store.read("page-a", entries[0].downloadId);
  assert.equal(Buffer.from(first.data, "base64").toString(), "fixture result");
  assert.deepEqual(await store.read("page-a", entries[0].downloadId), first);
  await assert.rejects(store.read("page-b", entries[0].downloadId), { code: "download_not_found" });
  assert.equal("path" in first, false);
  assert.equal("url" in first, false);
  store.dispose();
  assert.equal(page.listenerCount("download"), 0);
});

test("oversized and excess downloads have explicit failure metadata instead of a silent success", async () => {
  const store = new ChromeTransferStore();
  const tab = { desktopPageId: "page-a", page: new EventEmitter() };
  await store.prepare(tab);
  store.captureDownload(tab, download("large.bin", Buffer.alloc(BROWSER_FILE_MAX_BYTES + 1)));
  assert.equal((await finished(store, "page-a"))[0].error, "file_transfer_limit");
  for (let i = 0; i < 9; i++) {
    await store.prepare(tab); store.captureDownload(tab, download(`file-${i}.txt`, Buffer.from("a")));
    await finished(store, "page-a");
  }
  const entries = await finished(store, "page-a");
  assert.equal(entries.at(-1).status, "failed");
  assert.equal(entries.at(-1).error, "file_transfer_limit");
  await assert.rejects(store.read("page-a", entries.at(-1).downloadId), { code: "file_transfer_limit" });
  store.dispose();
});

test("disconnect discards a pending copy without cancelling the original browser download", async () => {
  let release, cancelled = 0;
  const stream = new Promise(resolve => { release = resolve; });
  const store = new ChromeTransferStore();
  const tab = { desktopPageId: "page-a", page: new EventEmitter() };
  await store.prepare(tab);
  store.captureDownload(tab, download("pending.txt", Buffer.alloc(0), {
    createReadStream: () => stream, cancel: async () => { cancelled++; },
  }));
  const id = store.list("page-a")[0].downloadId;
  await assert.rejects(store.read("page-a", id), { code: "download_not_ready" });
  store.dispose();
  release(Readable.from([Buffer.from("late result")]));
  await setImmediate();
  assert.equal(cancelled, 0);
  assert.deepEqual(store.list("page-a"), []);
  await assert.rejects(store.read("page-a", id), { code: "browser_disconnected" });
});

test("unarmed native downloads never read or cancel a user's file", async () => {
  const store = new ChromeTransferStore(), page = new EventEmitter(), tab = { desktopPageId: "user-page", page };
  let reads = 0, cancels = 0;
  const item = download("user.bin", Buffer.from("a"), { createReadStream: async () => { reads++; }, cancel: async () => { cancels++; } });
  store.watch(tab); store.captureDownload(tab, item); page.emit("download", item); await setImmediate();
  assert.equal(reads, 0); assert.equal(cancels, 0); assert.deepEqual(store.list("user-page"), []);
  await store.shutdown();
});

test("native download limit and capacity failures preserve the original download", async () => {
  const store = new ChromeTransferStore(), tab = { desktopPageId: "page-a", page: new EventEmitter() };
  let cancels = 0;
  const make = (name, bytes) => download(name, bytes, { cancel: async () => { cancels++; } });
  await store.prepare(tab); store.captureDownload(tab, make("too-large.bin", Buffer.alloc(BROWSER_FILE_MAX_BYTES + 1)));
  assert.equal((await finished(store, "page-a"))[0].error, "file_transfer_limit");
  for (let index = 0; index < 9; index++) {
    await store.prepare(tab); store.captureDownload(tab, make(`native-${index}.txt`, Buffer.from("x"))); await finished(store, "page-a");
  }
  assert.equal(cancels, 0); assert.equal(store.list("page-a").at(-1).error, "file_transfer_limit");
  await store.endRun(); assert.deepEqual(store.list("page-a"), []); assert.equal(store.retainedBytes, 0);
  await store.prepare(tab); store.captureDownload(tab, make("next-run.txt", Buffer.from("next")));
  assert.equal((await finished(store, "page-a"))[0].status, "complete"); await store.shutdown();
});
