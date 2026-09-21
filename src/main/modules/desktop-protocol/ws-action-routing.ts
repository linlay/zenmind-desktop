import {
  getDesktopActionDefinition,
  type DesktopActionDefinition,
  DESKTOP_ACTION_DEFINITIONS,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse
} from "../../../shared/desktop-actions";
import { type PublicActionDefinition, type DesktopWsServerOptions, type DesktopWsConnection, type DesktopWsRequestFrame } from "./ws-contracts";
import { asRecord, readText, nowIso, readNamespace } from "./ws-values";
import { handleDesktopActionRequest } from "../desktop-actions";
import {
  type KanbanIssueInput,
  type KanbanIssueUpdateInput,
  type KanbanIssueMoveInput,
  type AssistantStartRunRequest
} from "../../../shared/contracts";
import {
  DESKTOP_WS_NAMESPACE_DESKTOP,
  DESKTOP_WS_NAMESPACE_WEBAPP,
  DESKTOP_WS_REQUEST_TYPES,
  DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
  DESKTOP_WS_NAMESPACE_FIELD,
  DESKTOP_WS_NAMESPACES,
  DESKTOP_WS_PUSH_TYPES,
  DESKTOP_WS_NAMESPACE_AGENT_PLATFORM
} from "../../../shared/desktop-ws";
import { sendError, sendResponse } from "./ws-wire";
import { getDesktopDeviceId } from "../identity";
import { authenticateDesktopWsProtocolSession, refreshDesktopWsConnectionAuth, readAuthRefreshReason } from "./ws-authentication";
import { AgentPlatformWsBridge } from "./ws-platform-adapter";

export const PUBLIC_ACTION_ALIASES: Record<string, string> = {
  "navigation.toRoute": "desktop.navigate.toRoute",

  "service.list": "desktop.controlCenter.listServices",
  "service.get": "desktop.controlCenter.getServiceDetail",
  "service.status": "desktop.controlCenter.getServiceStatus",
  "service.logs.meta": "desktop.controlCenter.getServiceLogsMeta",
  "service.logs.read": "desktop.controlCenter.readServiceLog",
  "service.start": "desktop.controlCenter.startService",
  "service.stop": "desktop.controlCenter.stopService",
  "service.restart": "desktop.controlCenter.restartService",

  "market.settings": "desktop.market.getSettings",
  "market.list": "desktop.market.listItems",
  "market.refresh": "desktop.market.refresh",
  "market.get": "desktop.market.getItemDetail",
  "market.install": "desktop.market.installItem",
  "market.update": "desktop.market.updateItem",
  "market.uninstall": "desktop.market.uninstallItem",

  "help.open": "desktop.help.openTopic",

  "kanban.issue.list": "desktop.kanban.listIssues",
  "kanban.issue.get": "desktop.kanban.getIssue",
  "kanban.issue.create": "desktop.kanban.createIssue",
  "kanban.issue.update": "desktop.kanban.updateIssue",
  "kanban.issue.delete": "desktop.kanban.deleteIssue",
  "kanban.issue.move": "desktop.kanban.moveIssue",

  "site.list": "desktop.site.list",
  "web.listSurfaces": "desktop.web.listSurfaces",
  "web.getSurfaceState": "desktop.web.getSurfaceState",
  "web.activateSurface": "desktop.web.activateSurface",
  "web.navigate": "desktop.web.navigate",
  "web.reload": "desktop.web.reload",
  "web.refreshSurface": "desktop.web.refreshSurface",
  "web.goBack": "desktop.web.goBack",
  "web.openTab": "desktop.web.openTab",
  "web.closeTab": "desktop.web.closeTab",
  "web.switchTab": "desktop.web.switchTab",
  "website.list": "desktop.website.list",
  "website.add": "desktop.website.add",
  "website.update": "desktop.website.update",
  "website.remove": "desktop.website.remove",
  "webapp.getStatus": "desktop.webapp.getStatus",
  "webapp.checkRuntime": "desktop.webapp.checkRuntime",
  "webapp.start": "desktop.webapp.start",
  "webapp.stop": "desktop.webapp.stop",
  "webapp.restart": "desktop.webapp.restart",
  "webapp.open": "desktop.webapp.open",
  "webapp.install": "desktop.webapp.install",
  "webapp.uninstall": "desktop.webapp.uninstall",
  "webapp.getPublishStatus": "desktop.webapp.getPublishStatus",
  "webapp.publish": "desktop.webapp.publish",
  "webapp.unpublish": "desktop.webapp.unpublish"
};

