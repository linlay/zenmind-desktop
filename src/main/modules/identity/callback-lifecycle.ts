import type http from "node:http";
import type { App } from "electron";
import { desktopSsoRuntimeState } from "./oidc-sso.part-1";

export const CALLBACK_TIMEOUT_MS = 5 * 60_000;
let timeout: ReturnType<typeof setTimeout> | undefined;
let removeQuitListener: (() => void) | undefined;

export function closeCallbackServer(
  expectedServers = desktopSsoRuntimeState.callbackServers,
  force = false
) {
  // A late response from an old attempt must never close a newer listener.
  if (desktopSsoRuntimeState.callbackServers !== expectedServers) return;
  clearTimeout(timeout);
  timeout = undefined;
  removeQuitListener?.();
  removeQuitListener = undefined;
  desktopSsoRuntimeState.callbackServers = [];
  desktopSsoRuntimeState.callbackServerReady = null;
  desktopSsoRuntimeState.callbackServerInfo = null;
  desktopSsoRuntimeState.desktopSsoProxyState = null;
  for (const server of expectedServers) {
    server.close(() => {});
    if (force) server.closeAllConnections();
    else server.closeIdleConnections();
  }
}

export function armCallbackCleanup(app: App, servers: http.Server[], onTimeout: () => void) {
  timeout = setTimeout(() => {
    if (desktopSsoRuntimeState.callbackServers !== servers) return;
    closeCallbackServer(servers, true);
    onTimeout();
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();
  const onQuit = () => closeCallbackServer(servers, true);
  app.once?.("will-quit", onQuit);
  removeQuitListener = () => app.removeListener?.("will-quit", onQuit);
}

export function getCallbackOrigin() {
  const info = desktopSsoRuntimeState.callbackServerInfo;
  if (!info) throw new Error("Desktop SSO callback listener is not running.");
  return info.origin;
}
