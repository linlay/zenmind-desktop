export interface KanbanIpcHandlerOptions {
  app: any;

  // Kanban
  listKanbanIssues: (app: any) => any;
  resyncKanbanCloud: (app: any) => any;
  getKanbanSettings: (app: any) => any;
  saveKanbanSettings: (app: any, input: any) => any;
  getKanbanCloudConfig: (app: any) => any;
  saveKanbanCloudConfig: (app: any, input: any) => any;
  createKanbanIssue: (app: any, input: any) => any;
  updateKanbanIssue: (app: any, issueId: string, input: any) => any;
  deleteKanbanIssueWithAutomation: (app: any, issueId: string, callAgentPlatform: any) => any;
  moveKanbanIssue: (app: any, input: any) => any;
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
    getKanbanCloudConfig,
    saveKanbanCloudConfig,
    createKanbanIssue,
    updateKanbanIssue,
    deleteKanbanIssueWithAutomation,
    moveKanbanIssue,
    syncKanbanIssueAutomation,
    callAgentPlatform
  } = options;

  // ---------------------------------------------------------------------------
  // kanban.*
  // ---------------------------------------------------------------------------
  ipcMain.handle("kanban.listIssues", async () =>
    listKanbanIssues(app)
  );

  ipcMain.handle("kanban.resyncCloudBoard", async () =>
    resyncKanbanCloud(app)
  );

  ipcMain.handle("kanban.getSettings", async () =>
    getKanbanSettings(app)
  );

  ipcMain.handle("kanban.saveSettings", async (_event: any, input: any) =>
    saveKanbanSettings(app, input)
  );

  ipcMain.handle("kanban.getCloudConfig", async () =>
    getKanbanCloudConfig(app)
  );

  ipcMain.handle("kanban.saveCloudConfig", async (_event: any, input: any) =>
    saveKanbanCloudConfig(app, input)
  );

  ipcMain.handle("kanban.createIssue", async (_event: any, input: any) =>
    createKanbanIssue(app, input)
  );

  ipcMain.handle("kanban.updateIssue", async (_event: any, issueId: string, input: any) =>
    updateKanbanIssue(app, issueId, input)
  );

  ipcMain.handle("kanban.deleteIssue", async (_event: any, issueId: string) =>
    deleteKanbanIssueWithAutomation(app, issueId, callAgentPlatform)
  );

  ipcMain.handle("kanban.moveIssue", async (_event: any, input: any) =>
    moveKanbanIssue(app, input)
  );

  ipcMain.handle("kanban.syncIssueAutomation", async (_event: any, issueId: string) =>
    syncKanbanIssueAutomation(app, issueId, callAgentPlatform)
  );

}
