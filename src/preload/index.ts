import { contextBridge, ipcRenderer } from "electron";
import type {
  AssistantWorkerOpenListener,
  AssistantWorkerOpenRequest,
  DesktopApi,
  NavigateListener,
  ServiceId,
  ServiceLogReadOptions,
  ServiceLogTarget
} from "../shared/contracts";

const api: DesktopApi = {
  services: {
    list: () => ipcRenderer.invoke("services.list"),
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
    getDataRoot: () => ipcRenderer.invoke("settings.getDataRoot")
  },
  customSidebar: {
    list: () => ipcRenderer.invoke("customSidebar.list"),
    add: (input) => ipcRenderer.invoke("customSidebar.add", input),
    remove: (id: string) => ipcRenderer.invoke("customSidebar.remove", id)
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
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);