export const BLOCKED_PUBLIC_ACTION_NAMES = new Set([
  "web.list",
  "web.surfaces",
  "web.active",
  "web.activate",
  "web.context",
  "web.read",
  "web.getPageContext",
  "web.readPageData",
  "web.extractStructured",
  "web.interactElement",
  "web.executeScript",
  "web.back",
  "web.tab.open",
  "web.tab.close",
  "web.tab.switch",
  "webapp.status",
  "pet.settings",
  "pet.appearances",
  "help.openTopic",
  "agent.open",
  "agent.update",
  "skill.open",
  "skill.update",
  "kanban.listIssues",
  "kanban.getIssue",
  "kanban.createIssue",
  "kanban.updateIssue",
  "kanban.deleteIssue",
  "kanban.moveIssue"
]);

export const DIRECT_ACTION_TYPES = new Set([
  "service.list",
  "service.get",
  "service.status"
]);

export function normalizePublicActionName(action: string) {
  const normalized = action.trim();
  if (!normalized) {
    return "";
  }
  if (PUBLIC_ACTION_ALIASES[normalized]) {
    return PUBLIC_ACTION_ALIASES[normalized];
  }
  if (BLOCKED_PUBLIC_ACTION_NAMES.has(normalized)) {
    return normalized;
  }
  if (getDesktopActionDefinition(normalized)) {
    return normalized;
  }
  const legacy = normalized.startsWith("desktop.") ? normalized : `desktop.${normalized}`;
  return getDesktopActionDefinition(legacy) ? legacy : normalized;
}

export function listPublicActions(): PublicActionDefinition[] {
  const byInternal = new Map<string, DesktopActionDefinition>(
    DESKTOP_ACTION_DEFINITIONS.map((definition) => [definition.name, definition])
  );
  const actions: PublicActionDefinition[] = [];
  const seen = new Set<string>();
  for (const [action, internalAction] of Object.entries(PUBLIC_ACTION_ALIASES)) {
    const definition = byInternal.get(internalAction);
    if (!definition || seen.has(action)) {
      continue;
    }
    seen.add(action);
    actions.push({
      ...definition,
      name: action,
      action,
      internalAction
    });
  }
  for (const definition of DESKTOP_ACTION_DEFINITIONS) {
    const publicName = definition.name.replace(/^desktop\./u, "");
    if (BLOCKED_PUBLIC_ACTION_NAMES.has(publicName)) {
      continue;
    }
    if (seen.has(publicName)) {
      continue;
    }
    seen.add(publicName);
    actions.push({
      ...definition,
      name: publicName,
      action: publicName,
      internalAction: definition.name
    });
  }
  return actions;
}

export function actionPayload(action: string, payload: unknown): DesktopActionCallRequest {
  const record = asRecord(payload);
  return {
    requestId: readText(record.requestId),
    action: normalizePublicActionName(readText(record.action) || action),
    args: asRecord(record.args),
    source: asRecord(record.source),
    permissionMode: readText(record.permissionMode) as DesktopActionCallRequest["permissionMode"],
    expectedPageKey: readText(record.expectedPageKey)
  };
}

export async function callDesktopAction(options: DesktopWsServerOptions, action: string, payload: unknown): Promise<DesktopActionCallResponse> {
  return handleDesktopActionRequest(options.desktopActionOptions, actionPayload(action, payload));
}

export function getKanbanRuntime(options: DesktopWsServerOptions) {
  const runtime = options.getKanbanRuntime();
  if (!runtime) {
    throw new Error("Kanban runtime is not initialized");
  }
  return runtime;
}

export function readIssueId(payload: unknown) {
  const record = asRecord(payload);
  return readText(record.id) || readText(record.issueId);
}

export function readIssueCreateInput(payload: unknown): KanbanIssueInput {
  const record = asRecord(payload);
  const nested = asRecord(record.input);
  return (Object.keys(nested).length > 0 ? nested : record) as unknown as KanbanIssueInput;
}

export function readIssueUpdateInput(payload: unknown): { issueId: string; input: KanbanIssueUpdateInput } {
  const record = asRecord(payload);
  return {
    issueId: readIssueId(record),
    input: asRecord(record.input) as unknown as KanbanIssueUpdateInput
  };
}

