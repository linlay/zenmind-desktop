const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const AGENT_PLATFORM_MONITOR_DEFAULT_CONNECTION_LIMIT = 100;
const AGENT_PLATFORM_MONITOR_DEFAULT_MESSAGE_LIMIT = 50;

type AgentPlatformMonitorReadOptions = {
  sessionId?: string;
  connectionLimit?: number;
  messageLimit?: number;
};

type AgentPlatformAvailability =
  | { ok: true; baseUrl: string; token: string }
  | { ok: false; message: string };

type PlatformApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type FetchLike = (input: string, init?: any) => Promise<any>;

export interface ServicesIpcHandlerOptions {
  app: any;
  shell: { showItemInFolder: (p: string) => void; openPath: (p: string) => Promise<string> };
  platform?: string;

  // Service manager operations
  listServices: (app: any) => Promise<any[]>;
  getServiceState: (app: any, serviceId: string) => Promise<any>;
  installBuiltinService: (app: any, serviceId: string, options?: any) => Promise<any>;
  initializeService: (app: any, serviceId: string) => Promise<any>;
  startService: (app: any, serviceId: string) => Promise<any>;
  stopService: (app: any, serviceId: string) => Promise<any>;
  restartService: (app: any, serviceId: string) => Promise<any>;
  readServiceConfig: (app: any, serviceId: string, key: string) => Promise<any>;
  writeServiceConfig: (app: any, serviceId: string, key: string, content: string) => Promise<any>;
  importServiceFile: (app: any, serviceId: string, targetKey: string, filePath: string) => Promise<any>;
  getServiceLogsMeta: (app: any, serviceId: string) => Promise<any>;
  watchServiceLog: (app: any, subscriptionId: string, serviceId: string, target: any, options: any, onData: (payload: any) => void) => () => void;
  readServiceLog: (app: any, serviceId: string, target: any, options?: any) => Promise<any>;

  // Mutation queue (kept in index.ts, injected here to keep mutation ordering)
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;

  // Port-conflict-aware start (handles dialog)
  handleServiceStart: (serviceId: string) => Promise<any>;

  // Dialogs
  showFileDialog: (opts: any, owner?: any) => Promise<any>;
  showArchiveDialog: (title: string) => Promise<any>;

  // Log viewer window controls
  openLogViewerWindow: (request: any) => Promise<any>;
  closeLogViewerWindow: () => void;
  minimizeLogViewerWindow: () => void;
  maximizeLogViewerWindow: () => void;
  openAgentPlatformMonitorWindow: () => Promise<any>;
  closeAgentPlatformMonitorWindow: () => void;
  minimizeAgentPlatformMonitorWindow: () => void;
  maximizeAgentPlatformMonitorWindow: () => void;

  // Path reveal
  revealPathInFileManager: (targetPath: string, options?: any, fsOptions?: any) => Promise<any>;

  // Preload paths
  getServiceWebviewPreloadPath: () => string;
  getServiceWebviewPreloadUrl: () => string;

  // Active log stream subscriptions
  logStreamSubscriptions: Map<string, { webContentsId: number; cleanup: () => void }>;

  // Optional archive extension resolver (injected so tests don't need process.platform)
  getArchiveExtensions?: (platform: string) => string[];

  // Startup restore state
  startupRestoreController?: {
    getState: () => any;
    beginSession: (mode: string) => void;
    updateService: (serviceId: string, phase: any, message: string) => void;
    finishSession: (mode: string, failures: any[]) => void;
    failCurrentSession: (message: string) => void;
    setEnvImportRequired: (message?: string) => void;
  };

  // Environment zip import operations (TDD index-ts-slimming)
  importEnvZipToZenmind?: (app: any, zipPath: string, platform: string) => Promise<{ copiedFiles: number; skippedFiles: number }>;
  loadBuiltinServices?: (app: any) => void;
  loadInstalledPlugins?: (app: any) => void;
  notifyServicesChanged?: () => void;
  runStartupPreparation?: (app: any, callbacks: {
    onModeResolved: (mode: string) => void;
    onStarting: (serviceId: string) => void;
    onProgress: (serviceId: string, phase: any, message: string) => void;
  }) => Promise<{ mode: string; failures: any[] }>;

  // Session cache clearing (injected to allow testing without electron)
  clearSessionCache?: () => Promise<void>;

  // Agent platform monitor
  issueAgentPlatformAccessToken?: (app: any, reason: "missing" | "unauthorized") => Promise<any>;
  agentPlatformFetch?: FetchLike;
}

