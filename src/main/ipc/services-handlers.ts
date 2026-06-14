import { emitPluginBridgeHook } from "../plugin-bridge";
import { getPluginGlobalShortcutStatuses } from "../plugin-global-shortcuts";
import { invokePluginDesktopAction } from "../plugin-actions";

const AGENT_PLATFORM_SERVICE_ID = "agent-platform";

type AgentPlatformAvailability =
  | { ok: true; monitorUrl: string }
  | { ok: false; message: string };

export interface ServicesIpcHandlerOptions {
  app: any;
  shell: { showItemInFolder: (p: string) => void; openPath: (p: string) => Promise<string> };
  platform?: NodeJS.Platform;

  // Service manager operations
  listServices: (app: any) => Promise<any[]>;
  getServiceState: (app: any, serviceId: string) => Promise<any>;
  getResponsiveServiceState?: (app: any, serviceId: string) => Promise<any>;
  installBuiltinService: (app: any, serviceId: string, options?: any) => Promise<any>;
  initializeService: (app: any, serviceId: string) => Promise<any>;
  startService: (app: any, serviceId: string) => Promise<any>;
  stopService: (app: any, serviceId: string) => Promise<any>;
  restartService: (app: any, serviceId: string) => Promise<any>;
  readPluginSettings: (app: any, serviceId: string, shortcutStatuses?: any[]) => Promise<any> | any;
  writePluginSettings: (app: any, serviceId: string, values: any, shortcutStatuses?: any[]) => Promise<any> | any;
  openPluginSettingsPage: (app: any, serviceId: string) => Promise<any> | any;
  refreshPluginGlobalShortcuts?: () => unknown;
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
  showMessageBox?: (opts: any, owner?: any) => Promise<{ response: number }>;
  showArchiveDialog: (title: string) => Promise<any>;

  // Log viewer window controls
  openLogViewerWindow: (request: any) => Promise<any>;
  closeLogViewerWindow: () => void;
  minimizeLogViewerWindow: () => void;
  maximizeLogViewerWindow: () => void;
  openAgentPlatformMonitorWindow: (url: string) => Promise<any>;

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
  importEnvZipToRuntime?: (app: any, zipPath: string, platform: string) => Promise<{ copiedFiles: number; skippedFiles: number }>;
  applyDesktopDefaultSsoDefaults?: (app: any, platform: NodeJS.Platform) => unknown;
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

  // Old root migration decision (shared from startup)
  oldRootDecisionRef?: { current: "migrate" | "keep" | "cancel" | undefined };
  generateBackupDirName?: (rootPath: string, platform: string) => string;
  migrateOldRootToBackup?: (platform: string, rootPath: string, backupPath?: string) => string;
  shouldPromptEnvRootConflict?: (input: {
    platform: string;
    isFirstDesktopInstall: boolean;
    bundledEnvZipExists: boolean;
    runtimeRootExistedAtStartup: boolean;
  }) => boolean;
  isFirstDesktopInstall?: boolean;
  bundledEnvZipExistsAtStartup?: boolean;
  runtimeRootExistedAtStartup?: boolean;
  runtimeRootAtProcessStart?: string;
}

function createAgentPlatformMonitorUrl(baseUrl: string, token: string) {
  const url = new URL("/monitor", baseUrl);
  url.searchParams.set("access_token", token);
  return url.toString();
}

