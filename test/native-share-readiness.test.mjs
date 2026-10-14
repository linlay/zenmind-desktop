import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL("../src/renderer/service-webview/nativeShareReadiness.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
const { waitForNativeShareSurfaceCommit } = module.exports;

test("the first share request waits for registration instead of requiring a user retry", async () => {
  let state = "waiting";
  let reads = 0;
  const request = (async () => {
    if (await waitForNativeShareSurfaceCommit(() => state)) reads += 1;
  })();
  assert.equal(reads, 0);
  state = "ready";
  await request;
  assert.equal(reads, 1);
});

test("switching chat or replacing the guest during registration never reads shared files", async () => {
  let state = "waiting";
  let reads = 0;
  const request = (async () => {
    if (await waitForNativeShareSurfaceCommit(() => state)) reads += 1;
  })();
  state = "stale";
  await request;
  assert.equal(reads, 0);
});

test("an unrelated share source is rejected immediately even if registration later commits", async () => {
  let checks = 0;
  assert.equal(await waitForNativeShareSurfaceCommit(() => {
    checks += 1;
    return checks === 1 ? "stale" : "ready";
  }), false);
  assert.equal(checks, 1);
});

test("registration waiting is bounded and does not authorize an uncommitted source", async () => {
  assert.equal(await waitForNativeShareSurfaceCommit(() => "waiting", 50), false);
});

test("an already committed share starts immediately without a polling delay", async () => {
  let checks = 0;
  assert.equal(await waitForNativeShareSurfaceCommit(() => {
    checks += 1;
    return "ready";
  }), true);
  assert.equal(checks, 1);
});
