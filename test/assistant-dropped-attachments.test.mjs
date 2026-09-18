import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { registerAssistantIpcHandlers } = require("../dist-electron/main/modules/assistant/ipc.js");

function fixture(platform) {
  const handlers = new Map();
  const frame = {};
  const sender = { mainFrame: frame };
  const calls = [];
  registerAssistantIpcHandlers({ handle: (name, fn) => handlers.set(name, fn) }, {
    platform, mainWindow: { webContents: sender },
    createAssistantAttachmentsFromFiles: async (_app, chatId, paths) => {
      calls.push({ chatId, paths });
      return { ok: true, chatId, attachments: paths.map((name) => ({ name })) };
    }
  });
  return { handler: handlers.get("assistant.addDroppedAttachments"), event: { sender, senderFrame: frame }, calls };
}

for (const [platform, file] of [["darwin", "/Users/test/资料 file.txt"], ["win32", "C:\\Users\\test\\资料 file.txt"]]) {
  test(`${platform}: native drops reuse attachment ingestion and deduplicate each batch`, async () => {
    const { handler, event, calls } = fixture(platform);
    const result = await handler(event, "kanban-issue-local-1", [file, file]);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ chatId: "kanban-issue-local-1", paths: [file] }]);
  });
}

test("drop ingestion rejects guests, subframes and invalid paths before reading files", async () => {
  const { handler, event, calls } = fixture("darwin");
  await assert.rejects(handler({ sender: {}, senderFrame: event.senderFrame }, "chat", ["/tmp/a"]));
  await assert.rejects(handler({ sender: event.sender, senderFrame: {} }, "chat", ["/tmp/a"]));
  for (const paths of [[], [""], ["relative.txt"], [null], "file:///tmp/a"]) {
    await assert.rejects(handler(event, "chat", paths));
  }
  await assert.rejects(handler(event, {}, ["/tmp/a"]));
  assert.equal(calls.length, 0);
});
