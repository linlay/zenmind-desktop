import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { createLocalMarkdownRenderer, renderLocalMarkdownAsync } = await import("../dist-electron/main/modules/work-panel/local-document-render.js");
const { LOCAL_MARKDOWN_MAX_BYTES } = await import("../dist-electron/main/modules/work-panel/local-document-worker-contract.js");

function documentBytes(size) {
  const paragraph = "# Heading\n\nParagraph **bold** with `code` and [link](https://example.test).\n\n";
  return Buffer.from(paragraph.repeat(Math.ceil(size / paragraph.length)));
}

test("the real Markdown Worker renders GFM without detaching the caller's pooled Buffer", async () => {
  const storage = Buffer.from("prefix\n# 文档\n\n~~old~~\nsuffix");
  const bytes = storage.subarray(Buffer.byteLength("prefix\n"), storage.length - Buffer.byteLength("\nsuffix"));
  const before = Buffer.from(storage);
  const html = await renderLocalMarkdownAsync(bytes, "说明.md");
  assert.match(html, /<h1>文档<\/h1>/);
  assert.match(html, /<del>old<\/del>/);
  assert.deepEqual(storage, before);
  assert.equal(bytes.toString("utf8"), "# 文档\n\n~~old~~");
});

test("Main timers keep running while a real Worker parses a one-MiB Markdown document", async () => {
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 5);
  try {
    const html = await renderLocalMarkdownAsync(documentBytes(1024 * 1024), "large.md");
    assert.match(html, /<h1>Heading<\/h1>/);
    assert.ok(ticks >= 3, `Main heartbeat must progress during rendering; observed ${ticks} ticks`);
  } finally {
    clearInterval(heartbeat);
  }
});

test("closing a document aborts queued and active Workers, and later files still render", async () => {
  const render = createLocalMarkdownRenderer();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const inFlight = controllers.map((controller, index) => render(documentBytes(1024 * 1024), `${index}.md`, controller.signal));
  const completed = Promise.allSettled(inFlight);
  // The first two jobs are active; the third waits for a worker slot.
  controllers[2].abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controllers[0].abort();
  controllers[1].abort();
  for (const result of await completed) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.name, "AbortError");
  }
  const html = await render(Buffer.from("# Reopened"), "reopened.md");
  assert.match(html, /<h1>Reopened<\/h1>/);
});

test("already-cancelled and oversized render requests fail before starting work", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderLocalMarkdownAsync(Buffer.from("# ignored"), "ignored.md", controller.signal), { name: "AbortError" });
  await assert.rejects(renderLocalMarkdownAsync(Buffer.alloc(LOCAL_MARKDOWN_MAX_BYTES + 1), "too-large.md"), { code: "too_large" });
});

test("a Worker render deadline rejects and terminates an unfinished render", async () => {
  const render = createLocalMarkdownRenderer({ timeoutMs: 1 });
  await assert.rejects(render(documentBytes(1024 * 1024), "slow.md"), { code: "timeout" });
});

test("invalid document bytes are isolated to that Worker and do not poison the next render", async () => {
  const render = createLocalMarkdownRenderer();
  await assert.rejects(render(Buffer.from([0xff, 0xff]), "invalid.md"), { code: "render_failed" });
  assert.match(await render(Buffer.from("# Recovered"), "valid.md"), /<h1>Recovered<\/h1>/);
});

test("missing or prematurely exiting Workers reject instead of leaving a preview pending", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-document-worker-failure-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const exitedWorker = path.join(directory, "exit.cjs");
  fs.writeFileSync(exitedWorker, "process.exit(0);\n");
  for (const workerPath of [path.join(directory, "missing.cjs"), exitedWorker]) {
    const render = createLocalMarkdownRenderer({ workerPath });
    await assert.rejects(render(Buffer.from("# Document"), "document.md"), { code: "render_failed" });
  }
});

test("bundled Main finds and executes its separately bundled local-document Worker", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-document-bundle-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  await build({
    absWorkingDir: root,
    entryPoints: {
      "main/index": "src/main/modules/work-panel/local-document-render.ts",
      "main/local-document-worker": "src/main/modules/work-panel/local-document-worker.ts",
    },
    outdir: directory,
    platform: "node",
    format: "cjs",
    target: "node20",
    bundle: true,
    minify: true,
    legalComments: "none",
  });
  const main = require(path.join(directory, "main", "index.js"));
  const html = await main.renderLocalMarkdownAsync(Buffer.from("# Packaged Worker\n\n- [x] ready"), "packaged.md");
  assert.match(html, /<h1>Packaged Worker<\/h1>/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/>/);
});
