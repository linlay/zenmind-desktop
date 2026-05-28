import test from "node:test";
import assert from "node:assert/strict";

const { registerTaskBoardIpcHandlers } = await import("../dist-electron/main/ipc/task-board-handlers.js");

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: { handle(channel, cb) { handlers[channel] = cb; } },
    handlers
  };
}

function makeBaseOptions(overrides = {}) {
  return {
    app: {},
    // task board
    listTaskBoardIssues: async () => ({ items: [] }),
    createTaskBoardIssue: async () => ({ ok: true }),
    updateTaskBoardIssue: async () => ({ ok: true }),
    deleteTaskBoardIssueWithAutomation: async () => ({ ok: true }),
    moveTaskBoardIssue: async () => ({ ok: true }),
    syncTaskBoardIssueAutomation: async () => ({ ok: true }),
    callAgentPlatform: async () => ({}),
    // custom sidebar
    listCustomSidebarItems: () => ({ ok: true, items: [] }),
    addCustomSidebarItem: async () => ({ ok: true }),
    updateCustomSidebarItem: async () => ({ ok: true }),
    removeCustomSidebarItem: async () => ({ ok: true }),
    importCustomSidebarItems: () => ({ ok: true, items: [] }),
    exportCustomSidebarItems: () => "[]",
    // dialogs / fs
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
    getDataRoot: () => "/data/root",
    fsReadFile: async () => "[]",
    fsWriteFile: async () => {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. taskBoard.listIssues — tracer bullet
// ---------------------------------------------------------------------------
test("taskBoard.listIssues returns issue list", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const issues = { items: [{ id: "1", title: "Fix bug" }] };

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    listTaskBoardIssues: async () => issues
  }));

  assert.ok(handlers["taskBoard.listIssues"], "Should register taskBoard.listIssues");
  const result = await handlers["taskBoard.listIssues"]({});
  assert.deepEqual(result, issues);
});

// ---------------------------------------------------------------------------
// 2. taskBoard.createIssue
// ---------------------------------------------------------------------------
test("taskBoard.createIssue delegates to createTaskBoardIssue", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let capturedInput = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    createTaskBoardIssue: async (app, input) => {
      capturedInput = input;
      return { ok: true, id: "new-1" };
    }
  }));

  const input = { title: "New Task", status: "todo" };
  const result = await handlers["taskBoard.createIssue"]({}, input);
  assert.deepEqual(capturedInput, input);
  assert.deepEqual(result, { ok: true, id: "new-1" });
});

// ---------------------------------------------------------------------------
// 3. taskBoard.updateIssue
// ---------------------------------------------------------------------------
test("taskBoard.updateIssue delegates with issueId and update input", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let updated = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    updateTaskBoardIssue: async (app, issueId, input) => {
      updated = { issueId, input };
      return { ok: true };
    }
  }));

  await handlers["taskBoard.updateIssue"]({}, "issue-42", { title: "Updated" });
  assert.deepEqual(updated, { issueId: "issue-42", input: { title: "Updated" } });
});

// ---------------------------------------------------------------------------
// 4. taskBoard.deleteIssue — passes callAgentPlatform
// ---------------------------------------------------------------------------
test("taskBoard.deleteIssue delegates to deleteTaskBoardIssueWithAutomation", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let deletedId = null;
  let platformFn = null;

  const mockCallAgentPlatform = async () => ({});

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    callAgentPlatform: mockCallAgentPlatform,
    deleteTaskBoardIssueWithAutomation: async (app, issueId, cap) => {
      deletedId = issueId;
      platformFn = cap;
      return { ok: true };
    }
  }));

  const result = await handlers["taskBoard.deleteIssue"]({}, "issue-99");
  assert.equal(deletedId, "issue-99");
  assert.equal(platformFn, mockCallAgentPlatform);
  assert.deepEqual(result, { ok: true });
});

// ---------------------------------------------------------------------------
// 5. taskBoard.moveIssue
// ---------------------------------------------------------------------------
test("taskBoard.moveIssue delegates to moveTaskBoardIssue", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let movedInput = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    moveTaskBoardIssue: async (app, input) => {
      movedInput = input;
      return { ok: true };
    }
  }));

  const input = { issueId: "issue-1", targetStatus: "done" };
  await handlers["taskBoard.moveIssue"]({}, input);
  assert.deepEqual(movedInput, input);
});

