

export const HOST = "127.0.0.1";

export const DEV_CORS_ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

export const DEV_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export const DEV_CORS_ALLOW_HEADERS = "Content-Type, Authorization, Accept, Cache-Control";

export const DESKTOP_BRIDGE_ONLY_HTTP_PATHS = new Set([
  "/api/query",
  "/api/btw",
  "/api/attach",
  "/api/submit",
  "/api/interrupt",
  "/api/steer",
  "/api/access-level",
]);

export function isDesktopBridgeOnlyHttpPath(requestPath: string) {
  let decodedPath = requestPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    // A malformed encoded path must never be forwarded to a broader /api route.
    return requestPath.startsWith("/api/") || requestPath.startsWith("/ws");
  }
  const normalizedPath = decodedPath.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "") || "/";
  if (normalizedPath === "/ws" || normalizedPath.startsWith("/ws/")) {
    return true;
  }
  return [...DESKTOP_BRIDGE_ONLY_HTTP_PATHS].some(
    (pathPrefix) => normalizedPath === pathPrefix || normalizedPath.startsWith(`${pathPrefix}/`),
  );
}
