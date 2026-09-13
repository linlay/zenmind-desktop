import { createKanbanResultReadStore, kanbanReadScope, kanbanReadScopeToken, projectKanbanResultReads } from "./result-read-store";
import { resolveKanbanResultIdentity } from "../../../shared/kanban-result-read";
import { getDesktopDeviceId } from "../identity";
export interface KanbanIpcHandlerOptions {
  app: any;

  // Kanban
  listKanbanIssues: (app: any) => any;
  resyncKanbanCloud: (app: any) => any;
  getKanbanSettings: (app: any) => any;
  saveLocalWorkflows: (app: any, input: any) => any;
  saveKanbanSettings: (app: any, input: any) => any;
  getKanbanCloudConfig: (app: any) => any;
  saveKanbanCloudConfig: (app: any, input: any) => any;
  createKanbanIssue: (app: any, input: any) => any;
  updateKanbanIssue: (app: any, issueId: string, input: any) => any;
  deleteKanbanIssueWithAutomation: (app: any, issueId: string, callAgentPlatform: any) => any;
  moveKanbanIssue: (app: any, input: any) => any;
  claimKanbanIssue: (app: any, issueId: string) => any;
  runKanbanIssue: (app: any, input: any) => any;
  bindKanbanHumanReferenceChat: (app: any, input: any) => any;
  unbindKanbanHumanReferenceChat: (app: any, issueChatId: string) => any;
  syncKanbanIssueAutomation: (app: any, issueId: string, callAgentPlatform: any) => any;
  callAgentPlatform: (app: any, path: string, options?: any) => any;

}

export function registerKanbanIpcHandlers(ipcMain: any, options: KanbanIpcHandlerOptions) {
  const {
    app,
    listKanbanIssues,
    resyncKanbanCloud,
    getKanbanSettings,
    saveKanbanSettings,
    saveLocalWorkflows,
    getKanbanCloudConfig,
    saveKanbanCloudConfig,
    createKanbanIssue,
    updateKanbanIssue,
    deleteKanbanIssueWithAutomation,
    moveKanbanIssue,
    claimKanbanIssue,
    runKanbanIssue,
    bindKanbanHumanReferenceChat,
    unbindKanbanHumanReferenceChat,
    syncKanbanIssueAutomation,
    callAgentPlatform
  } = options;

  function handle(channel: string, listener: (...args: any[]) => any) {
    ipcMain.handle(channel, async (...args: any[]) => {
      const result = await listener(...args);
      if (!Array.isArray(result?.issues)) return result;
      const snapshot = result.currentUser ? result : await listKanbanIssues(app);
      const projected = projectKanbanResultReads(app, { ...snapshot, issues: result.issues });
      return { ...result, issues: projected.issues };
    });
  }

  // ---------------------------------------------------------------------------
  // kanban.*
  // ---------------------------------------------------------------------------
  handle("kanban.listIssues", async () =>
    listKanbanIssues(app)
  );

  const reading = new Map<string, Promise<{ ok: boolean; message?: string }>>();
  handle("kanban.markResultRead", async (_event: any, input: { issueId: string; key: string; scope: string }) => {
    if (!input || typeof input.issueId !== "string" || typeof input.key !== "string") return { ok: false };
    const result = await listKanbanIssues(app);
    const scope = kanbanReadScope(app, result);
    if (input.scope !== kanbanReadScopeToken(scope)) return { ok: false };
    const requestKey = JSON.stringify([scope, input.issueId, input.key]);
    if (reading.has(requestKey)) return reading.get(requestKey);
    const task = (async () => {
      const issue = result.issues.find((item: any) => item.id === input.issueId);
      const identity = issue && resolveKanbanResultIdentity(issue, result.cloudDetails);
      if (!identity || identity.key !== input.key) return { ok: false };
      const store = createKanbanResultReadStore(app, scope);
      if (store.has(issue.id, identity.key)) return { ok: true };
      if (identity.chatId) {
        // Never mark a different device's Chat or a whole Agent as read.
        if (!identity.runId || (identity.cloud && identity.deviceId !== getDesktopDeviceId(app))) return { ok: false };
        const response = await callAgentPlatform(app, "/api/read", {
          method: "POST", body: { chatId: identity.chatId, runId: identity.runId }
        });
        if (response?.chatId !== identity.chatId || !response?.read || response.read.readRunId !== identity.runId) return { ok: false };
      }
      const latest = await listKanbanIssues(app);
      const current = latest.issues.find((item: any) => item.id === input.issueId);
      if (kanbanReadScope(app, latest) !== scope || !current || resolveKanbanResultIdentity(current, latest.cloudDetails)?.key !== identity.key) return { ok: false };
      store.mark(issue.id, identity.key);
      return { ok: true };
    })().catch(() => ({ ok: false }));
    reading.set(requestKey, task);
    try { return await task; } finally { reading.delete(requestKey); }
  });

  handle("kanban.resyncCloudBoard", async () =>
    resyncKanbanCloud(app)
  );

  handle("kanban.saveLocalWorkflows", async (_event: any, input: any) => saveLocalWorkflows(app, input));

  handle("kanban.getSettings", async () =>
    getKanbanSettings(app)
  );

  handle("kanban.saveSettings", async (_event: any, input: any) =>
    saveKanbanSettings(app, input)
  );

  handle("kanban.getCloudConfig", async () =>
    getKanbanCloudConfig(app)
  );

  handle("kanban.saveCloudConfig", async (_event: any, input: any) =>
    saveKanbanCloudConfig(app, input)
  );

  handle("kanban.createIssue", async (_event: any, input: any) =>
    createKanbanIssue(app, input)
  );

  handle("kanban.updateIssue", async (_event: any, issueId: string, input: any) =>
    updateKanbanIssue(app, issueId, input)
  );

  handle("kanban.deleteIssue", async (_event: any, issueId: string) =>
    deleteKanbanIssueWithAutomation(app, issueId, callAgentPlatform)
  );

  handle("kanban.moveIssue", async (_event: any, input: any) =>
    moveKanbanIssue(app, input)
  );

  handle("kanban.claimIssue", async (_event: any, issueId: string) =>
    claimKanbanIssue(app, issueId)
  );

  handle("kanban.runIssue", async (_event: any, input: any) =>
    runKanbanIssue(app, input)
  );

  handle("kanban.bindHumanReferenceChat", async (_event: any, input: any) =>
    bindKanbanHumanReferenceChat(app, input)
  );

  handle("kanban.unbindHumanReferenceChat", async (_event: any, issueChatId: string) =>
    unbindKanbanHumanReferenceChat(app, issueChatId)
  );

  handle("kanban.syncIssueAutomation", async (_event: any, issueId: string) =>
    syncKanbanIssueAutomation(app, issueId, callAgentPlatform)
  );

}
