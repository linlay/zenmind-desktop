import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DesktopPetPreviewProjector } = require("../dist-electron/main/modules/pet/desktop-pet-preview.js");
const timestamp = 1_788_000_000_000;
const event = (type, fields = {}) => ({ type, runId: "run-1", chatId: "chat-1", timestamp, ...fields });

test("pet preview accumulates public content and keeps the reply on completion", () => {
  const projector = new DesktopPetPreviewProjector();
  projector.ingest(event("run.start"));
  assert.equal(projector.ingest(event("content.delta", { delta: "Hello", seq: 1 })).refresh, "throttled");
  const next = event("content.delta", { delta: ", world!", seq: 2 });
  assert.equal(projector.ingest(next).panel.summary, "Hello, world!");
  assert.equal(projector.ingest(next).changed, false);
  const ended = projector.ingest(event("content.end", { seq: 3 }));
  assert.equal(ended.refresh, "immediate");
  assert.equal(ended.panel.items.find((item) => item.id === "content").status, "success");
  const done = projector.ingest(event("run.complete", { seq: 4 }));
  assert.equal(done.panel.summary, "Hello, world!");
  assert.equal(done.panel.status, "done");
  assert.ok(done.holdMs > 0);
});

test("unsupported detail and activity events never create or refresh a pet preview", () => {
  const projector = new DesktopPetPreviewProjector();
  const ignored = ["reasoning.start", "reasoning.delta", "reasoning.end", "reasoning.snapshot", "tool.start", "tool.args", "tool.result", "tool.end", "run.activity"];
  for (const type of ignored) {
    assert.deepEqual(projector.ingest(event(type, { message: "Internal detail", delta: "detail" })), {
      changed: false, panel: null, refresh: "none"
    });
  }
  projector.ingest(event("content.snapshot", { text: "Public reply" }));
  const panel = projector.getPanel();
  const before = structuredClone(panel);
  for (const type of ignored) {
    const result = projector.ingest(event(type, { message: "Internal detail", timestamp: timestamp + 100 }));
    assert.equal(result.changed, false);
    assert.equal(result.refresh, "none");
    assert.equal(result.panel, panel);
    assert.deepEqual(result.panel, before);
  }
});
