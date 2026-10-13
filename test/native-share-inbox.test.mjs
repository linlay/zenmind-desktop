import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const compiledRoot = process.env.NATIVE_SHARE_COMPILED_ROOT || path.resolve("dist-electron");
const { NativeShareController } = require(path.join(compiledRoot, "main/modules/native-share/index.js"));
const { NATIVE_SHARE_CHUNK_BYTES, NATIVE_SHARE_MAX_BYTES, NATIVE_SHARE_MAX_FILES } = require(path.join(compiledRoot, "shared/native-share.js"));
const batchId = "12345678-1234-4234-8234-123456789abc";
const anotherBatchId = "22345678-1234-4234-8234-123456789abc";

function fixture(t, { platform = "darwin", defaultAgentKey = "xiaojun", nestedInbox = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cutej-share-inbox-")));
  const bundleId = "com.example.cutej.dev";
  const inbox = nestedInbox
    ? path.join(root, ".cutej", ".desktop", "data", "native-share")
    : path.join(root, "ShareInbox");
  fs.mkdirSync(inbox, { recursive: true });
  const shown = [];
  const diagnostics = [];
  let active = null;
  const options = {
    platform, homePath: root, bundleId,
    inbox,
    getDefaultAgentKey: () => defaultAgentKey,
    showMainWindow(route) {
      shown.push(route);
      const url = new URL(route, "https://desktop.test");
      active = {
        batchId: url.searchParams.get("shareBatch"), newChat: url.searchParams.get("newChat"),
        agentKey: decodeURIComponent(url.pathname.slice("/agent/".length))
      };
    },
    isTargetActive(target) {
      return !!active && target.batchId === active.batchId && target.newChat === active.newChat && target.agentKey === active.agentKey;
    },
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); }
  };
  const controller = new NativeShareController(options);
  t.after(() => { controller.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  function batch(files = [{ name: "微信聊天记录.zip", bytes: Buffer.from("shared chat") }], id = batchId) {
    const directory = path.join(inbox, id);
    fs.mkdirSync(directory, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(directory, file.name), file.bytes);
    const manifest = { version: 1, id, files: files.map(file => ({ name: file.name, sizeBytes: file.bytes.length })) };
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    return { directory, manifest, writeManifest(value) { fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(value)); } };
  }
  const request = (operation, fields = {}) => controller.read({ ...active, operation, ...fields });
  return { root, inbox, options, controller, shown, diagnostics, batch, request, target: () => ({ ...active }), setActive(value) { active = value; } };
}

function assertFailure(result, code) {
  assert.equal(result.ok, false);
  if (code) assert.equal(result.code, code);
  assert.equal("dataBase64" in result, false);
  assert.doesNotMatch(result.message, /\/Users\/|\/private\/|ShareInbox\/|Library\/Containers/u);
}

test("macOS uses Desktop-owned storage, creates an editable draft and never returns local paths", async t => {
  const f = fixture(t, { nestedInbox: true });
  const source = f.batch([{ name: "聊天记录.ZIP", bytes: Buffer.from("zip content") }, { name: "备注.txt", bytes: Buffer.alloc(0) }]);
  await f.controller.open(batchId);
  assert.equal(f.shown.length, 1);
  assert.match(f.shown[0], new RegExp(`^/agent/xiaojun\\?newChat=[1-9]\\d{12}&shareBatch=${batchId}$`, "u"));
  const result = await f.request("describe");
  assert.deepEqual(result, { ok: true, batchId, files: [
    { name: "聊天记录.ZIP", sizeBytes: 11, mimeType: "application/zip" },
    { name: "备注.txt", sizeBytes: 0, mimeType: "text/plain" }
  ] });
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(fs.existsSync(path.join(source.directory, ".completed.json")), false);
});

test("Windows native sharing performs no inbox access or navigation", async t => {
  const f = fixture(t, { platform: "win32" });
  fs.rmSync(f.inbox, { recursive: true });
  await f.controller.open(batchId);
  await f.controller.open("../../anything");
  assert.deepEqual(f.shown, []);
  assertFailure(await f.controller.read({ operation: "describe", batchId, newChat: "1700000000001", agentKey: "xiaojun" }), "unsupported_platform");
  assert.equal(fs.existsSync(f.inbox), false);
});

