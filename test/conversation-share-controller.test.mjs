import test from "node:test";
import assert from "node:assert/strict";
const { createConversationShare } = await import("../dist-electron/main/modules/conversation-share/controller.js");
const limits = { maxManifestBytes: 4096, maxResourceBytes: 1024 };
const record = { id: "opaque_abc", kind: "conversation", title: "Frozen", url: "https://share.example.test/share/opaque_abc", createdAt: 1786363200000, lastAccessedAt: null };

for (const unauthorized of [false, true]) test(`conversation preparation forwards bytes without Main JSON parsing (unauthorized=${unauthorized})`, async () => {
  const manifest = Buffer.from('{"opaque":"already prepared by worker"}');
  const resources = [{ id: "a".repeat(24), name: "report.txt", mimeType: "text/plain", bytes: Buffer.from("data") }];
  let preparedCount = 0;
  const result = await createConversationShare({ async prepareChatShare(chatId, actualLimits) {
    assert.equal(chatId, "chat-1"); assert.equal(actualLimits, limits); preparedCount++;
    return { ok: true, bytes: manifest, attachments: resources, attachmentsOmitted: true, attachmentUnauthorized: unauthorized };
  } }, { async publish(prepare) {
    const value = await prepare(limits);
    assert.equal(value.manifest, manifest); assert.equal(value.resources, resources);
    assert.match(value.warning, unauthorized ? /身份|identity/iu : /附件|attachment/iu);
    return { ok: true, record, warning: value.warning };
  } }, { chatId: " chat-1 " });
  assert.equal(result.ok, true); assert.equal(result.record, record); assert.equal(preparedCount, 1);
});

test("invalid conversation ID never invokes public publishing", async () => {
  const never = () => assert.fail("must not prepare or publish");
  for (const chatId of ["", "x".repeat(256), "bad\nID"]) {
    const result = await createConversationShare({ prepareChatShare: never }, { publish: never }, { chatId });
    assert.equal(result.ok, false);
  }
});

test("preparation failure stays local to the business adapter", async () => {
  const result = await createConversationShare({ prepareChatShare: async () => ({ ok: false, message: "snapshot unavailable" }) }, {
    publish: (prepare) => prepare(limits),
  }, { chatId: "chat" });
  assert.deepEqual(result, { ok: false, message: "snapshot unavailable" });
});
