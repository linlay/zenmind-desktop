import { contextBridge, ipcRenderer } from "electron";
import { SYSTEM_WINDOW_MESSAGE, SYSTEM_WINDOW_EVENT } from "../shared/system-window-channels";

const listeners = new Set<(value: unknown) => void>();
const queued: unknown[] = [];
ipcRenderer.on(SYSTEM_WINDOW_EVENT, (_event, data) => {
  if (!listeners.size) { if (queued.length < 100) queued.push(data); return; }
  for (const callback of listeners) callback(data);
});
contextBridge.exposeInMainWorld("pluginWindow", {
  send(data: unknown) { ipcRenderer.send(SYSTEM_WINDOW_MESSAGE, data); },
  subscribe(callback: (value: unknown) => void) {
    listeners.add(callback);
    for (const event of queued.splice(0)) callback(event);
    return () => listeners.delete(callback);
  }
});