test("each pending share keeps its nonce, default Agent and read lane when another batch is opened", async t => {
  const f = fixture(t);
  f.batch();
  f.batch([{ name: "second.txt", bytes: Buffer.from("second") }], anotherBatchId);
  await f.controller.open(batchId);
  const original = f.target();
  await f.controller.open(anotherBatchId);
  const another = f.target();
  assert.notEqual(original.newChat, another.newChat);
  assertFailure(await f.controller.read({ ...original, operation: "describe" }), "stale_target");
  await f.controller.open(batchId);
  assert.deepEqual(f.target(), original);
  assert.equal((await f.request("describe")).ok, true);
  assertFailure(await f.controller.read({ ...original, newChat: another.newChat, operation: "describe" }), "not_open");
  assertFailure(await f.controller.read({ ...original, agentKey: "another-agent", operation: "describe" }), "not_open");
});

test("a batch cannot complete by jumping to EOF; every file must be read and original files remain", async t => {
  const f = fixture(t);
  const bytes = Buffer.alloc(NATIVE_SHARE_CHUNK_BYTES + 7, 0x41);
  const source = f.batch([{ name: "large.zip", bytes }, { name: "empty.txt", bytes: Buffer.alloc(0) }]);
  await f.controller.open(batchId);
  assertFailure(await f.request("read", { fileIndex: 0, offset: NATIVE_SHARE_CHUNK_BYTES }), "invalid_request");
  assertFailure(await f.request("complete"), "incomplete");
  const first = await f.request("read", { fileIndex: 0, offset: 0 });
  assert.equal(first.eof, false);
  assert.equal(Buffer.from(first.dataBase64, "base64").length, NATIVE_SHARE_CHUNK_BYTES);
  assert.deepEqual(await f.request("read", { fileIndex: 0, offset: 0 }), first, "a lost chunk response can be retried");
  const last = await f.request("read", { fileIndex: 0, offset: NATIVE_SHARE_CHUNK_BYTES });
  assert.equal(last.eof, true);
  assert.equal(Buffer.from(last.dataBase64, "base64").toString(), "AAAAAAA");
  assertFailure(await f.request("complete"), "incomplete");
  assert.deepEqual(await f.request("read", { fileIndex: 1, offset: 0 }), { ok: true, dataBase64: "", eof: true });
  assert.deepEqual(await f.request("complete"), { ok: true, completed: true });
  assert.deepEqual(await f.request("complete"), { ok: true, completed: true }, "a lost complete response can be retried for the same target");
  const receipt = JSON.parse(fs.readFileSync(path.join(source.directory, ".completed.json"), "utf8"));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.id, batchId);
  assert.equal(typeof receipt.completedAt, "number");
  assert.deepEqual(fs.readFileSync(path.join(source.directory, "large.zip")), bytes);
  assert.deepEqual(fs.readdirSync(source.directory).sort(), [".completed.json", "empty.txt", "large.zip", "manifest.json"]);
  assert.equal((await f.request("describe")).ok, true, "the original active draft can recover after a lost acknowledgement");
  assert.deepEqual(await f.request("read", { fileIndex: 0, offset: 0 }), first);
  await assert.rejects(f.controller.open(batchId), { code: "already_completed" });
  const restarted = new NativeShareController(f.options);
  t.after(() => restarted.dispose());
  await assert.rejects(restarted.open(batchId), { code: "already_completed" });
});

test("describe restarts incomplete file reads after a guest refresh without replacing the draft", async t => {
  const f = fixture(t);
  const source = f.batch([{ name: "chat.zip", bytes: Buffer.alloc(NATIVE_SHARE_CHUNK_BYTES + 1, 0x42) }]);
  await f.controller.open(batchId);
  const target = f.target();
  assert.equal((await f.request("read", { fileIndex: 0, offset: 0 })).ok, true);
  assert.equal((await f.request("describe")).ok, true);
  assertFailure(await f.request("read", { fileIndex: 0, offset: NATIVE_SHARE_CHUNK_BYTES }), "invalid_request");
  const [first, last] = await Promise.all([
    f.request("read", { fileIndex: 0, offset: 0 }),
    f.request("read", { fileIndex: 0, offset: NATIVE_SHARE_CHUNK_BYTES })
  ]);
  assert.equal(first.eof, false);
  assert.equal(last.eof, true);
  await f.controller.open(batchId);
  assert.deepEqual(f.target(), target);
  assert.equal(fs.existsSync(path.join(source.directory, ".completed.json")), false);
  assert.equal((await f.request("describe")).ok, true);
  assertFailure(await f.request("complete"), "incomplete", "resetting a descriptor cannot forge a receipt");
});