function normalizeMonitorLimit(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function normalizeMonitorSessionId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function createApiUrl(baseUrl: string, pathname: string, params?: Record<string, string | number>) {
  const url = new URL(pathname, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const normalizedValue = String(value).trim();
      if (normalizedValue) {
        url.searchParams.set(key, normalizedValue);
      }
    }
  }
  return url.toString();
}

function unwrapAgentPlatformResponse<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const response = payload as PlatformApiResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

async function readResponseText(response: any) {
  if (typeof response?.text !== "function") {
    return `HTTP ${response?.status ?? "unknown"}`;
  }
  try {
    const text = await response.text();
    return text.trim() || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function fetchAgentPlatformJson<T>(
  fetchImpl: FetchLike,
  baseUrl: string,
  pathname: string,
  token: string,
  params?: Record<string, string | number>
) {
  const response = await fetchImpl(createApiUrl(baseUrl, pathname, params), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(await readResponseText(response));
  }
  return unwrapAgentPlatformResponse<T>(await response.json());
}

async function resolveAgentPlatformMonitorAvailability(options: {
  app: any;
  getServiceState: (app: any, serviceId: string) => Promise<any>;
  issueAgentPlatformAccessToken?: (app: any, reason: "missing" | "unauthorized") => Promise<any>;
}): Promise<AgentPlatformAvailability> {
  const serviceState = await options.getServiceState(options.app, AGENT_PLATFORM_SERVICE_ID).catch((error: unknown) => ({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
    healthMeta: { webUrl: "", port: null }
  }));
  const baseUrl = serviceState.status === "running"
    ? String(serviceState.healthMeta?.webUrl || "").trim() ||
      (serviceState.healthMeta?.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
    : "";
  if (!baseUrl) {
    return {
      ok: false,
      message: serviceState.message || "agent-platform 未运行，请先在控制中心启动智能体平台。"
    };
  }
  if (!options.issueAgentPlatformAccessToken) {
    return { ok: false, message: "agent-platform token 签发器不可用。" };
  }
  const tokenResult = await options.issueAgentPlatformAccessToken(options.app, "missing");
  const token = typeof tokenResult?.token === "string" ? tokenResult.token.trim() : "";
  if (!tokenResult?.ok || !token) {
    return {
      ok: false,
      message: tokenResult?.message || "agent-platform token 不可用。"
    };
  }
  return { ok: true, baseUrl, token };
}

export function registerServicesIpcHandlers(ipcMain: any, options: ServicesIpcHandlerOptions) {
  const {
    app,
    shell,
    platform = process.platform,
    listServices,
    getServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation,
    handleServiceStart,
    showFileDialog,
    showArchiveDialog,
    openLogViewerWindow,
    closeLogViewerWindow,
    minimizeLogViewerWindow,
    maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow,
    closeAgentPlatformMonitorWindow,
    minimizeAgentPlatformMonitorWindow,
    maximizeAgentPlatformMonitorWindow,
    revealPathInFileManager,
    getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl,
    logStreamSubscriptions,
    getArchiveExtensions,
    startupRestoreController,
    clearSessionCache,
    importEnvZipToZenmind,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged,
    runStartupPreparation,
    issueAgentPlatformAccessToken,
    agentPlatformFetch = fetch
  } = options;

  // ---------------------------------------------------------------------------
  // services — list & state
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.list", async () => listServices(app));

  ipcMain.handle("services.getStartupRestoreState", async () =>
    startupRestoreController?.getState()
  );

  ipcMain.handle("services.importEnvZip", async () => {
    const result = await showFileDialog({
      title: "选择 env.zip",
      defaultPath: app.getPath("home"),
      properties: ["openFile"],
      filters: [{ name: "env.zip", extensions: ["zip"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入。" };
    }

    if (!importEnvZipToZenmind || !runStartupPreparation) {
      return { ok: false, message: "环境初始化配置不可用。" };
    }

    try {
      startupRestoreController?.beginSession("bootstrap");
      startupRestoreController?.updateService("zenmind-app-server", "installing", "正在导入 env.zip...");
      notifyServicesChanged?.();

      const importResult = await importEnvZipToZenmind(app, result.filePaths[0], platform);
      console.info(
        `[main] imported env.zip: copied=${importResult.copiedFiles}, skipped=${importResult.skippedFiles}`
      );

      loadBuiltinServices?.(app);
      loadInstalledPlugins?.(app);
      notifyServicesChanged?.();

      void runServiceMutation(() => runStartupPreparation(app, {
        onModeResolved: (mode: string) => {
          startupRestoreController?.beginSession(mode);
        },
        onStarting: (serviceId: string) => {
          startupRestoreController?.updateService(serviceId, "starting", "启动中...");
        },
        onProgress: (serviceId: string, phase: any, message: string) => {
          startupRestoreController?.updateService(serviceId, phase, message);
          notifyServicesChanged?.();
        }
      }))
        .then((result) => {
          startupRestoreController?.finishSession(result.mode, result.failures);
          notifyServicesChanged?.();
        })
        .catch((error) => {
          startupRestoreController?.failCurrentSession(error instanceof Error ? error.message : String(error));
          notifyServicesChanged?.();
        });

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupRestoreController?.setEnvImportRequired(message);
      notifyServicesChanged?.();
      return { ok: false, message };
    }
  });

  ipcMain.handle("services.getStatus", async (_event: any, serviceId: string) =>
    getServiceState(app, serviceId)
  );

  // ---------------------------------------------------------------------------
  // services — lifecycle mutations
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.initialize", async (_event: any, serviceId: string) =>
    runServiceMutation(() => initializeService(app, serviceId))
  );

  ipcMain.handle("services.start", async (_event: any, serviceId: string) =>
    runServiceMutation(() => handleServiceStart(serviceId))
  );

  ipcMain.handle("services.stop", async (_event: any, serviceId: string) =>
    runServiceMutation(() => stopService(app, serviceId))
  );

  ipcMain.handle("services.restart", async (_event: any, serviceId: string) =>
    runServiceMutation(() => restartService(app, serviceId))
  );

  // ---------------------------------------------------------------------------
  // services — config
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.readConfig", async (_event: any, serviceId: string, key: string) =>
    readServiceConfig(app, serviceId, key)
  );

  ipcMain.handle("services.writeConfig", async (_event: any, serviceId: string, key: string, content: string) =>
    runServiceMutation(() => writeServiceConfig(app, serviceId, key, content))
  );

  ipcMain.handle("services.importFile", async (_event: any, serviceId: string, targetKey: string) =>
    runServiceMutation(async () => {
      const result = await showFileDialog({
        title: "选择要导入的文件",
        properties: ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return {
          ok: false,
          message: "已取消导入。",
          targetPath: "",
          service: await getServiceState(app, serviceId)
        };
      }
      return importServiceFile(app, serviceId, targetKey, result.filePaths[0]);
    })
  );

  // ---------------------------------------------------------------------------
  // services — builtin install
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.installBuiltinFromBundle", async (_event: any, serviceId: string) =>
    runServiceMutation(async () => {
      const current = await getServiceState(app, serviceId);
      if (current.kind !== "builtin") {
        throw new Error(`service ${serviceId} is not a builtin service`);
      }
      if (current.status === "running") {
        return {
          ok: false,
          message: "服务正在运行中，请先停止后再安装。",
          service: current
        };
      }
      await installBuiltinService(app, serviceId);
      await clearSessionCache?.();
      return {
        ok: true,
        message: "内置服务已安装。",
        service: await getServiceState(app, serviceId)
      };
    })
  );

  ipcMain.handle("services.installBuiltin", async (_event: any, serviceId: string) =>
    runServiceMutation(async () => {
      const current = await getServiceState(app, serviceId);
      if (current.kind !== "builtin") {
        throw new Error(`service ${serviceId} is not a builtin service`);
      }
      if (current.status === "running") {
        return {
          ok: false,
          message: "服务正在运行中，请先停止后再安装。",
          service: current
        };
      }
      const archiveTitle = platform === "win32"
        ? "选择内置服务安装包 (.zip)"
        : "选择内置服务安装包 (.tar.gz)";
      const result = await showArchiveDialog(archiveTitle);
      if (result.canceled || result.filePaths.length === 0) {
        return {
          ok: false,
          message: "已取消安装。",
          service: await getServiceState(app, serviceId)
        };
      }
      await installBuiltinService(app, serviceId, {
        force: true,
        archivePath: result.filePaths[0]
      });
      await clearSessionCache?.();
      return {
        ok: true,
        message: "内置服务已安装。",
        service: await getServiceState(app, serviceId)
      };
    })
  );

  // ---------------------------------------------------------------------------
  // services — logs
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.getLogsMeta", async (_event: any, serviceId: string) =>
    getServiceLogsMeta(app, serviceId)
  );

  ipcMain.handle("services.openLogViewer", async (_event: any, request: any) => {
    const serviceId = typeof request?.serviceId === "string" ? request.serviceId.trim() : "";
    const target: "error" | "main" = request?.target === "error" ? "error" : "main";
    const title = typeof request?.title === "string" && request.title.trim()
      ? request.title.trim()
      : "日志文件";
    if (!serviceId) {
      throw new Error("缺少日志服务标识。");
    }
    return openLogViewerWindow({ serviceId, target, title });
  });

  ipcMain.handle("services.closeLogViewer", async () => closeLogViewerWindow());
  ipcMain.handle("services.minimizeLogViewer", async () => minimizeLogViewerWindow());
  ipcMain.handle("services.maximizeLogViewer", async () => maximizeLogViewerWindow());

  ipcMain.handle("services.openAgentPlatformMonitor", async () => openAgentPlatformMonitorWindow());
  ipcMain.handle("services.closeAgentPlatformMonitor", async () => closeAgentPlatformMonitorWindow());
  ipcMain.handle("services.minimizeAgentPlatformMonitor", async () => minimizeAgentPlatformMonitorWindow());
  ipcMain.handle("services.maximizeAgentPlatformMonitor", async () => maximizeAgentPlatformMonitorWindow());

  ipcMain.handle("services.readAgentPlatformMonitor", async (_event: any, rawOptions?: AgentPlatformMonitorReadOptions) => {
    const options = rawOptions ?? {};
    const connectionLimit = normalizeMonitorLimit(
      options.connectionLimit,
      AGENT_PLATFORM_MONITOR_DEFAULT_CONNECTION_LIMIT,
      1,
      500
    );
    const messageLimit = normalizeMonitorLimit(
      options.messageLimit,
      AGENT_PLATFORM_MONITOR_DEFAULT_MESSAGE_LIMIT,
      1,
      50
    );
    const sessionId = normalizeMonitorSessionId(options.sessionId);

    try {
      const availability = await resolveAgentPlatformMonitorAvailability({
        app,
        getServiceState,
        issueAgentPlatformAccessToken
      });
      if (!availability.ok) {
        return availability;
      }

      const messageParams = {
        limit: messageLimit,
        ...(sessionId ? { sessionId } : {})
      };
      const [overview, connections, messages] = await Promise.all([
        fetchAgentPlatformJson(agentPlatformFetch, availability.baseUrl, "/api/monitor", availability.token, {
          messageLimit
        }),
        fetchAgentPlatformJson(agentPlatformFetch, availability.baseUrl, "/api/monitor/ws/connections", availability.token, {
          limit: connectionLimit,
          ...(sessionId ? { sessionId } : {})
        }),
        fetchAgentPlatformJson(agentPlatformFetch, availability.baseUrl, "/api/monitor/ws/messages", availability.token, messageParams)
      ]);

      return {
        ok: true,
        message: "agent-platform monitor snapshot loaded.",
        snapshot: {
          overview,
          connections,
          messages,
          filters: {
            sessionId,
            connectionLimit,
            messageLimit
          },
          fetchedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle(
    "services.readLog",
    async (_event: any, serviceId: string, target: string, opts?: any) =>
      readServiceLog(app, serviceId, target, opts)
  );

  ipcMain.handle(
    "services.watchLog.start",
    async (event: any, subscriptionId: string, serviceId: string, target: string, opts?: any) => {
      logStreamSubscriptions.get(subscriptionId)?.cleanup();
      const ownerContents = event.sender;
      const cleanup = watchServiceLog(app, subscriptionId, serviceId, target, opts, (payload) => {
        if (ownerContents.isDestroyed()) {
          logStreamSubscriptions.get(subscriptionId)?.cleanup();
          logStreamSubscriptions.delete(subscriptionId);
          return;
        }
        ownerContents.send("services.logStream", payload);
      });
      logStreamSubscriptions.set(subscriptionId, { webContentsId: ownerContents.id, cleanup });
      ownerContents.once("destroyed", () => {
        const current = logStreamSubscriptions.get(subscriptionId);
        if (current != null && current.webContentsId === ownerContents.id) {
          current.cleanup();
          logStreamSubscriptions.delete(subscriptionId);
        }
      });
      return { ok: true };
    }
  );

  ipcMain.handle("services.watchLog.stop", async (event: any, subscriptionId: string) => {
    const current = logStreamSubscriptions.get(subscriptionId);
    if (current && current.webContentsId === event.sender.id) {
      current.cleanup();
      logStreamSubscriptions.delete(subscriptionId);
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // services — path reveal
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.revealPath", async (_event: any, targetPath: string, revealOptions?: any) =>
    revealPathInFileManager(targetPath, revealOptions, {
      showItemInFolder: (p: string) => shell.showItemInFolder(p),
      openPath: (p: string) => shell.openPath(p),
      platform
    })
  );

  // ---------------------------------------------------------------------------
  // plugins — preload paths
  // ---------------------------------------------------------------------------
  ipcMain.handle("plugins.getServiceWebviewPreloadPath", async () => getServiceWebviewPreloadPath());
  ipcMain.handle("plugins.getServiceWebviewPreloadUrl", async () => getServiceWebviewPreloadUrl());
}
