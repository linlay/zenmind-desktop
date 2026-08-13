import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadKanbanAssistantRunModule() {
  const sourcePath = path.resolve("src/renderer/pages/kanban/kanbanAssistantRun.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: sourcePath });
  return module.exports;
}

test("local Kanban reruns prefer the issue's existing chat", () => {
  const { resolveLocalKanbanRunChatId } = loadKanbanAssistantRunModule();

  assert.equal(resolveLocalKanbanRunChatId({
    chatId: " chat-existing ",
    attachmentChatId: "chat-attachments",
    attachments: [{ id: "attachment-1" }]
  }), "chat-existing");
});

test("local Kanban runs fall back to the attachment chat only when attachments exist", () => {
  const { resolveLocalKanbanRunChatId } = loadKanbanAssistantRunModule();

  assert.equal(resolveLocalKanbanRunChatId({
    chatId: null,
    attachmentChatId: " chat-attachments ",
    attachments: [{ id: "attachment-1" }]
  }), "chat-attachments");
  assert.equal(resolveLocalKanbanRunChatId({
    chatId: null,
    attachmentChatId: "chat-attachments",
    attachments: []
  }), undefined);
  assert.equal(resolveLocalKanbanRunChatId({
    chatId: null,
    attachmentChatId: null,
    attachments: []
  }), undefined);
});