test("path-like identifiers and unfinished staging batches never navigate or get read", async t => {
  for (const id of ["../outside", `${batchId}.partial`, `${batchId}/child`, batchId.toUpperCase(), "not-a-uuid"]) {
    const f = fixture(t);
    f.batch();
    await assert.rejects(f.controller.open(id), { code: "invalid_request" });
    assert.deepEqual(f.shown, []);
  }
  const f = fixture(t);
  const source = f.batch();
  fs.renameSync(source.directory, `${source.directory}.partial`);
  await assert.rejects(f.controller.open(batchId));
  assert.deepEqual(f.shown, []);
  assert.equal(fs.existsSync(`${source.directory}.partial`), true);
});

test("manifest rejects traversal, control characters, reserved names and filesystem-equivalent duplicates", async t => {
  const invalidNames = ["..", ".", "../secret", "nested/file", "nested\\file", "bad\0name", "bad\u0085name", "manifest.json", "MANIFEST.JSON", ".completed.json", "中".repeat(81)];
  for (const name of invalidNames) {
    const f = fixture(t);
    const source = f.batch();
    source.writeManifest({ ...source.manifest, files: [{ name, sizeBytes: 0 }] });
    await assert.rejects(f.controller.open(batchId), { code: "invalid_batch" });
    assert.deepEqual(f.shown, []);
  }
  for (const names of [["Chat.zip", "chat.zip"], ["é.txt", "e\u0301.txt"]]) {
    const f = fixture(t);
    const source = f.batch();
    source.writeManifest({ ...source.manifest, files: names.map(name => ({ name, sizeBytes: 0 })) });
    await assert.rejects(f.controller.open(batchId), { code: "invalid_batch" });
  }
});

test("manifest version, identity, declared sizes, total budget and descriptor count are bounded", async t => {
  const invalidManifests = [
    { version: 2, id: batchId, files: [] },
    { version: 1, id: anotherBatchId, files: [{ name: "微信聊天记录.zip", sizeBytes: 11 }] },
    { version: 1, id: batchId, files: [] },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NATIVE_SHARE_MAX_BYTES + 1, 1234].map(sizeBytes => ({
      version: 1, id: batchId, files: [{ name: "微信聊天记录.zip", sizeBytes }]
    })),
    { version: 1, id: batchId, files: Array.from({ length: NATIVE_SHARE_MAX_FILES + 1 }, (_, index) => ({ name: `file-${index}.txt`, sizeBytes: 0 })) },
    { version: 1, id: batchId, files: [{ name: "part-one.zip", sizeBytes: NATIVE_SHARE_MAX_BYTES }, { name: "part-two.zip", sizeBytes: 1 }] }
  ];
  for (const manifest of invalidManifests) {
    const f = fixture(t);
    const source = f.batch();
    source.writeManifest(manifest);
    await assert.rejects(f.controller.open(batchId), { code: "invalid_batch" });
    assert.deepEqual(f.shown, []);
  }
  const f = fixture(t);
  const source = f.batch();
  source.writeManifest({ ...source.manifest, extra: "x".repeat(64 * 1024) });
  await assert.rejects(f.controller.open(batchId), { code: "invalid_batch" });
});