async function resolveAgentPlatformMonitorUrl(options: {
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
  return { ok: true, monitorUrl: createAgentPlatformMonitorUrl(baseUrl, token) };
}

export function registerServicesIpcHandlers(ipcMain: any, options: ServicesIpcHandlerOptions) {
  const {
    app,
    shell,
    platform = process.platform,
    listServices,
    getServiceState,
    getResponsiveServiceState,
    installBuiltinService,
    initializeService,
    startService,
    stopService,
    restartService,
    readPluginSettings,
    writePluginSettings,
    openPluginSettingsPage,
    refreshPluginGlobalShortcuts,
    readServiceConfig,
    writeServiceConfig,
    importServiceFile,
    getServiceLogsMeta,
    watchServiceLog,
    readServiceLog,
    runServiceMutation,
    handleServiceStart,
    showFileDialog,
    showMessageBox,
    showArchiveDialog,
    openLogViewerWindow,
    closeLogViewerWindow,
    minimizeLogViewerWindow,
    maximizeLogViewerWindow,
    openAgentPlatformMonitorWindow,
    revealPathInFileManager,
    getServiceWebviewPreloadPath,
    getServiceWebviewPreloadUrl,
    logStreamSubscriptions,
    getArchiveExtensions,
    startupRestoreController,
    clearSessionCache,
    importEnvZipToRuntime,
    applyDesktopDefaultSsoDefaults,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyServicesChanged,
    runStartupPreparation,
    issueAgentPlatformAccessToken,
    oldRootDecisionRef,
    generateBackupDirName,
    migrateOldRootToBackup,
    shouldPromptEnvRootConflict,
    isFirstDesktopInstall,
    bundledEnvZipExistsAtStartup,
    runtimeRootExistedAtStartup,
    runtimeRootAtProcessStart
  } = options;

  // ---------------------------------------------------------------------------
  // services — list & state
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.list", async () => listServices(app));

  ipcMain.handle("services.getStartupRestoreState", async () =>
    startupRestoreController?.getState()
  );

  function beginBootstrapStatus(message: string) {
    startupRestoreController?.beginSession("bootstrap");
    startupRestoreController?.updateService("zenmind-app-server", "installing", message);
    notifyServicesChanged?.();
  }

  function scheduleStartupPreparationAfterEnvDecision() {
    if (!runStartupPreparation) {
      return false;
    }

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

    return true;
  }

  function continueStartupWithExistingEnv() {
    if (!runStartupPreparation) {
      return { ok: false, message: "环境初始化配置不可用。" };
    }

    beginBootstrapStatus("跳过 env.zip 导入，使用现有环境目录...");
    scheduleStartupPreparationAfterEnvDecision();
    return { ok: true };
  }

  async function promptManualEnvRootConflict(): Promise<"migrate" | "keep" | "cancel" | undefined> {
    if (oldRootDecisionRef?.current === "migrate" || oldRootDecisionRef?.current === "keep") {
      return oldRootDecisionRef.current;
    }
    if (
      !shouldPromptEnvRootConflict ||
      !showMessageBox ||
      !generateBackupDirName ||
      !migrateOldRootToBackup ||
      !runtimeRootAtProcessStart
    ) {
      return undefined;
    }

    const promptNeeded = shouldPromptEnvRootConflict({
      platform: platform || process.platform,
      isFirstDesktopInstall: Boolean(isFirstDesktopInstall),
      bundledEnvZipExists: Boolean(bundledEnvZipExistsAtStartup),
      runtimeRootExistedAtStartup: Boolean(runtimeRootExistedAtStartup)
    });
    if (!promptNeeded) {
      return undefined;
    }

    const backupPath = generateBackupDirName(runtimeRootAtProcessStart, platform || process.platform);
    const choice = await showMessageBox({
      type: "warning",
      title: "检测到旧环境目录",
      message: `目录 ${runtimeRootAtProcessStart} 已存在，是否迁移旧数据？`,
      detail: `迁移后旧目录将重命名为 ${backupPath}，然后导入全新环境。\n选择“使用旧数据”将跳过环境导入，直接使用现有目录。`,
      buttons: ["迁移旧数据并初始化", "使用旧数据", "取消导入"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (choice.response === 1) {
      if (oldRootDecisionRef) {
        oldRootDecisionRef.current = "keep";
      }
      return "keep";
    }
    if (choice.response !== 0) {
      return "cancel";
    }

    try {
      migrateOldRootToBackup(platform || process.platform, runtimeRootAtProcessStart, backupPath);
      if (oldRootDecisionRef) {
        oldRootDecisionRef.current = "migrate";
      }
      return "migrate";
    } catch (error) {
      const retryChoice = await showMessageBox({
        type: "error",
        title: "旧环境迁移失败",
        message: error instanceof Error ? error.message : String(error),
        detail: `旧目录：${runtimeRootAtProcessStart}\n目标备份：${backupPath}`,
        buttons: ["取消导入", "使用旧数据"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (retryChoice.response === 1) {
        if (oldRootDecisionRef) {
          oldRootDecisionRef.current = "keep";
        }
        return "keep";
      }
      return "cancel";
    }
  }

  ipcMain.handle("services.importEnvZip", async () => {
    const effectiveDecision = await promptManualEnvRootConflict();
    if (effectiveDecision === "keep") {
      return continueStartupWithExistingEnv();
    }
    if (effectiveDecision === "cancel") {
      return { ok: false, message: "已取消导入。" };
    }

    const result = await showFileDialog({
      title: "选择 env.zip",
      defaultPath: app.getPath("home"),
      properties: ["openFile"],
      filters: [{ name: "env.zip", extensions: ["zip"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入。" };
    }

    if (!importEnvZipToRuntime || !runStartupPreparation) {
      return { ok: false, message: "环境初始化配置不可用。" };
    }

    try {
      beginBootstrapStatus("正在导入 env.zip...");

      const importResult = await importEnvZipToRuntime(app, result.filePaths[0], platform);
      console.info(
        `[main] imported env.zip: copied=${importResult.copiedFiles}, skipped=${importResult.skippedFiles}`
      );
      applyDesktopDefaultSsoDefaults?.(app, platform);

      scheduleStartupPreparationAfterEnvDecision();

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupRestoreController?.setEnvImportRequired(message);
      notifyServicesChanged?.();
      return { ok: false, message };
    }
  });

  const readServiceState = getResponsiveServiceState ?? getServiceState;
  ipcMain.handle("services.getStatus", async (_event: any, serviceId: string) =>
    readServiceState(app, serviceId)
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

  ipcMain.handle("services.invokePluginAction", async (_event: any, serviceId: string, actionId: string) =>
    runServiceMutation(() => invokePluginDesktopAction({
      app,
      serviceId,
      actionId,
      getServiceState,
      handleServiceStart
    }))
  );

  // ---------------------------------------------------------------------------
  // services — config
  // ---------------------------------------------------------------------------
  ipcMain.handle("services.readPluginSettings", async (_event: any, serviceId: string) =>
    readPluginSettings(app, serviceId, getPluginGlobalShortcutStatuses(serviceId))
  );

  ipcMain.handle("services.writePluginSettings", async (_event: any, serviceId: string, values: any) =>
    runServiceMutation(async () => {
      const result = await writePluginSettings(app, serviceId, values, getPluginGlobalShortcutStatuses(serviceId));
      refreshPluginGlobalShortcuts?.();
      const refreshed = await readPluginSettings(app, serviceId, getPluginGlobalShortcutStatuses(serviceId));
      emitPluginBridgeHook("plugin.settingsChanged", {
        pluginId: serviceId,
        values: refreshed.values,
        changedKeys: result.changedKeys,
        restartRequired: result.restartRequired
      });
      return {
        ...result,
        shortcutStatuses: refreshed.shortcutStatuses
      };
    })
  );

  ipcMain.handle("services.openPluginSettingsPage", async (_event: any, serviceId: string) =>
    openPluginSettingsPage(app, serviceId)
  );

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

  ipcMain.handle("services.openAgentPlatformMonitor", async () => {
    try {
      const availability = await resolveAgentPlatformMonitorUrl({
        app,
        getServiceState: readServiceState,
        issueAgentPlatformAccessToken
      });
      if (!availability.ok) {
        return availability;
      }
      return openAgentPlatformMonitorWindow(availability.monitorUrl);
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
