import { contextBridge, ipcRenderer } from "electron";
import type {
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
  codeAssistant: {
    getStatus: () => ipcRenderer.invoke("codeAssistant.getStatus"),
    ensureReady: () => ipcRenderer.invoke("codeAssistant.ensureReady"),
    restartRuntime: () => ipcRenderer.invoke("codeAssistant.restartRuntime"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("codeAssistant.setEnabled", enabled),
    setFullAccessGranted: (granted: boolean) =>
      ipcRenderer.invoke("codeAssistant.setFullAccessGranted", granted),
    getRepoContext: () => ipcRenderer.invoke("codeAssistant.getRepoContext"),
    selectRepoPath: () => ipcRenderer.invoke("codeAssistant.selectRepoPath"),
    setBranch: (branch: string) => ipcRenderer.invoke("codeAssistant.setBranch", branch)
  },
  settings: {
    getDataRoot: () => ipcRenderer.invoke("settings.getDataRoot"),
    changeDataRoot: () => ipcRenderer.invoke("settings.changeDataRoot")
  },
  credentials: {
    getQiuerLogin: () => ipcRenderer.invoke("credentials.getQiuerLogin"),
    saveQiuerLogin: (credentials) => ipcRenderer.invoke("credentials.saveQiuerLogin", credentials)
  },
  onNavigate: (listener: NavigateListener) => {
    const handleNavigate = (_event: Electron.IpcRendererEvent, path: string) => {
      listener(path);
    };

    ipcRenderer.on("app.navigate", handleNavigate);
    return () => {
      ipcRenderer.off("app.navigate", handleNavigate);
    };
  }
};

contextBridge.exposeInMainWorld("electronAPI", api);
