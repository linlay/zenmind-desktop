export function createHtmlTestSession() {
  const state = { protocol: null, beforeRequest: null, cleared: false, closed: false, unhandled: false };
  const session = {
    setPermissionRequestHandler(handler) { state.permissionRequest = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheck = handler; },
    setDevicePermissionHandler(handler) { state.devicePermission = handler; },
    on(event, handler) { state[event] = handler; },
    webRequest: { onBeforeRequest(handler) { state.beforeRequest = handler; } },
    protocol: {
      handle(_scheme, handler) { state.protocol = handler; },
      unhandle() { state.unhandled = true; },
    },
    async closeAllConnections() { state.closed = true; },
    async clearStorageData() { state.cleared = true; },
  };
  return { session, state, request: (url, method = "GET") => state.protocol({ url, method }) };
}
