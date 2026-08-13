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

test("private Kanban reruns prefer the issue's existing chat", () => {
  const { resolvePrivateKanbanRunChatId } = loadKanbanAssistantRunModule();

  assert.equal(resolvePrivateKanbanRunChatId({
    chatId: " chat-existing ",
    attachmentChatId: "chat-attachments",
    attachments: [{ id: "attachment-1" }]
  }), "chat-existing");
});

test("private Kanban runs fall back to the attachment chat only when attachments exist", () => {
  const { resolvePrivateKanbanRunChatId } = loadKanbanAssistantRunModule();

  assert.equal(resolvePrivateKanbanRunChatId({
    chatId: null,
    attachmentChatId: " chat-attachments ",
    attachments: [{ id: "attachment-1" }]
  }), "chat-attachments");
  assert.equal(resolvePrivateKanbanRunChatId({
    chatId: null,
    attachmentChatId: "chat-attachments",
    attachments: []
  }), undefined);
  assert.equal(resolvePrivateKanbanRunChatId({
    chatId: null,
    attachmentChatId: null,
    attachments: []
  }), undefined);
});
