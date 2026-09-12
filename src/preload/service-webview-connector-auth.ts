import { contextBridge, ipcRenderer } from "electron";
import { CONNECTOR_AUTH_BROWSER_CHANNEL, CONNECTOR_AUTH_BROWSER_EVENT, CONNECTOR_AUTH_BROWSER_GLOBAL,
  type ConnectorAuthBrowserBridge, type ConnectorAuthBrowserIdentity } from "../shared/contracts/agent-webclient-bridge";

export function installConnectorAuthBrowser() {
  if (!process.isMainFrame) return;
  const listeners = new Set<(input: ConnectorAuthBrowserIdentity) => void>();
  ipcRenderer.on(CONNECTOR_AUTH_BROWSER_EVENT, (_event, input: ConnectorAuthBrowserIdentity) => {
    for (const listener of listeners) listener(input);
  });
  const bridge: ConnectorAuthBrowserBridge = {
    version: 1,
    open: input => ipcRenderer.invoke(CONNECTOR_AUTH_BROWSER_CHANNEL, { action: "open", input }),
    close: input => ipcRenderer.invoke(CONNECTOR_AUTH_BROWSER_CHANNEL, { action: "close", input }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  contextBridge.exposeInMainWorld(CONNECTOR_AUTH_BROWSER_GLOBAL, bridge);
  window.addEventListener("pagehide", () => listeners.clear(), { once: true });
}
