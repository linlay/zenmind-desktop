export const DESKTOP_WS_LOOPBACK_HOST = "127.0.0.1";
export const DESKTOP_WS_LAN_BIND_HOST = "0.0.0.0";
export const DESKTOP_WS_HOST = DESKTOP_WS_LOOPBACK_HOST;
export const DESKTOP_WS_PORT = 7082;
export const DESKTOP_WS_PATH = "/ws";
export const DESKTOP_WS_URL = `ws://${DESKTOP_WS_HOST}:${DESKTOP_WS_PORT}${DESKTOP_WS_PATH}`;

export const DESKTOP_WS_NAMESPACE_FIELD = "ns";
export const DESKTOP_WS_NAMESPACE_DESKTOP = "d";
export const DESKTOP_WS_NAMESPACE_AGENT_PLATFORM = "ap";
export const DESKTOP_WS_NAMESPACE_WEBAPP = "wa";
export const DESKTOP_WS_NAMESPACES = {
  [DESKTOP_WS_NAMESPACE_DESKTOP]: "desktop",
  [DESKTOP_WS_NAMESPACE_AGENT_PLATFORM]: "agent-platform",
  [DESKTOP_WS_NAMESPACE_WEBAPP]: "webapp"
} as const;
export type DesktopWsNamespace = keyof typeof DESKTOP_WS_NAMESPACES;

export const DESKTOP_WS_FRAMES = ["request", "response", "push", "stream", "error"] as const;
export type DesktopWsFrame = typeof DESKTOP_WS_FRAMES[number];

export const DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES = [
  "session.hello",
  "auth.refresh",
  "capability.list",
  "event.subscribe",
  "event.unsubscribe",
  "action.list",
  "action.call",
  "snapshot.get",
  "web.webapp.list",
  "issue.create",
  "issue.update",
  "issue.delete",
  "issue.move",
  "device.status",
  "runtime.info",
  "service.list",
  "service.get",
  "service.status",
  "assistant.startRun"
] as const;

export const DESKTOP_WS_RESERVED_REQUEST_TYPES = [
  "issue.claim",
  "issue.createComment",
  "issue.updateComment",
  "issue.deleteComment",
  "issue.createReview",
  "issue.updateReview",
  "issue.deleteReview",
  "issue.createLabel",
  "issue.updateLabel",
  "issue.deleteLabel",
  "service.logs.meta",
  "service.logs.read",
  "service.start",
  "service.stop",
  "service.restart",
  "assistant.agents",
  "assistant.chats",
  "assistant.chat",
  "assistant.stopRun",
  "assistant.submitAwaiting",
  "page.context",
  "page.read",
  "page.interact",
  "page.fillForm",
  "page.submitForm",
  "kanban.issue.list",
  "kanban.issue.get",
  "kanban.issue.create",
  "kanban.issue.update",
  "kanban.issue.delete",
  "kanban.issue.move",
  "web.entries.list",
  "web.listSurfaces",
  "web.getActiveSurface",
  "web.activateSurface",
  "web.navigate",
  "web.reload",
  "web.goBack",
  "web.openTab",
  "web.closeTab",
  "web.switchTab",
  "web.website.list",
  "web.website.add",
  "web.website.update",
  "web.website.remove",
  "web.webapp.getStatus",
  "web.webapp.checkPrerequisites",
  "web.webapp.start",
  "web.webapp.stop",
  "web.webapp.restart",
  "web.webapp.open",
  "web.webapp.installAndOpen",
  "web.webapp.getPublishInfo",
  "web.webapp.publish",
  "web.webapp.unpublish",
  "pet.state",
  "pet.show",
  "pet.hide",
  "pet.list",
  "pet.set",
  "general.deviceName",
  "theme.get",
  "theme.set",
  "locale.get",
  "locale.set",
  "copilot.getPagePreferences",
  "copilot.setPagePreference",
  "market.settings",
  "market.list",
  "market.refresh",
  "market.get",
  "market.install",
  "market.update",
  "market.uninstall",
  "help.open",
  "diagnostic.report",
  "diagnostic.status"
] as const;

export const DESKTOP_WS_REQUEST_TYPES = [
  ...DESKTOP_WS_IMPLEMENTED_REQUEST_TYPES,
  ...DESKTOP_WS_RESERVED_REQUEST_TYPES
] as const;

export const DESKTOP_WS_PUSH_TYPES = [
  "connected",
  "heartbeat",
  "auth.expiring",
  "snapshot.updated",
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.moved",
  "device.status",
  "service.changed",
  "service.log.appended",
  "assistant.event",
  "assistant.run.started",
  "assistant.run.finished",
  "agent.catalog.updated",
  "automation.changed",
  "page.changed",
  "web.changed",
  "webapp.changed",
  "staticServer.changed",
  "setting.changed",
  "market.changed",
  "diagnostic.reported"
] as const;

export type DesktopWsRequestType = typeof DESKTOP_WS_REQUEST_TYPES[number];
export type DesktopWsPushType = typeof DESKTOP_WS_PUSH_TYPES[number];
