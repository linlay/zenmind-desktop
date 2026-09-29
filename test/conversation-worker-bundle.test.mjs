import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { brandBundleElectronDir, loadBrandConfig, resolveBrandId } from "../scripts/lib/brand-config.mjs";

test("release conversation Worker reads a snapshot without development dependencies", { timeout: 15_000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const brand = loadBrandConfig(root, resolveBrandId());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-worker-bundle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workerPath = path.join(directory, "conversation-html-worker.cjs");
  // Exercise the actual release artifact, outside the repository's node_modules.
  await fs.copyFile(path.join(brandBundleElectronDir(root, brand), "main/conversation-html-worker.js"), workerPath);
  const snapshot = Buffer.from(JSON.stringify({ version: 1, title: "Packaged chat", turns: [], attachments: [] }));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/api/chat/export?chatId=packaged&format=snapshot");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": snapshot.length });
    response.end(snapshot);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const worker = new Worker(workerPath, { workerData: { mode: "conversation-html-render" } });
  t.after(() => worker.terminate());
  const result = once(worker, "message");
  worker.postMessage({
    kind: "snapshot", requestId: "packaged",
    snapshotUrl: `http://127.0.0.1:${server.address().port}/api/chat/export?chatId=packaged&format=snapshot`,
    bearerToken: "test-token"
  });
  const [response] = await result;
  assert.equal(response.type, "snapshot");
  assert.equal(response.requestId, "packaged");
  assert.deepEqual(JSON.parse(Buffer.from(response.snapshot).toString()), JSON.parse(snapshot.toString()));
  assert.deepEqual(response.attachments, []);
});
