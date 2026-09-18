import type { DesktopActionCallRequest } from "../../../shared/desktop-actions";
import { buildInteractElementScript, type EmbeddedWebInteractAction } from "../../../shared/embedded-web-scripts";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./runtime.part-1";
import { fail, ok } from "./runtime.part-1";

/** All page actions resolve the same authorized Surface as desktop_cdp. */
export async function executeWebSurfaceAction(
  options: DesktopActionBridgeOptions, request: DesktopActionCallRequest, invocation: DesktopActionInvocationContext,
) {
  const args = request.args ?? {};
  const action = request.action;
  const source = invocation.kind === "agentPlatform" ? request.source : undefined;
  const surfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
  let method: string;
  let params: Record<string, unknown> = {};
  switch (action) {
    case "desktop.web.listSurfaces": method = "Surface.list"; break;
    case "desktop.web.getSurfaceState": method = "Surface.getState"; break;
    case "desktop.web.activateSurface":
    case "desktop.web.switchTab": method = "Page.bringToFront"; break;
    case "desktop.web.closeTab": method = "Surface.close"; break;
    case "desktop.web.refreshSurface":
    case "desktop.web.reload": method = "Page.reload"; break;
    case "desktop.web.navigate": method = "Page.navigate"; params = { url: args.url }; break;
    case "desktop.web.openTab": method = "Surface.open"; params = { url: args.url }; break;
    case "desktop.web.goBack": method = "Surface.goBack"; break;
    case "desktop.web.executeScript":
      method = "Runtime.evaluate";
      if (typeof args.script !== "string" || !args.script.trim()) return fail(action, "invalid_args", "script is required.");
      params = { expression: args.script, returnByValue: true, awaitPromise: true }; break;
    case "desktop.web.interactElement":
      method = "Runtime.evaluate";
      if (typeof args.selector !== "string" || !["click", "focus", "fill", "select", "scroll"].includes(String(args.action))) {
        return fail(action, "invalid_args", "A selector and supported element action are required.");
      }
      params = { expression: buildInteractElementScript({ selector: args.selector, action: args.action as EmbeddedWebInteractAction,
        ...(typeof args.value === "string" ? { value: args.value } : {}) }), returnByValue: true, awaitPromise: true }; break;
    default: return null;
  }
  try {
    const response = await options.executeCdpCommand({ method, surfaceId, params, ...(source ? { source } : {}) });
    return ok(action, response.result);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "web_action_failed";
    return fail(action, code, error instanceof Error ? error.message : String(error));
  }
}
