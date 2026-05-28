import fs from "node:fs";
import path from "node:path";

export interface AssistantIpcHandlerOptions {
  assistantBridge: any;
  assistantNavigationStatusClient: any;
  /** The shared pending-renderer-requests Map (desktopActions.respond resolves into it) */
  desktopActionRendererRequests: Map<string, { resolve: (r: any) => void; timeout: ReturnType<typeof setTimeout> | null }>;
  /** Optional external getter for currentPage snapshot (bridges to callers that need it) */
  getCurrentPageSnapshot?: () => any;
  /** Optional external setter for currentPage snapshot (called when renderer publishes) */
  setCurrentPageSnapshot?: (snapshot: any) => void;
  desktopActionOptions: any;
  app: any;
  mainWindow: any;
  shell: any;
  showFileDialog: ((opts: any, owner?: any) => Promise<any>) | null;
  callAgentPlatform: ((app: any, path: string, options?: any) => Promise<any>) | null;
  handleDesktopActionRequest: ((opts: any, request: any) => Promise<any>) | null;
  DESKTOP_ACTION_DEFINITIONS: ReadonlyArray<any> | any[];
  emitAssistantAttachmentProgress: ((progress: any) => void) | null;
  getAssistantSettings: ((app: any) => any) | null;
  saveAssistantSettings: ((app: any, input: any) => any) | null;
  getAgentPlatformMinimaxSettingsPublic: ((app: any) => any) | null;
  resolveAssistantAttachmentPath: ((app: any, chatId: string, attachmentId: string) => string) | null;
  createAssistantAttachmentFromPastedImage: ((app: any, chatId: any, input: any) => any) | null;
  cancelAssistantAttachmentTask: ((taskId: string) => any) | null;
  createAssistantAttachmentsFromFiles: ((app: any, chatId: any, filePaths: string[], opts: any) => any) | null;
  captureAssistantScreenshot: ((chatId: any, source: string) => any) | null;
  platform?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (no electron deps) — can be unit tested directly
// ---------------------------------------------------------------------------

function sanitizeDownloadFilename(filename: string, fallback: string) {
  const normalized = filename.trim() || fallback;
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").slice(0, 180) || fallback;
}

function getAssistantExportDefaultPath(app: any, filename: string, platform: string = process.platform) {
  const safeFilename = sanitizeDownloadFilename(filename, "chat-export.json");
  if (platform === "win32" || platform === "darwin") {
    return path.join(app.getPath("downloads"), safeFilename);
  }
  return path.join(app.getPath("home"), safeFilename);
}

async function getAvailableFilePath(targetPath: string) {
  const parsedPath = path.parse(targetPath);
  for (let index = 0; index < 1000; index += 1) {
    const candidatePath =
      index === 0
        ? targetPath
        : path.join(parsedPath.dir, `${parsedPath.name} (${index})${parsedPath.ext}`);
    try {
      await fs.promises.access(candidatePath, fs.constants.F_OK);
    } catch {
      return candidatePath;
    }
  }
  return path.join(parsedPath.dir, `${parsedPath.name}-${Date.now()}${parsedPath.ext}`);
}

async function saveAssistantChatExport(
  assistantBridge: any,
  chatId: string,
  app: any,
  platform: string
): Promise<any> {
  const result = await assistantBridge.downloadChatExport(chatId);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const exportPath = await getAvailableFilePath(getAssistantExportDefaultPath(app, result.filename, platform));
  await fs.promises.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.promises.writeFile(exportPath, result.bytes);
  return { ok: true, message: "已下载会话导出。", filePath: exportPath };
}

function coderAgentKeyFromWorkspace(workspaceDir: string): string {
  const segments = workspaceDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  const base = (segments[segments.length - 1] || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `coder-${base || "project"}`;
}

function buildCoderProjectAgentCreateRequest(workspaceDir: string) {
  const key = coderAgentKeyFromWorkspace(workspaceDir);
  const name = key;
  return {
    key,
    definition: {
      key,
      name,
      mode: "CODER",
      workspace: { root: workspaceDir },
      runtimeConfig: { workspaceRoot: workspaceDir },
      visibility: { scopes: ["nav", "copilot"] }
    }
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAssistantIpcHandlers(ipcMain: any, options: AssistantIpcHandlerOptions) {
  const {
    assistantBridge,
    assistantNavigationStatusClient,
    desktopActionRendererRequests,
    desktopActionOptions,
    app,
    mainWindow,
    shell,
    showFileDialog,
    callAgentPlatform,
    handleDesktopActionRequest,
    DESKTOP_ACTION_DEFINITIONS,
    emitAssistantAttachmentProgress,
    getAssistantSettings,
    saveAssistantSettings,
    getAgentPlatformMinimaxSettingsPublic,
    resolveAssistantAttachmentPath,
    createAssistantAttachmentFromPastedImage,
    cancelAssistantAttachmentTask,
    createAssistantAttachmentsFromFiles,
    captureAssistantScreenshot,
    platform = process.platform
  } = options;

  // ---------------------------------------------------------------------------
  // currentPage — pure snapshot state
  // Internal fallback state when no external getter/setter is provided.
  // ---------------------------------------------------------------------------
  let _internalSnapshot: any = null;
  const getSnapshot = options.getCurrentPageSnapshot ?? (() => _internalSnapshot);
  const setSnapshot = options.setCurrentPageSnapshot ?? ((s: any) => { _internalSnapshot = s; });

  ipcMain.handle("currentPage.publishSnapshot", async (_event: any, snapshot: any) => {
    setSnapshot(snapshot);
    return { ok: true };
  });

  ipcMain.handle("currentPage.getSnapshot", async () => getSnapshot());

  // ---------------------------------------------------------------------------
  // assistant — settings
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.getSettings", async () =>
    (getAgentPlatformMinimaxSettingsPublic?.(app) ?? null) ?? getAssistantSettings?.(app)
  );

  ipcMain.handle("assistant.saveSettings", async (_event: any, input: any) =>
    saveAssistantSettings?.(app, input)
  );

  ipcMain.handle("assistant.getMemorySettings", async () =>
    assistantBridge?.getMemorySettings()
  );

  ipcMain.handle("assistant.saveMemorySettings", async (_event: any, input: any) =>
    assistantBridge?.saveMemorySettings(input)
  );

  ipcMain.handle("assistant.getMemorySummary", async () =>
    assistantBridge?.getMemorySummary()
  );

  // ---------------------------------------------------------------------------
  // assistant — agents
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.listAgents", async () => {
    try {
      return await assistantBridge.listAgents();
    } catch (error) {
      console.warn("[assistant] failed to list agent-platform agents", error);
      return [];
    }
  });

  ipcMain.handle("assistant.listNavigationAgents", async (): Promise<any> => {
    try {
      const cached = assistantNavigationStatusClient?.getSnapshot();
      if (cached?.ok) {
        return cached;
      }
      return await (assistantNavigationStatusClient?.refreshNow() ?? assistantBridge?.listNavigationAgents());
    } catch (error) {
      console.warn("[assistant] failed to list navigation agents", error);
      return {
        ok: false,
        items: [],
        message: error instanceof Error ? error.message : "agent-platform 暂不可用。",
        updatedAt: new Date().toISOString()
      };
    }
  });

  ipcMain.handle("assistant.createCoderProject", async (_event: any, input: any): Promise<any> => {
    const workspaceDir = String(input?.workspaceDir || "").trim();
    if (!workspaceDir) {
      return { ok: false, message: "缺少项目目录，无法创建 CODER 智能体。" };
    }
    const request = buildCoderProjectAgentCreateRequest(workspaceDir);
    try {
      const response = await callAgentPlatform?.(app, "/api/agent/create", {
        method: "POST",
        body: request
      });
      const agentKey = String(response?.key || request.key).trim();
      assistantNavigationStatusClient?.scheduleRefresh(0);
      return { ok: true, message: "已创建 CODER 智能体。", agentKey, workspaceDir };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        agentKey: request.key,
        workspaceDir
      };
    }
  });

