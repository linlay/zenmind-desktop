import { dialog } from "electron";
import { t } from "../../support/i18n/main-i18n";
import { ConnectorError, type WebappContext } from "./webapp-platform-client";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./runtime.part-1";

// Runtime-scoped consent: a manifest declares demand, it does not grant access.
// Restart, package/config replacement or a different identity requires consent again.
const approvals = new Map<string, Set<string>>();
export function executionPermissionKey(connectorId: string, adapter: string) { return `connector.execute:${connectorId}:${adapter}`; }
export function hasWebappPermission(context: WebappContext, capability: string): boolean {
  if (capability === "connector.execute") return (context.item.desktopBridge?.connectorExecution ?? []).length > 0 && context.item.desktopBridge!.connectorExecution!.every(p => hasWebappPermission(context, executionPermissionKey(p.connectorId,p.adapter)));

  return approvals.get(context.key)?.has(capability) === true;
}
export function requireWebappPermission(context: WebappContext, capability: string) {
  if (!hasWebappPermission(context, capability)) throw new ConnectorError("app_permission_required");
}
export async function requestWebappPermission(options: DesktopActionBridgeOptions, context: WebappContext,
  invocation: DesktopActionInvocationContext, capability: string, connectorId?: string, adapter?: string) {
  if (invocation.kind !== "webappPage") throw new ConnectorError("forbidden");
  if (capability !== "connector.execute" && capability !== "kanban.read") throw new ConnectorError("invalid_arguments");
  const execution = capability === "connector.execute";
  const declared = execution ? context.item.desktopBridge?.version === 2 && context.item.desktopBridge.connectorExecution?.some(p => p.connectorId === connectorId && p.adapter === adapter) : context.item.desktopBridge?.kanbanRead === true;
  if (!declared) throw new ConnectorError("connector_execution_not_allowed");
  const key = execution ? executionPermissionKey(connectorId!, adapter!) : capability;
  if (hasWebappPermission(context, key)) return { status: "granted" as const };
  const owner = options.getMainWindow();
  if (!owner || owner.isDestroyed()) throw new ConnectorError("desktop_unavailable");
  const choice = await dialog.showMessageBox(owner, {
    type: "question", message: t("webapp.permission.title"),
    detail: t(execution ? "webapp.permission.executionDetail" : "webapp.permission.detail", { appId: context.appId, capability, connectorId: connectorId ?? "", adapter: adapter ?? "" }),
    buttons: [t("webapp.permission.allow"), t("common.cancel")], defaultId: 1, cancelId: 1
  });
  await context.check();
  if (choice.response !== 0) return { status: "denied" as const };
  if (approvals.size >= 1024 && !approvals.has(context.key)) throw new ConnectorError("app_capacity_exceeded");
  const set = approvals.get(context.key) ?? new Set<string>();
  set.add(key); approvals.set(context.key, set);
  return { status: "granted" as const };
}
