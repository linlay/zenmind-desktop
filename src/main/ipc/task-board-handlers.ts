export interface TaskBoardIpcHandlerOptions {
  app: any;

  // Task board
  listTaskBoardIssues: (app: any) => any;
  resyncTaskBoardCloud: (app: any) => any;
  getTaskBoardSettings: (app: any) => any;
  saveTaskBoardSettings: (app: any, input: any) => any;
  getTaskBoardCloudConfig: (app: any) => any;
  saveTaskBoardCloudConfig: (app: any, input: any) => any;
  createTaskBoardIssue: (app: any, input: any) => any;
  updateTaskBoardIssue: (app: any, issueId: string, input: any) => any;
  deleteTaskBoardIssueWithAutomation: (app: any, issueId: string, callAgentPlatform: any) => any;
  moveTaskBoardIssue: (app: any, input: any) => any;
  syncTaskBoardIssueAutomation: (app: any, issueId: string, callAgentPlatform: any) => any;
  callAgentPlatform: (app: any, path: string, options?: any) => any;

}

export function registerTaskBoardIpcHandlers(ipcMain: any, options: TaskBoardIpcHandlerOptions) {
  const {
    app,
    listTaskBoardIssues,
    resyncTaskBoardCloud,
    getTaskBoardSettings,
    saveTaskBoardSettings,
    getTaskBoardCloudConfig,
    saveTaskBoardCloudConfig,
    createTaskBoardIssue,
    updateTaskBoardIssue,
    deleteTaskBoardIssueWithAutomation,
    moveTaskBoardIssue,
    syncTaskBoardIssueAutomation,
    callAgentPlatform
  } = options;

  // ---------------------------------------------------------------------------
  // taskBoard.*
  // ---------------------------------------------------------------------------
  ipcMain.handle("taskBoard.listIssues", async () =>
    listTaskBoardIssues(app)
  );

  ipcMain.handle("taskBoard.resyncCloudBoard", async () =>
    resyncTaskBoardCloud(app)
  );

  ipcMain.handle("taskBoard.getSettings", async () =>
    getTaskBoardSettings(app)
  );

  ipcMain.handle("taskBoard.saveSettings", async (_event: any, input: any) =>
    saveTaskBoardSettings(app, input)
  );

  ipcMain.handle("taskBoard.getCloudConfig", async () =>
    getTaskBoardCloudConfig(app)
  );

  ipcMain.handle("taskBoard.saveCloudConfig", async (_event: any, input: any) =>
    saveTaskBoardCloudConfig(app, input)
  );

  ipcMain.handle("taskBoard.createIssue", async (_event: any, input: any) =>
    createTaskBoardIssue(app, input)
  );

  ipcMain.handle("taskBoard.updateIssue", async (_event: any, issueId: string, input: any) =>
    updateTaskBoardIssue(app, issueId, input)
  );

  ipcMain.handle("taskBoard.deleteIssue", async (_event: any, issueId: string) =>
    deleteTaskBoardIssueWithAutomation(app, issueId, callAgentPlatform)
  );

  ipcMain.handle("taskBoard.moveIssue", async (_event: any, input: any) =>
    moveTaskBoardIssue(app, input)
  );

  ipcMain.handle("taskBoard.syncIssueAutomation", async (_event: any, issueId: string) =>
    syncTaskBoardIssueAutomation(app, issueId, callAgentPlatform)
  );

}