test("root, batch, manifest, file and completion-marker symlinks cannot read an external source", async t => {
  for (const component of ["root", "batch", "manifest", "file", "receipt"]) {
    const f = fixture(t);
    const source = f.batch();
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.zip"), "secret");
    let linkPath;
    let target;
    if (component === "root" || component === "batch") {
      linkPath = component === "root" ? f.inbox : source.directory;
      target = `${linkPath}.moved`;
      fs.renameSync(linkPath, target);
    } else {
      linkPath = path.join(source.directory, component === "manifest" ? "manifest.json" : component === "receipt" ? ".completed.json" : "微信聊天记录.zip");
      target = component === "manifest" ? path.join(outside, "manifest.json") : path.join(outside, "secret.zip");
      if (component === "manifest") fs.writeFileSync(target, JSON.stringify(source.manifest));
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    }
    fs.symlinkSync(target, linkPath);
    await assert.rejects(f.controller.open(batchId));
    assert.deepEqual(f.shown, []);
    assert.equal(fs.readFileSync(path.join(outside, "secret.zip"), "utf8"), "secret");
  }
});

test("hard links, directories and missing files are not accepted as extension-owned attachments", async t => {
  for (const kind of ["hardlink", "directory", "missing"]) {
    const f = fixture(t);
    const source = f.batch();
    const file = path.join(source.directory, "微信聊天记录.zip");
    fs.unlinkSync(file);
    if (kind === "directory") fs.mkdirSync(file);
    if (kind === "hardlink") {
      const outside = path.join(f.root, "secret.zip");
      fs.writeFileSync(outside, "shared chat");
      fs.linkSync(outside, file);
    }
    await assert.rejects(f.controller.open(batchId));
    assert.deepEqual(f.shown, []);
  }
});

test("same-size file replacement, manifest edits and batch directory replacement invalidate an open batch", async t => {
  for (const component of ["file", "manifest", "batch"]) {
    const f = fixture(t);
    const source = f.batch();
    await f.controller.open(batchId);
    if (component === "file") {
      const file = path.join(source.directory, "微信聊天记录.zip");
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, "replacement");
    } else if (component === "manifest") {
      source.writeManifest({ ...source.manifest, changed: true });
    } else {
      fs.renameSync(source.directory, `${source.directory}.old`);
      f.batch();
    }
    assertFailure(await f.request("read", { fileIndex: 0, offset: 0 }), "changed_file");
    assert.equal(fs.existsSync(path.join(source.directory, ".completed.json")), false);
  }
});

test("replacing a file with a symlink at open time yields no bytes", async t => {
  const f = fixture(t);
  const source = f.batch();
  await f.controller.open(batchId);
  const file = path.join(source.directory, "微信聊天记录.zip");
  const outside = path.join(f.root, "secret.zip");
  fs.writeFileSync(outside, "secret data");
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async (openedPath, ...args) => {
    if (!replaced && openedPath === file) {
      replaced = true;
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
    }
    return originalOpen.call(fs.promises, openedPath, ...args);
  };
  try { assertFailure(await f.request("read", { fileIndex: 0, offset: 0 })); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(outside, "utf8"), "secret data");
});

test("revoking the active Chat during an awaited file read drops its bytes and allows a later retry", async t => {
  const f = fixture(t);
  const source = f.batch();
  await f.controller.open(batchId);
  const target = f.target();
  const file = path.join(source.directory, "微信聊天记录.zip");
  const originalOpen = fs.promises.open;
  fs.promises.open = async (openedPath, ...args) => {
    const handle = await originalOpen.call(fs.promises, openedPath, ...args);
    if (openedPath === file) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const result = await originalRead(...readArgs); f.setActive(null); return result; };
    }
    return handle;
  };
  try { assertFailure(await f.request("read", { fileIndex: 0, offset: 0 }), "stale_target"); }
  finally { fs.promises.open = originalOpen; }
  f.setActive(target);
  assert.deepEqual(await f.request("read", { fileIndex: 0, offset: 0 }), {
    ok: true, dataBase64: Buffer.from("shared chat").toString("base64"), eof: true
  });
});

test("failed receipt creation preserves the batch and can be retried without reading a different source", async t => {
  const f = fixture(t);
  const source = f.batch();
  await f.controller.open(batchId);
  assert.equal((await f.request("read", { fileIndex: 0, offset: 0 })).eof, true);
  const originalLink = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error(`denied: ${source.directory}`), { code: "EACCES" }); };
  try { assertFailure(await f.request("complete"), "io_error"); }
  finally { fs.promises.link = originalLink; }
  assert.equal(fs.readFileSync(path.join(source.directory, "微信聊天记录.zip"), "utf8"), "shared chat");
  assert.deepEqual(fs.readdirSync(source.directory).sort(), ["manifest.json", "微信聊天记录.zip"]);
  assert.deepEqual(await f.request("complete"), { ok: true, completed: true });
});