// ---------------------------------------------------------------------------
// 6. taskBoard.syncIssueAutomation
// ---------------------------------------------------------------------------
test("taskBoard.syncIssueAutomation delegates to syncTaskBoardIssueAutomation", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let syncedId = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    syncTaskBoardIssueAutomation: async (app, issueId, cap) => {
      syncedId = issueId;
      return { ok: true };
    }
  }));

  await handlers["taskBoard.syncIssueAutomation"]({}, "issue-7");
  assert.equal(syncedId, "issue-7");
});

// ---------------------------------------------------------------------------
// 7. customSidebar.list
// ---------------------------------------------------------------------------
test("customSidebar.list returns sidebar items", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const items = { ok: true, items: [{ id: "s-1", label: "GitHub" }] };

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    listCustomSidebarItems: () => items
  }));

  assert.ok(handlers["customSidebar.list"], "Should register customSidebar.list");
  const result = await handlers["customSidebar.list"]({});
  assert.deepEqual(result, items);
});

// ---------------------------------------------------------------------------
// 8. customSidebar.add / update / remove
// ---------------------------------------------------------------------------
test("customSidebar.add / update / remove delegate correctly", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let addedInput = null;
  let updatedArgs = null;
  let removedId = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    addCustomSidebarItem: async (app, input) => { addedInput = input; return { ok: true }; },
    updateCustomSidebarItem: async (app, id, input) => { updatedArgs = { id, input }; return { ok: true }; },
    removeCustomSidebarItem: async (app, id) => { removedId = id; return { ok: true }; }
  }));

  await handlers["customSidebar.add"]({}, { label: "Jira", url: "https://jira.com" });
  assert.deepEqual(addedInput, { label: "Jira", url: "https://jira.com" });

  await handlers["customSidebar.update"]({}, "s-1", { label: "Updated" });
  assert.deepEqual(updatedArgs, { id: "s-1", input: { label: "Updated" } });

  await handlers["customSidebar.remove"]({}, "s-1");
  assert.equal(removedId, "s-1");
});

// ---------------------------------------------------------------------------
// 9. customSidebar.import — canceled dialog returns ok:false
// ---------------------------------------------------------------------------
test("customSidebar.import returns ok:false when dialog is canceled", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    listCustomSidebarItems: () => ({ ok: true, items: [] })
  }));

  const result = await handlers["customSidebar.import"]({});
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("取消"));
});

test("customSidebar.import reads file and imports when confirmed", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let importedContent = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    showFileDialog: async () => ({ canceled: false, filePaths: ["/tmp/sidebar.json"] }),
    fsReadFile: async (filePath) => { return "[{\"id\":\"s-1\"}]"; },
    importCustomSidebarItems: (app, content) => {
      importedContent = content;
      return { ok: true, items: [{ id: "s-1" }] };
    }
  }));

  const result = await handlers["customSidebar.import"]({});
  assert.equal(result.ok, true);
  assert.equal(importedContent, "[{\"id\":\"s-1\"}]");
  assert.equal(result.path, "/tmp/sidebar.json");
});

// ---------------------------------------------------------------------------
// 10. customSidebar.export — canceled save dialog returns ok:false
// ---------------------------------------------------------------------------
test("customSidebar.export returns ok:false when save dialog is canceled", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
    listCustomSidebarItems: () => ({ ok: true, items: [] })
  }));

  const result = await handlers["customSidebar.export"]({});
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("取消"));
});

test("customSidebar.export writes file and returns ok:true", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let writtenPath = null;
  let writtenContent = null;

  registerTaskBoardIpcHandlers(ipc, makeBaseOptions({
    showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/export.json" }),
    exportCustomSidebarItems: () => "[{\"id\":\"s-1\"}]",
    listCustomSidebarItems: () => ({ ok: true, items: [{ id: "s-1" }] }),
    fsWriteFile: async (filePath, content) => {
      writtenPath = filePath;
      writtenContent = content;
    }
  }));

  const result = await handlers["customSidebar.export"]({});
  assert.equal(result.ok, true);
  assert.equal(writtenPath, "/tmp/export.json");
  assert.ok(writtenContent.includes("[{\"id\":\"s-1\"}]"));
  assert.equal(result.path, "/tmp/export.json");
});
