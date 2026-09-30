import { contextBridge, ipcRenderer } from "electron";
import { WEBAPP_AUTH_CHANNEL, WEBAPP_AUTH_GLOBAL, type WebappAuthSessionInput } from "../shared/webapp-auth";

// This transport grants no authority: Main independently checks the live top
// frame, registered surface and an explicit native consent before reading SSO.
if (process.isMainFrame && ["http:", "https:"].includes(location.protocol)) {
  contextBridge.exposeInMainWorld(WEBAPP_AUTH_GLOBAL, Object.freeze({
    createSession(input: WebappAuthSessionInput) {
      return ipcRenderer.invoke(WEBAPP_AUTH_CHANNEL, input);
    }
  }));
}
