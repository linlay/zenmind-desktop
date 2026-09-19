import { ConnectorError, type WebappContext } from "./webapp-platform-client";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./runtime.part-1";

// Compatibility for installed SDK clients. Installation already grants access;
// there is no per-capability consent state or confirmation dialog.
export async function requestWebappPermission(_options: DesktopActionBridgeOptions, context: WebappContext,
  invocation: DesktopActionInvocationContext, capability: string, connectorId?: string, adapter?: string) {
  if (invocation.kind !== "webappPage") throw new ConnectorError("forbidden");
  if (capability !== "connector.execute" && capability !== "kanban.read") throw new ConnectorError("invalid_arguments");
  if (capability === "connector.execute" &&
      (typeof connectorId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(connectorId) ||
       (adapter !== "cli" && adapter !== "mcp"))) throw new ConnectorError("invalid_arguments");
  await context.check();
  return { status: "granted" as const };
}