test("requests reject arbitrary paths, unsafe offsets and indices rather than broadening file access", async t => {
  const f = fixture(t);
  f.batch();
  await f.controller.open(batchId);
  const invalidReads = [
    { fileIndex: -1, offset: 0 }, { fileIndex: 1, offset: 0 }, { fileIndex: 0.5, offset: 0 },
    { fileIndex: 0, offset: -1 }, { fileIndex: 0, offset: 0.5 }, { fileIndex: 0, offset: Number.MAX_SAFE_INTEGER + 1 },
    { fileIndex: 0, offset: 0, path: "/etc/passwd" }
  ];
  for (const fields of invalidReads) assertFailure(await f.request("read", fields), "invalid_request");
  f.controller.dispose();
  assertFailure(await f.request("describe"), "not_open");
  assert.equal(fs.existsSync(path.join(f.inbox, batchId, "微信聊天记录.zip")), true);
});

test("a receipt committed before an acknowledgement failure can be confirmed again by the same target", async t => {
  const f = fixture(t);
  const source = f.batch();
  await f.controller.open(batchId);
  assert.equal((await f.request("read", { fileIndex: 0, offset: 0 })).eof, true);
  const originalOpen = fs.promises.open;
  fs.promises.open = async (openedPath, ...args) => {
    const handle = await originalOpen.call(fs.promises, openedPath, ...args);
    if (openedPath === source.directory) handle.sync = async () => { throw Error("directory sync failed after commit"); };
    return handle;
  };
  try { assertFailure(await f.request("complete"), "io_error"); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(fs.existsSync(path.join(source.directory, ".completed.json")), true);
  assert.equal((await f.request("describe")).ok, true, "a refreshed guest can restore files after receipt sync failure");
  assert.deepEqual(await f.request("read", { fileIndex: 0, offset: 0 }), {
    ok: true, dataBase64: Buffer.from("shared chat").toString("base64"), eof: true
  });
  assert.deepEqual(await f.request("complete"), { ok: true, completed: true });
  assert.deepEqual(await f.request("complete"), { ok: true, completed: true });
  assert.equal(fs.readFileSync(path.join(source.directory, "微信聊天记录.zip"), "utf8"), "shared chat");
  f.setActive({ ...f.target(), newChat: "1700000000000" });
  assertFailure(await f.controller.read({ ...f.target(), operation: "complete" }), "not_open");
});

test("Main errno diagnostics preserve operation and syscall while omitting source data and paths", async t => {
  const f = fixture(t);
  const source = f.batch();
  const originalStat = fs.promises.lstat;
  fs.promises.lstat = async () => {
    throw Object.assign(new Error(`denied: ${source.directory}/private-chat.zip`), { code: "EPERM", syscall: "lstat", path: source.directory });
  };
  try { await assert.rejects(f.controller.open(batchId), { code: "io_error", message: "The shared files could not be accessed." }); }
  finally { fs.promises.lstat = originalStat; }
  assert.deepEqual(f.diagnostics, [{ operation: "open", code: "EPERM", syscall: "lstat" }]);
  await f.controller.open(batchId);
  const originalOpen = fs.promises.open;
  fs.promises.open = async () => {
    throw Object.assign(new Error(`denied: ${source.directory}/private-chat.zip`), { code: "EACCES", syscall: "open", path: source.directory });
  };
  try { assertFailure(await f.request("read", { fileIndex: 0, offset: 0 }), "io_error"); }
  finally { fs.promises.open = originalOpen; }
  assert.deepEqual(f.diagnostics.at(-1), { operation: "read", code: "EACCES", syscall: "open" });
  assert.equal(JSON.stringify(f.diagnostics).includes(f.root), false);
  assert.equal(JSON.stringify(f.diagnostics).includes("private-chat"), false);
  f.options.onDiagnostic = () => { throw Error("diagnostic observer failed"); };
  assertFailure(await f.request("read", { fileIndex: -1, offset: 0 }), "invalid_request");
});
