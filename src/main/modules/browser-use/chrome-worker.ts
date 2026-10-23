import { ChromeWorkerEngine, chromeObservationFailureMessages } from "./chrome-worker-engine";
import type { ChromeWorkerMethod, ChromeWorkerReply, ChromeWorkerRequest } from "./chrome-worker-contract";
import { isAwcpHostError } from "../awcp";

export { ChromeWorkerEngine };

const navigationMethods = new Set<ChromeWorkerMethod>(["open", "navigate", "back", "reload"]);
const pageFailureMessages = {
  page_connection_refused: "The website refused the connection. Check its address and, for a local website, that its service is running.",
  page_name_not_resolved: "Chrome could not resolve the website's address. Check the address and network DNS settings.",
  page_connection_interrupted: "The website connection was interrupted. Check the network and website availability.",
  page_navigation_timeout: "The website did not finish loading within the navigation deadline. It may already have received the request or partially loaded.",
  page_navigation_interrupted: "The navigation was interrupted. It may already have received the request or partially loaded.",
  page_navigation_blocked: "Chrome or a browser policy blocked this navigation. Check the page in Chrome before continuing.",
  page_security_error: "Chrome could not verify the website's secure connection. Check the certificate or security warning in Chrome before continuing.",
  page_navigation_failed: "Chrome could not load the requested page. Check the website address and availability.",
} as const;

function pageFailure(cause: { code?: unknown; name?: unknown }, message: string, method: ChromeWorkerMethod) {
  let code: keyof typeof pageFailureMessages = "page_navigation_failed";
  if (/\bERR_CONNECTION_REFUSED\b/u.test(message)) code = "page_connection_refused";
  else if (/\bERR_NAME_(?:NOT_RESOLVED|RESOLUTION_FAILED)\b/u.test(message)) code = "page_name_not_resolved";
  else if (cause.code === "browser_action_timeout" || cause.name === "TimeoutError" || /\bERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)\b/u.test(message)) code = "page_navigation_timeout";
  else if (/\bERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_ABORTED|CONNECTION_CLOSED|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)\b/u.test(message)) code = "page_connection_interrupted";
  else if (/\bERR_ABORTED\b/u.test(message)) code = "page_navigation_interrupted";
  else if (/\bERR_(?:BLOCKED_BY_CLIENT|BLOCKED_BY_ADMINISTRATOR|NETWORK_ACCESS_DENIED)\b/u.test(message)) code = "page_navigation_blocked";
  else if (/\bERR_(?:CERT_\w+|SSL_\w+)\b/u.test(message)) code = "page_security_error";
  return { code, message: pageFailureMessages[code] + (method === "open"
    ? " A tab may already have been created; no automatic retry or additional tab was opened."
    : " Navigation may already have been sent; no automatic retry was performed.") };
}

/** Never return upstream connection URLs, profile paths or extension credentials. */
export function chromeWorkerResponseError(error: unknown, method: ChromeWorkerMethod): NonNullable<ChromeWorkerReply["error"]> {
  if (isAwcpHostError(error)) return { code: error.code, message: error.message, statusCode: error.statusCode, ...(error.details ? { details: error.details } : {}) };
  const cause = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const message = typeof cause.message === "string" ? cause.message : "";
  if (typeof cause.code === "string" && Object.hasOwn(chromeObservationFailureMessages, cause.code))
    return { code: cause.code, message: chromeObservationFailureMessages[cause.code as keyof typeof chromeObservationFailureMessages] };
  if (method === "open" && cause.code === "browser_page_creation_failed")
    return { code: "browser_page_creation_failed", message: "Chrome could not create or attach the new tab. Check Chrome for a browser debugger conflict or a closed window. A tab may already exist; no automatic retry was performed." };
  const safe = new Set(["invalid_params", "url_not_allowed", "surface_not_found", "stale_observation", "browser_disconnected", "browser_runtime_unavailable", "capability_unavailable", "cancelled", "dialog_pending", "file_chooser_pending", "file_transfer_limit", "download_not_found", "download_not_ready", "download_failed", "observation_unavailable", "observation_budget_exceeded", "observation_timeout"]);
  if (typeof cause.code === "string" && safe.has(cause.code)) return { code: cause.code, message: message.slice(0, 1000) };
  if (method === "connect") {
    if (/Playwright extension did not connect within/i.test(message)) return { code: "chrome_connection_timeout", message: "Chrome connection was not approved in time. Enable the official Playwright Extension in your current Chrome profile, then connect and choose Allow & select." };
    if (/executable not found|Unsupported channel|Chromium distribution.*not found/i.test(message)) return { code: "chrome_unavailable", message: "Chrome could not be opened. Check that Chrome is installed and available, then connect again." };
    return { code: "chrome_connection_failed", message: "Chrome connection was not established. Check that the official Playwright Extension is enabled in your current Chrome profile, then connect and choose Allow & select." };
  }
  if (navigationMethods.has(method)) return pageFailure(cause, message, method);
  return { code: "browser_action_failed", message: "Chrome could not complete the operation. Check the selected page and capture a fresh observation before retrying." };
}

/** The fixture uses the same transport with an owned, isolated Chrome factory; production uses the extension factory. */
export function startChromeWorker(engine: ChromeWorkerEngine): void {
  const methods = new Set<ChromeWorkerMethod>(["connect", "list", "state", "open", "navigate", "back", "reload", "activate", "close", "observe", "click", "interact", "dialog", "upload", "downloads", "screenshot", "disconnect", "cancel", "awcp-manual", "awcp-invoke", "awcp-release-run", "awcp-refresh", "cancel-request"]);
  const utilityPort = (process as typeof process & { parentPort?: { on(event: "message", callback: (event: { data: unknown }) => void): void; postMessage(message: unknown): void } }).parentPort;

  function reply(value: ChromeWorkerReply): void {
    if (utilityPort) utilityPort.postMessage(value);
    else process.send?.(value);
  }

  async function receive(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const request = value as ChromeWorkerRequest;
    if (typeof request.id !== "string" || !request.id || !methods.has(request.method)) {
      if (typeof request.id === "string") reply({ id: request.id, error: { code: "invalid_params", message: "Invalid Chrome worker request" } });
      return;
    }
    if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
      reply({ id: request.id, error: { code: "invalid_params", message: "Browser parameters must be an object" } });
      return;
    }
    try { reply({ id: request.id, result: await engine.request(request) }); }
    catch (error) {
      reply({ id: request.id, error: chromeWorkerResponseError(error, request.method) });
    }
  }

  if (utilityPort) utilityPort.on("message", event => void receive(event.data));
  else if (process.send) process.on("message", value => void receive(value));
  else throw new Error("Chrome worker requires an Electron parentPort or Node IPC channel");

  process.on("disconnect", () => void engine.disconnect().finally(() => process.exit(0)));
}

if (require.main === module) startChromeWorker(new ChromeWorkerEngine());