export function readIssueMoveInput(payload: unknown): KanbanIssueMoveInput {
  return asRecord(payload) as unknown as KanbanIssueMoveInput;
}

export function unsupported(type: string) {
  return {
    code: "unsupported",
    message: `${type} is reserved but not implemented in Desktop WS v1.`
  };
}

export async function handleRequest(
  options: DesktopWsServerOptions,
  connection: DesktopWsConnection,
  req: DesktopWsRequestFrame,
  namespace: typeof DESKTOP_WS_NAMESPACE_DESKTOP | typeof DESKTOP_WS_NAMESPACE_WEBAPP
) {
  const type = readText(req.type);
  const id = readText(req.id);
  if (!type || !id) {
    sendError(connection, namespace, id || undefined, "invalid_request", 400, "request type and id are required");
    return;
  }
  if (!DESKTOP_WS_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, namespace, id, "invalid_request", 400, `unknown type: ${type}`);
    return;
  }
  if (!DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES.includes(type as any)) {
    sendError(connection, namespace, id, "unsupported", 501, unsupported(type).message, unsupported(type));
    return;
  }

  const payload = req.payload;
  switch (type) {
    case "session.hello":
      sendResponse(connection, namespace, type, id, {
        sessionId: connection.id,
        protocolVersion: 1,
        server: "desktop-ws",
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        defaultNamespace: DESKTOP_WS_NAMESPACE_DESKTOP,
        namespaces: DESKTOP_WS_NAMESPACES,
        deviceId: getDesktopDeviceId(options.app),
        auth: {
          subject: connection.auth.subject,
          deviceId: connection.auth.deviceId,
          scope: connection.auth.scope,
          expiresAt: connection.auth.expiresAt
        },
        requestTypes: DESKTOP_WS_REQUEST_TYPES,
        pushTypes: DESKTOP_WS_PUSH_TYPES
      });
      return;
    case "auth.refresh": {
      const payloadRecord = asRecord(payload);
      const token = readText(payloadRecord.token);
      if (token) {
        try {
          connection.auth = await authenticateDesktopWsProtocolSession(options, token, connection.auth.subprotocol);
          sendResponse(connection, namespace, type, id, { token, expiresAt: connection.auth.expiresAt });
        } catch {
          sendError(connection, namespace, id, "unauthorized", 401, "invalid token");
        }
        return;
      }
      try {
        const refreshed = await refreshDesktopWsConnectionAuth(options, connection, readAuthRefreshReason(payloadRecord));
        sendResponse(connection, namespace, type, id, { token: refreshed.token, expiresAt: refreshed.auth.expiresAt });
      } catch {
        sendError(connection, namespace, id, "auth_refresh_failed", 503, "token refresh failed");
      }
      return;
    }
    case "capability.list":
      sendResponse(connection, namespace, type, id, {
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        defaultNamespace: DESKTOP_WS_NAMESPACE_DESKTOP,
        namespaces: DESKTOP_WS_NAMESPACES,
        requestTypes: DESKTOP_WS_REQUEST_TYPES,
        implementedRequestTypes: DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
        pushTypes: DESKTOP_WS_PUSH_TYPES,
        actions: listPublicActions()
      });
      return;
    case "event.subscribe": {
      const types = Array.isArray(asRecord(payload).types)
        ? (asRecord(payload).types as unknown[]).map(readText).filter(Boolean)
        : [];
      for (const nextType of types) {
        connection.subscriptions.add(nextType);
      }
      sendResponse(connection, namespace, type, id, { types: [...connection.subscriptions] });
      return;
    }
    case "event.unsubscribe": {
      const types = Array.isArray(asRecord(payload).types)
        ? (asRecord(payload).types as unknown[]).map(readText).filter(Boolean)
        : [];
      if (types.length === 0) {
        connection.subscriptions.clear();
      } else {
        for (const nextType of types) {
          connection.subscriptions.delete(nextType);
        }
      }
      sendResponse(connection, namespace, type, id, { types: [...connection.subscriptions] });
      return;
    }
    case "action.list":
      sendResponse(connection, namespace, type, id, { actions: listPublicActions() });
      return;
    case "action.call": {
      const response = await callDesktopAction(options, "", payload);
      if (!response.ok) {
        sendError(connection, namespace, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, namespace, type, id, response);
      return;
    }
    case "snapshot.get":
      sendResponse(connection, namespace, type, id, getKanbanRuntime(options).listIssues());
      return;
    case "webapp.list":
      if (!options.listMobileWebapps) {
        sendError(connection, namespace, id, "webapp_catalog_unavailable", 503, "WebApp catalog is not available.");
        return;
      }
      sendResponse(connection, namespace, type, id, options.listMobileWebapps());
      return;
    case "issue.create":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).createIssue(readIssueCreateInput(payload)));
      return;
    case "issue.update": {
      const update = readIssueUpdateInput(payload);
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).updateIssue(update.issueId, update.input));
      return;
    }
    case "issue.delete":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).deleteIssueWithAutomation(readIssueId(payload)));
      return;
    case "issue.move":
      sendResponse(connection, namespace, type, id, await getKanbanRuntime(options).moveIssue(readIssueMoveInput(payload)));
      return;
    case "device.status":
      sendResponse(connection, namespace, type, id, {
        deviceId: getDesktopDeviceId(options.app),
        serverTime: nowIso(),
        connectionCount: connection.server.connections.size
      });
      return;
    case "runtime.info":
      sendResponse(connection, namespace, type, id, options.desktopActionOptions.getDesktopAppInfo());
      return;
    case "assistant.startRun":
      sendResponse(connection, namespace, type, id, await options.assistantBridge.startRun(asRecord(payload) as unknown as AssistantStartRunRequest));
      return;
    case "service.list":
    case "service.get":
    case "service.status": {
      const response = await callDesktopAction(options, type, { args: asRecord(payload) });
      if (!response.ok) {
        sendError(connection, namespace, id, response.error?.code || "action_failed", 400, response.error?.message || "action failed", response);
        return;
      }
      sendResponse(connection, namespace, type, id, response.result ?? response.preview ?? response);
      return;
    }
    default:
      if (DIRECT_ACTION_TYPES.has(type)) {
        const response = await callDesktopAction(options, type, { args: asRecord(payload) });
        sendResponse(connection, namespace, type, id, response);
        return;
      }
      sendError(connection, namespace, id, "unsupported", 501, unsupported(type).message, unsupported(type));
  }
}

