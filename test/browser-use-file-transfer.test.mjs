import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
const require = createRequire(import.meta.url);
const { ChromeTransferStore, decodeBrowserUploadFiles, BROWSER_FILE_MAX_BYTES } =
  require("../dist-electron/main/modules/browser-use/chrome-file-transfer.js");
const { sanitizeAgentRealtimeDebugValue } =
  require("../dist-electron/main/modules/agent-platform/realtime/realtime-debug-trace.js");

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
  store.captureDownload(tab, download("large.bin", Buffer.alloc(BROWSER_FILE_MAX_BYTES + 1)));
  assert.equal((await finished(store, "page-a"))[0].error, "file_transfer_limit");
  for (let i = 0; i < 8; i++) store.captureDownload(tab, download(`file-${i}.txt`, Buffer.from("a")));
  const entries = await finished(store, "page-a");
  assert.equal(entries.at(-1).status, "failed");
  assert.equal(entries.at(-1).error, "file_transfer_limit");
  await assert.rejects(store.read("page-a", entries.at(-1).downloadId), { code: "file_transfer_limit" });
  store.dispose();
});

test("disconnect cancels pending transfers and cannot expose a late completed buffer", async () => {
  let release, cancelled = 0;
  const stream = new Promise(resolve => { release = resolve; });
  const store = new ChromeTransferStore();
  const tab = { desktopPageId: "page-a", page: new EventEmitter() };
  store.captureDownload(tab, download("pending.txt", Buffer.alloc(0), {
    createReadStream: () => stream, cancel: async () => { cancelled++; },
  }));
  const id = store.list("page-a")[0].downloadId;
  await assert.rejects(store.read("page-a", id), { code: "download_not_ready" });
  store.dispose();
  release(Readable.from([Buffer.from("late result")]));
  await setImmediate();
  assert.equal(cancelled, 1);
  assert.deepEqual(store.list("page-a"), []);
  await assert.rejects(store.read("page-a", id), { code: "browser_disconnected" });
});

test("realtime diagnostics preserve file metadata but never retain upload, download or stream bytes", () => {
  const marker = "SYNTHETIC_FILE_BODY_MUST_NOT_BE_LOGGED";
  const frame = { method: "Surface.uploadFiles", params: { files: [{ name: "fixture.txt", mimeType: "text/plain", data: marker }] },
    response: { result: { fileName: "fixture.txt", mimeType: "text/plain", data: marker, sha256: "fixture-hash" } },
    event: { type: "desktop.cdp.response.delta", chunk: marker } };
  const sanitized = sanitizeAgentRealtimeDebugValue(frame);
  assert.equal(JSON.stringify(sanitized).includes(marker), false);
  assert.equal(sanitized.params.files[0].name, "fixture.txt");
  assert.equal(sanitized.method, "Surface.uploadFiles");
});
