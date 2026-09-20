import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ArtifactStore, parseArtifactPush, getArtifactDatabasePath } = require("../dist-electron/main/modules/artifacts/store.js");
const { createArtifactRuntime } = require("../dist-electron/main/modules/artifacts/index.js");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const event = (data = {}) => ({ frame: "push", type: "resource.pushed", data: {
  chatId: "chat-1", artifactId: "artifact-1", name: "report.md", mimeType: "text/markdown", sizeBytes: 123,
  sha256: "a".repeat(64), pushedAt: 1_800_000_000_000, ...data,
} });
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-artifact-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, app: { getPath: () => home } };
}
test("only complete artifact metadata on a resource push is accepted", () => {
  assert.equal(parseArtifactPush(event()).artifactId, "artifact-1");
  assert.equal(parseArtifactPush({ ...event(), frame: "event", type: "artifact.publish" }), null);
  for (const data of [{ artifactId: "" }, { chatId: "" }, { name: "" }, { sizeBytes: -1 }, { sizeBytes: 1.2 },
    { pushedAt: "2026-09-17" }, { pushedAt: 1_800_000_000 }, { name: "bad\u0000name" }]) {
    assert.equal(parseArtifactPush(event(data)), null);
  }
  assert.equal(parseArtifactPush({ frame: "push", type: "resource.pushed", payload: event().data }).name, "report.md");
});
for (const platform of ["darwin", "win32"]) {
  test(`artifact index persists in the Desktop data partition on ${platform}`, (t) => {
    const { app, home } = setup(t);
    const filename = getArtifactDatabasePath(app, platform);
    assert.equal(filename, path.join(home, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir, "data", "artifacts.db"));
    const store = new ArtifactStore(() => filename);
    assert.equal(store.ingest(event()), true);
    assert.equal(store.ingest(event()), false);
    assert.equal(store.ingest(event({ name: "stale.md", pushedAt: 1_799_999_999_999 })), false);
    assert.equal(store.ingest(event({ name: "new.md", pushedAt: 1_800_000_000_001 })), true);
    store.ingest(event({ chatId: "chat-2", name: "100%_done.md" }));
    const restored = new ArtifactStore(() => filename);
    assert.equal(restored.list().total, 2);
    assert.equal(restored.list().records[0].name, "new.md");
    assert.equal(restored.list({ search: "%_" }).records[0].chatId, "chat-2");
    assert.equal(restored.list({ search: "' OR 1=1 --" }).total, 0);
    assert.equal(restored.list({ offset: 1, limit: 1 }).records.length, 1);
    assert.match(fs.readFileSync(filename).subarray(0, 16).toString(), /^SQLite format 3/u);
  });
}

test("main Push subscription records while the page is closed, restricts IPC and cleans up", async (t) => {
  const { app, home } = setup(t);
  let consumer, stopped = false;
  const handlers = new Map();
  const sent = [];
  const mainFrame = {};
  const webContents = { mainFrame, send: (...args) => sent.push(args) };
  let window = null;
  const errors = [];
  const runtime = createArtifactRuntime({ app, platform: "darwin",
    broker: { subscribePush: (options) => { consumer = options; return () => { stopped = true; }; } },
    ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) },
    getMainWindow: () => window, onError: error => errors.push(error),
  });
  t.after(() => runtime.dispose());
  assert.deepEqual(fs.readdirSync(home), []); // Factory must not change first-install detection.
  assert.deepEqual(consumer.types, ["artifact.published", "resource.pushed"]);
  assert.equal(consumer.kind, "internal");
  consumer.onPush(event());
  window = { isDestroyed: () => false, webContents };
  const list = handlers.get("artifacts.list");
  const trusted = { sender: webContents, senderFrame: mainFrame };
  assert.equal(list(trusted, {}).total, 1);
  assert.throws(() => list({ sender: {}, senderFrame: mainFrame }, {}), /denied/);
  assert.throws(() => list({ sender: webContents, senderFrame: {} }, {}), /denied/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "artifacts.changed");
  assert.equal(errors.length, 0);
  runtime.dispose();
  assert.equal(stopped, true);
  assert.equal(handlers.size, 0);
});