export function handleTextMessage(options: DesktopWsServerOptions, connection: DesktopWsConnection, text: string) {
  let parsed: DesktopWsRequestFrame;
  try {
    parsed = JSON.parse(text) as DesktopWsRequestFrame;
  } catch {
    sendError(connection, DESKTOP_WS_NAMESPACE_DESKTOP, undefined, "invalid_request", 400, "invalid JSON frame");
    return;
  }
  const namespace = readNamespace(parsed);
  if (
    namespace !== DESKTOP_WS_NAMESPACE_DESKTOP &&
    namespace !== DESKTOP_WS_NAMESPACE_AGENT_PLATFORM &&
    namespace !== DESKTOP_WS_NAMESPACE_WEBAPP
  ) {
    sendError(
      connection,
      DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "invalid_namespace",
      400,
      `unknown namespace: ${namespace}`,
      {
        namespaceField: DESKTOP_WS_NAMESPACE_FIELD,
        namespaces: DESKTOP_WS_NAMESPACES
      }
    );
    return;
  }
  if (parsed.frame !== "request") {
    sendError(
      connection,
      namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "invalid_request",
      400,
      "only request frames are accepted"
    );
    return;
  }
  if (namespace === DESKTOP_WS_NAMESPACE_AGENT_PLATFORM) {
    if (!connection.agentPlatformBridge) {
      connection.agentPlatformBridge = new AgentPlatformWsBridge(options, connection, connection.server.logger);
    }
    void connection.agentPlatformBridge.forwardRequest(parsed);
    return;
  }
  void handleRequest(
    options,
    connection,
    parsed,
    namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP
  ).catch((error) => {
    sendError(
      connection,
      namespace === DESKTOP_WS_NAMESPACE_WEBAPP ? DESKTOP_WS_NAMESPACE_WEBAPP : DESKTOP_WS_NAMESPACE_DESKTOP,
      readText(parsed.id) || undefined,
      "internal_error",
      500,
      error instanceof Error ? error.message : String(error)
    );
  });
}
