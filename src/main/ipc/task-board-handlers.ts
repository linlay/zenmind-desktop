export interface TaskBoardIpcHandlerOptions {
  app: any;

  // Task board
  listTaskBoardIssues: (app: any) => any;
  listTaskBoardOnlineDevices: (app: any) => any;
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
    listTaskBoardOnlineDevices,
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

  ipcMain.handle("taskBoard.listOnlineDevices", async () =>
    listTaskBoardOnlineDevices(app)
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
