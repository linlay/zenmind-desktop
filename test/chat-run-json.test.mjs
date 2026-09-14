import test from "node:test";
import assert from "node:assert/strict";
import { selectChatRunJson } from "../dist-electron/main/modules/assistant/chat-run-json.js";

test("run JSON retains all matching records including unknown fields and excludes other runs", () => {
  const records = [
    { _type: "chat", chatId: "c" },
    { _type: "query", runId: "r1", input: "hello" },
    { _type: "react", runId: "r2", messages: [] },
    { _type: "react", runId: "r1", messages: [{ content: "answer" }], extra: { value: 1 } },
    { _type: "run", runId: "r1", completedAt: 1234 },
  ];
  assert.deepEqual(JSON.parse(selectChatRunJson(records.map(JSON.stringify).join("\r\n") + "\n", "r1")), [records[1], records[3], records[4]]);
});

test("run JSON fails on missing runs or malformed records instead of copying incomplete data", () => {
  assert.throws(() => selectChatRunJson('{"runId":"r2"}', "r1"));
  assert.throws(() => selectChatRunJson('{"runId":"r1"}\n{broken', "r1"));
  assert.throws(() => selectChatRunJson('', ''));
});
