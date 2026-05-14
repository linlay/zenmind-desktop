import { contextBridge, ipcRenderer } from "electron";
import type {
  AssistantEvent,
  AssistantEventListener,
  AssistantAttachmentProgressListener,
  AssistantMemorySettingsInput,
  AssistantPastedImageInput,
  AssistantSettingsInput,
  AssistantSubmitAwaitingRequest,
  AssistantStartRunRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  DesktopPetDanceRequestedListener,
  AssistantWorkerOpenListener,
  AssistantWorkerOpenRequest,
  DesktopPetStateListener,
  DesktopApi,
  NavigateListener,
  NativeDialogVisibilityListener,
  ServicesChangedListener,
  ServiceId,
  ServiceOpenLogViewerRequest,
  ServiceLogReadOptions,
  ServiceLogStreamEvent,
  ServiceLogStreamListener,
  ServiceLogStreamOptions,
  ServiceLogTarget,
  StartupRestoreState,
  StartupRestoreStateListener,
  WebviewOpenTabListener,
  WebviewOpenTabRequest
} from "../shared/contracts";

const api: DesktopApi = {
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("clipboard.writeText", text)
  },
  assistant: {
    getSettings: () => ipcRenderer.invoke("assistant.getSettings"),
    saveSettings: (input: AssistantSettingsInput) => ipcRenderer.invoke("assistant.saveSettings", input),
    getMemorySettings: () => ipcRenderer.invoke("assistant.getMemorySettings"),
    saveMemorySettings: (input: AssistantMemorySettingsInput) =>
      ipcRenderer.invoke("assistant.saveMemorySettings", input),
    getMemorySummary: () => ipcRenderer.invoke("assistant.getMemorySummary"),
    listAgents: () => ipcRenderer.invoke("assistant.listAgents"),
    openMemoryDirectory: () => ipcRenderer.invoke("assistant.openMemoryDirectory"),
    listMemoryItems: () => ipcRenderer.invoke("assistant.listMemoryItems"),
    deleteMemoryItem: (memoryId: string) => ipcRenderer.invoke("assistant.deleteMemoryItem", memoryId),
    clearMemoryItems: () => ipcRenderer.invoke("assistant.clearMemoryItems"),
    listChats: () => ipcRenderer.invoke("assistant.listChats"),
    getChat: (chatId: string) => ipcRenderer.invoke("assistant.getChat", chatId),
    pickAttachments: (chatId?: string | null) => ipcRenderer.invoke("assistant.pickAttachments", chatId),
    cancelAttachmentTask: (taskId: string) => ipcRenderer.invoke("assistant.cancelAttachmentTask", taskId),
    addPastedImage: (chatId: string | null | undefined, input: AssistantPastedImageInput) =>
      ipcRenderer.invoke("assistant.addPastedImage", chatId, input),
    captureScreenshot: (chatId?: string | null) => ipcRenderer.invoke("assistant.captureScreenshot", chatId),
    startRun: (request: AssistantStartRunRequest) => ipcRenderer.invoke("assistant.startRun", request),
    stopRun: (runId: string) => ipcRenderer.invoke("assistant.stopRun", runId),
    correctVoiceText: (request: AssistantVoiceCorrectionRequest) =>
      ipcRenderer.invoke("assistant.correctVoiceText", request),
    transcribeVoiceAudio: (request: AssistantVoiceTranscriptionRequest) =>
      ipcRenderer.invoke("assistant.transcribeVoiceAudio", request),
    submitAwaiting: (request: AssistantSubmitAwaitingRequest) => ipcRenderer.invoke("assistant.submitAwaiting", request),
    openAttachment: (chatId: string, attachmentId: string) =>
      ipcRenderer.invoke("assistant.openAttachment", chatId, attachmentId),
    deleteChat: (chatId: string) => ipcRenderer.invoke("assistant.deleteChat", chatId),
    onAssistantEvent: (listener: AssistantEventListener) => {
      const handleAssistantEvent = (_event: Electron.IpcRendererEvent, payload: AssistantEvent) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.event", handleAssistantEvent);
      return () => {
        ipcRenderer.off("assistant.event", handleAssistantEvent);
      };
    },
    onAttachmentProgress: (listener: AssistantAttachmentProgressListener) => {
      const handleAttachmentProgress = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<AssistantAttachmentProgressListener>[0]
      ) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.attachmentProgress", handleAttachmentProgress);
      return () => {
        ipcRenderer.off("assistant.attachmentProgress", handleAttachmentProgress);
      };
    }
  },
  services: {
    list: () => ipcRenderer.invoke("services.list"),
    getStartupRestoreState: () => ipcRenderer.invoke("services.getStartupRestoreState"),
    installBuiltinFromBundle: (serviceId: ServiceId) =>
      ipcRenderer.invoke("services.installBuiltinFromBundle", serviceId),
    installBuiltin: (serviceId: ServiceId) => ipcRenderer.invoke("services.installBuiltin", serviceId),
    initialize: (serviceId: ServiceId) => ipcRenderer.invoke("services.initialize", serviceId),
    getStatus: (serviceId: ServiceId) => ipcRenderer.invoke("services.getStatus", serviceId),
    start: (serviceId: ServiceId) => ipcRenderer.invoke("services.start", serviceId),
    stop: (serviceId: ServiceId) => ipcRenderer.invoke("services.stop", serviceId),
    restart: (serviceId: ServiceId) => ipcRenderer.invoke("services.restart", serviceId),
    readConfig: (serviceId: ServiceId, key: string) => ipcRenderer.invoke("services.readConfig", serviceId, key),
    writeConfig: (serviceId: ServiceId, key: string, content: string) =>
      ipcRenderer.invoke("services.writeConfig", serviceId, key, content),
    importFile: (serviceId: ServiceId, targetKey: string) =>
      ipcRenderer.invoke("services.importFile", serviceId, targetKey),
    getLogsMeta: (serviceId: ServiceId) => ipcRenderer.invoke("services.getLogsMeta", serviceId),
    readLog: (serviceId: ServiceId, target: ServiceLogTarget, options?: ServiceLogReadOptions) =>
      ipcRenderer.invoke("services.readLog", serviceId, target, options),
    watchLog: (
      serviceId: ServiceId,
      target: ServiceLogTarget,
      options: ServiceLogStreamOptions | undefined,
      listener: ServiceLogStreamListener
    ) => {
      const subscriptionId = `log-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handleLogStream = (_event: Electron.IpcRendererEvent, payload: ServiceLogStreamEvent) => {
        if (payload.subscriptionId === subscriptionId) {
          listener(payload);
        }
      };

      ipcRenderer.on("services.logStream", handleLogStream);
      void ipcRenderer.invoke("services.watchLog.start", subscriptionId, serviceId, target, options);

      return () => {
        ipcRenderer.off("services.logStream", handleLogStream);
        void ipcRenderer.invoke("services.watchLog.stop", subscriptionId);
      };
    },
    openLogViewer: (request: ServiceOpenLogViewerRequest) => ipcRenderer.invoke("services.openLogViewer", request),
    closeLogViewer: () => ipcRenderer.invoke("services.closeLogViewer")
  },
  plugins: {
    install: () => ipcRenderer.invoke("plugins.install"),
    uninstall: (serviceId: ServiceId) => ipcRenderer.invoke("plugins.uninstall", serviceId)
  },
  market: {
    list: () => ipcRenderer.invoke("market.list"),
    refresh: () => ipcRenderer.invoke("market.refresh"),
    install: (itemId: string) => ipcRenderer.invoke("market.install", itemId),
    update: (itemId: string) => ipcRenderer.invoke("market.update", itemId),
    uninstall: (itemId: string) => ipcRenderer.invoke("market.uninstall", itemId),
    importSkill: () => ipcRenderer.invoke("market.importSkill")
  },
  panAuth: {
    importPrivateKey: () => ipcRenderer.invoke("panAuth.importPrivateKey"),
    getStatus: () => ipcRenderer.invoke("panAuth.getStatus")
  },
  agentAuth: {
    issueAccessToken: (reason) => ipcRenderer.invoke("agentAuth.issueAccessToken", reason)
  },
  settings: {
    getDataRoot: () => ipcRenderer.invoke("settings.getDataRoot"),
    getPlatform: () => ipcRenderer.invoke("settings.getPlatform"),
    setSidebarTranslucency: (enabled) => ipcRenderer.invoke("settings.setSidebarTranslucency", enabled)
  },
  windowDrag: {
    begin: (point) => ipcRenderer.invoke("windowDrag.begin", point),
    end: () => ipcRenderer.invoke("windowDrag.end")
  },
  desktopPet: {
    getSettings: () => ipcRenderer.invoke("desktopPet.getSettings"),
    getState: () => ipcRenderer.invoke("desktopPet.getState"),
    saveSettings: (input) => ipcRenderer.invoke("desktopPet.saveSettings", input),
    show: () => ipcRenderer.invoke("desktopPet.show"),
    hide: () => ipcRenderer.invoke("desktopPet.hide"),
    openAssistant: () => ipcRenderer.invoke("desktopPet.openAssistant"),
    moveBy: (delta) => ipcRenderer.invoke("desktopPet.moveBy", delta),
    beginDrag: (point) => ipcRenderer.invoke("desktopPet.beginDrag", point),
    endDrag: () => ipcRenderer.invoke("desktopPet.endDrag"),
    setPreviewExpanded: (expanded) => ipcRenderer.invoke("desktopPet.setPreviewExpanded", expanded),
    dismissPreview: () => ipcRenderer.invoke("desktopPet.dismissPreview"),
    setMouseInteractive: (interactive) => ipcRenderer.invoke("desktopPet.setMouseInteractive", interactive),
    onStateChanged: (listener: DesktopPetStateListener) => {
      const handleDesktopPetStateChanged = (
        _event: Electron.IpcRendererEvent,
        state: Parameters<DesktopPetStateListener>[0]
      ) => {
        listener(state);
      };

      ipcRenderer.on("desktopPet.state", handleDesktopPetStateChanged);
      return () => {
        ipcRenderer.off("desktopPet.state", handleDesktopPetStateChanged);
      };
    },
    onDanceRequested: (listener: DesktopPetDanceRequestedListener) => {
      const handleDesktopPetDanceRequested = () => {
        listener();
      };

      ipcRenderer.on("desktopPet.danceRequested", handleDesktopPetDanceRequested);
      return () => {
        ipcRenderer.off("desktopPet.danceRequested", handleDesktopPetDanceRequested);
      };
    }
  },
  quickAssistant: {
    setExpanded: (expanded: boolean) => ipcRenderer.invoke("quickAssistant.setExpanded", expanded),
    setDisplayMode: (mode: "compact" | "attachment" | "compactMenu" | "menu" | "expanded") =>
      ipcRenderer.invoke("quickAssistant.setDisplayMode", mode),
    setInteractionState: (state) => ipcRenderer.invoke("quickAssistant.setInteractionState", state),
    onCompactModeRequested: (listener) => {
      const handleCompactModeRequested = () => {
        listener();
      };

      ipcRenderer.on("quickAssistant.compactModeRequested", handleCompactModeRequested);
      return () => {
        ipcRenderer.off("quickAssistant.compactModeRequested", handleCompactModeRequested);
      };
    },
    pickAttachments: (chatId?: string | null) => ipcRenderer.invoke("quickAssistant.pickAttachments", chatId),
    captureScreenshot: (chatId?: string | null) => ipcRenderer.invoke("quickAssistant.captureScreenshot", chatId),
    cancelAttachmentTask: (taskId: string) => ipcRenderer.invoke("quickAssistant.cancelAttachmentTask", taskId),
    hide: () => ipcRenderer.invoke("quickAssistant.hide"),
    openMainAssistant: (chatId?: string | null) => ipcRenderer.invoke("quickAssistant.openMainAssistant", chatId),
    openSettings: () => ipcRenderer.invoke("quickAssistant.openSettings")
  },
  customSidebar: {
    list: () => ipcRenderer.invoke("customSidebar.list"),
    add: (input) => ipcRenderer.invoke("customSidebar.add", input),
    remove: (id: string) => ipcRenderer.invoke("customSidebar.remove", id),
    import: () => ipcRenderer.invoke("customSidebar.import"),
    export: () => ipcRenderer.invoke("customSidebar.export")
  },
  onNavigate: (listener: NavigateListener) => {
    const handleNavigate = (_event: Electron.IpcRendererEvent, path: string) => {
      listener(path);
    };

    ipcRenderer.on("app.navigate", handleNavigate);
    return () => {
      ipcRenderer.off("app.navigate", handleNavigate);
    };
  },
  onServicesChanged: (listener: ServicesChangedListener) => {
    const handleServicesChanged = () => {
      listener();
    };

    ipcRenderer.on("services.changed", handleServicesChanged);
    return () => {
      ipcRenderer.off("services.changed", handleServicesChanged);
    };
  },
  onStartupRestoreState: (listener: StartupRestoreStateListener) => {
    const handleStartupRestoreState = (_event: Electron.IpcRendererEvent, state: StartupRestoreState) => {
      listener(state);
    };

    ipcRenderer.on("services.startupRestoreState", handleStartupRestoreState);
    return () => {
      ipcRenderer.off("services.startupRestoreState", handleStartupRestoreState);
    };
  },
  onOpenAssistantWorker: (listener: AssistantWorkerOpenListener) => {
    const handleOpenAssistantWorker = (
      _event: Electron.IpcRendererEvent,
      request: AssistantWorkerOpenRequest
    ) => {
      listener(request);
    };

    ipcRenderer.on("app.openAssistantWorker", handleOpenAssistantWorker);
    return () => {
      ipcRenderer.off("app.openAssistantWorker", handleOpenAssistantWorker);
    };
  },
  onWebviewOpenTab: (listener: WebviewOpenTabListener) => {
    const handleWebviewOpenTab = (
      _event: Electron.IpcRendererEvent,
      request: WebviewOpenTabRequest
    ) => {
      listener(request);
    };

    ipcRenderer.on("webview.openTab", handleWebviewOpenTab);
    return () => {
      ipcRenderer.off("webview.openTab", handleWebviewOpenTab);
    };
  },
  onNativeDialogVisibility: (listener: NativeDialogVisibilityListener) => {
    const handleNativeDialogVisibility = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<NativeDialogVisibilityListener>[0]
    ) => {
      listener(state);
    };

    ipcRenderer.on("app.nativeDialogVisibility", handleNativeDialogVisibility);
    return () => {
      ipcRenderer.off("app.nativeDialogVisibility", handleNativeDialogVisibility);
    };
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);