test("primary artifact.publish records every valid item without a gateway upload", (t) => {
  const { home } = setup(t);
  const store = new ArtifactStore(() => path.join(home, 'artifacts.db'));
  const { RealtimeBroker_consumeRunEvent_5: consume } = require('../dist-electron/main/modules/agent-platform/realtime/realtime-broker.methods-4.js');
  const published = { type: 'artifact.publish', seq: 1, chatId: 'chat-1', runId: 'run-1', timestamp: 1_800_000_000_000,
    artifacts: [event().data, { ...event().data, artifactId: 'artifact-2', name: 'second.md' }, { artifactId: 'invalid' }] };
  const errors = [];
  const broker = { options: { onArtifactPublished: value => store.ingestPublished(value), onDiagnostic: value => errors.push(value) },
    diagnostics: { seqRegressionCount: 0, seqGapCount: 0 }, appendReplay() {}, runSubscriptions: new Map() };
  const run = { lane: 'primary', chatId: 'chat-1', runId: 'run-1', lastSeq: 0, subscribers: new Set() };
  consume(broker, run, published, null);
  assert.equal(store.list().total, 2);
  consume(broker, run, published, null);
  assert.equal(store.list().total, 2);
  assert.equal(store.ingest(event()), false);
  consume(broker, { ...run, lane: 'btw', lastSeq: 0 }, { ...published, artifacts: [{ ...event().data, artifactId: 'btw' }] }, null);
  assert.equal(store.list().total, 2);
  assert.throws(() => consume(broker, run, { ...published, seq: 2, chatId: 'wrong' }, null), /chatId conflicts/);
  assert.throws(() => consume(broker, run, { ...published, seq: 2, timestamp: 1_800_000_000 }, null));
  broker.options.onArtifactPublished = () => { throw new Error('database unavailable'); };
  assert.doesNotThrow(() => consume(broker, run, { ...published, seq: 2 }, null));
  assert.deepEqual(errors, ['artifact_index_delivery_failed']);
});

const publication = (data = {}) => ({ frame: "push", type: "artifact.published", data: {
  ...event().data, pushedAt: undefined, runId: "background-run", publishedAt: 1_800_000_000_000, ...data,
} });

test("publication push uses publishedAt and validates identity independently of file format", () => {
  for (const name of ["a.md", "a.png", "a.html", "a.docx", "a.xlsx", "a.pptx"]) {
    assert.equal(parseArtifactPush(publication({ name })).name, name);
  }
  for (const data of [{ runId: "" }, { publishedAt: undefined }, { publishedAt: 1_800_000_000 }, { sizeBytes: -1 }]) {
    assert.equal(parseArtifactPush(publication(data)), null);
  }
  assert.equal(parseArtifactPush({ ...publication(), frame: "stream" }), null);
  assert.equal(parseArtifactPush(publication()).pushedAt, 1_800_000_000_000);
});

test("Main publication push reaches the index with no Run channel or mounted page", (t) => {
  const { app } = setup(t);
  const { RealtimeBroker_handlePush_1: handlePush } = require('../dist-electron/main/modules/agent-platform/realtime/realtime-broker.methods-5.js');
  const subscriptions = new Map();
  const diagnostics = [];
  // Deliberately no runChannels or active surface: delivery must be global.
  const broker = { options: { onDiagnostic: value => diagnostics.push(value) }, diagnostics: { unknownFrameCount: 0 }, pushSubscriptions: subscriptions };
  const runtime = createArtifactRuntime({ app, platform: "darwin",
    broker: { subscribePush: (input) => { subscriptions.set("artifacts", { ...input, types: new Set(input.types) }); return () => subscriptions.clear(); } },
    ipcMain: { handle() {}, removeHandler() {} }, getMainWindow: () => null,
    onError: error => { throw error; },
  });
  t.after(() => runtime.dispose());
  const store = new ArtifactStore(() => getArtifactDatabasePath(app, "darwin"));
  const png = publication({ name: "image.png", mimeType: "image/png", sizeBytes: 1523175 });
  handlePush(broker, png);
  handlePush(broker, png);
  handlePush(broker, event({ name: "image.png", mimeType: "image/png", sizeBytes: 1523175 }));
  assert.equal(store.list().total, 1);
  assert.equal(store.list().records[0].name, "image.png");
  handlePush(broker, publication({ publishedAt: 1_799_999_999_999, name: "stale.png" }));
  assert.equal(store.list().records[0].name, "image.png");
  handlePush(broker, publication({ artifactId: "bad", publishedAt: 1_800_000_000 }));
  assert.equal(store.list().total, 1);
  assert.equal(broker.diagnostics.unknownFrameCount, 0);
  assert.equal(diagnostics.length, 1);
});