  // ---------------------------------------------------------------------------
  // assistant — memory (legacy stub + bridge delegates)
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.openMemoryDirectory", async () => ({
    ok: false,
    message: "记忆现在由 agent-platform 管理，Desktop 不再维护本地记忆目录。",
    path: ""
  }));

  ipcMain.handle("assistant.listMemoryItems", async () =>
    assistantBridge?.listMemoryItems()
  );

  ipcMain.handle("assistant.deleteMemoryItem", async (_event: any, memoryId: string) =>
    assistantBridge?.deleteMemoryItem(memoryId)
  );

  ipcMain.handle("assistant.clearMemoryItems", async () =>
    assistantBridge?.clearMemoryItems()
  );

  // ---------------------------------------------------------------------------
  // assistant — chats
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.listChats", async () =>
    assistantBridge?.listChats()
  );

  ipcMain.handle("assistant.getChat", async (_event: any, chatId: string) =>
    assistantBridge?.getChat(chatId)
  );

  ipcMain.handle("assistant.deleteChat", async (_event: any, chatId: string) => {
    const result = await assistantBridge.deleteChat(chatId);
    if (result.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.markAgentChatsRead", async (_event: any, agentKey: string) => {
    const result = await assistantBridge?.markAgentChatsRead(agentKey);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.renameChat", async (_event: any, chatId: string, chatName: string) => {
    const result = await assistantBridge?.renameChat(chatId, chatName);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.archiveChat", async (_event: any, chatId: string) => {
    const result = await assistantBridge?.archiveChat(chatId);
    if (result?.ok) {
      assistantNavigationStatusClient?.scheduleRefresh(0);
    }
    return result;
  });

  ipcMain.handle("assistant.exportChat", async (_event: any, chatId: string) =>
    saveAssistantChatExport(assistantBridge, chatId, app, platform)
  );

  // ---------------------------------------------------------------------------
  // assistant — attachments
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.pickAttachments", async (_event: any, chatId?: string | null) => {
    const result = await showFileDialog?.({
      title: "选择要给 ZenMind 读取的附件",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "可读取文本或常见文档",
          extensions: [
            "txt", "md", "csv", "json", "jsonl", "log", "html", "xml",
            "yml", "yaml", "png", "jpg", "jpeg", "webp", "gif",
            "pdf", "docx", "xlsx", "pptx"
          ]
        },
        { name: "所有文件", extensions: ["*"] }
      ]
    }, mainWindow);
    if (!result || result.canceled || result.filePaths.length === 0) {
      return { ok: false, chatId: chatId ?? "", message: "已取消选择附件。", attachments: [] };
    }
    return createAssistantAttachmentsFromFiles?.(app, chatId, result.filePaths, {
      onProgress: emitAssistantAttachmentProgress
    });
  });

  ipcMain.handle("assistant.cancelAttachmentTask", async (_event: any, taskId: string) =>
    cancelAssistantAttachmentTask?.(taskId)
  );

  ipcMain.handle(
    "assistant.addPastedImage",
    async (_event: any, chatId: string | null | undefined, input: any) =>
      createAssistantAttachmentFromPastedImage?.(app, chatId, input)
  );

  ipcMain.handle("assistant.captureScreenshot", async (_event: any, chatId?: string | null) =>
    captureAssistantScreenshot?.(chatId, "sidebar")
  );

  ipcMain.handle("assistant.openAttachment", async (_event: any, chatId: string, attachmentId: string) => {
    try {
      const attachmentPath = resolveAssistantAttachmentPath?.(app, chatId, attachmentId) ?? "";
      const error = await shell?.openPath(attachmentPath) ?? "";
      return {
        ok: !error,
        message: error ? `打开附件失败：${error}` : "已打开附件。",
        path: attachmentPath
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        path: ""
      };
    }
  });

  // ---------------------------------------------------------------------------
  // assistant — run lifecycle
  // ---------------------------------------------------------------------------
  ipcMain.handle("assistant.startRun", async (_event: any, request: any) =>
    assistantBridge?.startRun(request)
  );

  ipcMain.handle("assistant.stopRun", async (_event: any, runId: string) =>
    assistantBridge?.stopRun(runId)
  );

  ipcMain.handle("assistant.correctVoiceText", async (_event: any, request: any) =>
    assistantBridge?.correctVoiceText(request)
  );

  ipcMain.handle("assistant.transcribeVoiceAudio", async (_event: any, request: any) =>
    assistantBridge?.transcribeVoiceAudio(request)
  );

  ipcMain.handle("assistant.submitAwaiting", async (_event: any, request: any) =>
    assistantBridge?.submitAwaiting(request)
  );

  // ---------------------------------------------------------------------------
  // desktopActions
  // ---------------------------------------------------------------------------
  ipcMain.handle("desktopActions.respond", async (_event: any, response: any) => {
    const requestId = typeof response?.requestId === "string" ? response.requestId : "";
    if (!requestId) return { ok: false };
    const pending = desktopActionRendererRequests.get(requestId);
    if (!pending) return { ok: false };
    desktopActionRendererRequests.delete(requestId);
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.resolve(response);
    return { ok: true };
  });

  ipcMain.handle("desktopActions.list", async () => ({
    ok: true,
    actions: DESKTOP_ACTION_DEFINITIONS
  }));

  ipcMain.handle("desktopActions.call", async (_event: any, request: any) =>
    handleDesktopActionRequest?.(desktopActionOptions, request)
  );
}
