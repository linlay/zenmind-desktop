/**
 * Shared by the build scripts (raw manifest) and Main (resolved hosting).
 * Keep input normalization and service selection at the call sites.
 * CommonJS lets Node consume the source before the Electron build exists.
 * @param {unknown} routes
 * @returns {string | null}
 */
function getPlatformFramePortRoutesError(routes) {
  if (!Array.isArray(routes)) {
    return "is missing desktop.hosting.proxyRoutes";
  }
  if (routes.some((route) => route?.path === "/auth" || route?.path === "/ws")) {
    return "must not expose /auth or /ws";
  }
  const apiRoutes = routes.filter((route) => route?.match === "prefix" && route?.path === "/api");
  const apiRoute = apiRoutes[0];
  if (
    apiRoutes.length !== 1 ||
    apiRoute?.targetEnv !== "BASE_URL" ||
    apiRoute?.auth !== "agent-platform-access-token" ||
    apiRoute?.http !== true ||
    apiRoute?.websocket === true ||
    (Array.isArray(apiRoute?.ssePaths) && apiRoute.ssePaths.length > 0)
  ) {
    return "requires exactly one HTTP-only authenticated /api route without SSE overrides";
  }
  if (routes.some((route) => route?.targetEnv === "BASE_URL" && route?.websocket === true)) {
    return "must not expose an Agent Platform WebSocket route";
  }
  return null;
}

module.exports = { getPlatformFramePortRoutesError };
