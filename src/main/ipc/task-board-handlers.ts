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

  // Custom sidebar
  listCustomSidebarItems: (app: any) => any;
  addCustomSidebarItem: (app: any, input: any) => any;
  updateCustomSidebarItem: (app: any, id: string, input: any) => any;
  removeCustomSidebarItem: (app: any, id: string) => any;
  importCustomSidebarItems: (app: any, content: string) => any;
  exportCustomSidebarItems: (app: any) => string;

  // Dialogs
  showFileDialog: (opts: any, owner?: any) => Promise<any>;
  showSaveDialog: (opts: any, owner?: any) => Promise<any>;

  // Data root (for default export path)
  getDataRoot: (app: any) => string;

  // File system (injectable for testing)
  fsReadFile?: (filePath: string, encoding: string) => Promise<string>;
  fsWriteFile?: (filePath: string, content: string, encoding: string) => Promise<void>;
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
    callAgentPlatform,
    listCustomSidebarItems,
    addCustomSidebarItem,
    updateCustomSidebarItem,
    removeCustomSidebarItem,
    importCustomSidebarItems,
    exportCustomSidebarItems,
    showFileDialog,
    showSaveDialog,
    getDataRoot
  } = options;

  // Inject-friendly fs (fall back to real fs.promises at runtime)
  const fsReadFile = options.fsReadFile ?? (async (p: string, enc: string) => {
    const fs = await import("node:fs");
    return fs.promises.readFile(p, enc as any) as unknown as string;
  });
  const fsWriteFile = options.fsWriteFile ?? (async (p: string, content: string, enc: string) => {
    const fs = await import("node:fs");
    await fs.promises.writeFile(p, content, enc as any);
  });

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

  // ---------------------------------------------------------------------------
  // customSidebar.*
  // ---------------------------------------------------------------------------
  ipcMain.handle("customSidebar.list", async () =>
    listCustomSidebarItems(app)
  );

  ipcMain.handle("customSidebar.add", async (_event: any, input: any) =>
    addCustomSidebarItem(app, input)
  );

  ipcMain.handle("customSidebar.update", async (_event: any, id: string, input: any) =>
    updateCustomSidebarItem(app, id, input)
  );

  ipcMain.handle("customSidebar.remove", async (_event: any, id: string) =>
    removeCustomSidebarItem(app, id)
  );

  ipcMain.handle("customSidebar.import", async () => {
    const result = await showFileDialog({
      title: "导入内嵌网站配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导入内嵌网站配置。"
      };
    }

    const importPath = result.filePaths[0];
    const fileContent = await fsReadFile(importPath, "utf8");
    const importResult = importCustomSidebarItems(app, fileContent);
    return {
      ...importResult,
      path: importPath
    };
  });

  ipcMain.handle("customSidebar.export", async () => {
    const path = await import("node:path");
    const saveResult = await showSaveDialog({
      title: "导出内嵌网站配置",
      defaultPath: path.join(getDataRoot(app), "custom-sidebar-items.json"),
      filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        ok: false,
        items: listCustomSidebarItems(app).items,
        path: "",
        message: "已取消导出内嵌网站配置。"
      };
    }

    const filePath = saveResult.filePath;
    await fsWriteFile(filePath, `${exportCustomSidebarItems(app)}\n`, "utf8");
    return {
      ok: true,
      items: listCustomSidebarItems(app).items,
      path: filePath,
      message: "已导出内嵌网站配置。"
    };
  });
}
