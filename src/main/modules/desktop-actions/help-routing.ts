import { AGENT_WEBCLIENT_ROUTE_DEFINITIONS } from "../../../shared/agent-webclient-routes";
import { readString } from "./action-values";

export function resolveAgentWebclientHelpRoute(topic: string) {
  return AGENT_WEBCLIENT_ROUTE_DEFINITIONS.find((route) =>
    route.key === topic ||
    route.routePath === topic ||
    route.routePath.slice(1) === topic
  )?.routePath ?? null;
}

export const HELP_TOPIC_ROUTES = new Map([
  ["help", "/help"],
  ["settings", "/settings"],
  ["market", "/market"],
  ["control-center", "/control-center"],
  ["controlCenter", "/control-center"]
]);

export function isAllowedHelpRoute(route: string) {
  return [...HELP_TOPIC_ROUTES.values()].includes(route) ||
    AGENT_WEBCLIENT_ROUTE_DEFINITIONS.some((definition) => definition.routePath === route);
}

export function resolveHelpOpenRoute(args: Record<string, unknown>) {
  const route = readString(args, "route");
  if (route) {
    return isAllowedHelpRoute(route) ? route : "";
  }
  const topic = readString(args, "topic") || readString(args, "id");
  if (!topic) {
    return "/help";
  }
  return HELP_TOPIC_ROUTES.get(topic) ?? resolveAgentWebclientHelpRoute(topic) ?? "";
}
