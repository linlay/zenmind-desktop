import { contextBridge, ipcRenderer } from "electron";
import type {
  AssistantEvent,
  AssistantEventListener,
  AssistantPastedImageInput,
  AssistantSettingsInput,
  AssistantSubmitAwaitingRequest,
  AssistantStartRunRequest,
  AssistantVoiceCorrectionRequest,
  AssistantVoiceTranscriptionRequest,
  AssistantWorkerOpenListener,
  AssistantWorkerOpenRequest,
  DesktopApi,
  NavigateListener,
  ServicesChangedListener,
  ServiceId,
  ServiceLogReadOptions,
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
    listChats: () => ipcRenderer.invoke("assistant.listChats"),
    getChat: (chatId: string) => ipcRenderer.invoke("assistant.getChat", chatId),
    pickAttachments: (chatId?: string | null) => ipcRenderer.invoke("assistant.pickAttachments", chatId),
    addPastedImage: (chatId: string | null | undefined, input: AssistantPastedImageInput) =>
      ipcRenderer.invoke("assistant.addPastedImage", chatId, input),
    startRun: (request: AssistantStartRunRequest) => ipcRenderer.invoke("assistant.startRun", request),
    stopRun: (runId: string) => ipcRenderer.invoke("assistant.stopRun", runId),
    correctVoiceText: (request: AssistantVoiceCorrectionRequest) =>
      ipcRenderer.invoke("assistant.correctVoiceText", request),
    transcribeVoiceAudio: (request: AssistantVoiceTranscriptionRequest) =>
      ipcRenderer.invoke("assistant.transcribeVoiceAudio", request),
    submitAwaiting: (request: AssistantSubmitAwaitingRequest) => ipcRenderer.invoke("assistant.submitAwaiting", request),
    deleteChat: (chatId: string) => ipcRenderer.invoke("assistant.deleteChat", chatId),
    onAssistantEvent: (listener: AssistantEventListener) => {
      const handleAssistantEvent = (_event: Electron.IpcRendererEvent, payload: AssistantEvent) => {
        listener(payload);
      };

      ipcRenderer.on("assistant.event", handleAssistantEvent);
      return () => {
        ipcRenderer.off("assistant.event", handleAssistantEvent);
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
      ipcRenderer.invoke("services.readLog", serviceId, target, options)
  },
  plugins: {
    install: () => ipcRenderer.invoke("plugins.install"),
    uninstall: (serviceId: ServiceId) => ipcRenderer.invoke("plugins.uninstall", serviceId)
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
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);
