import { type DesktopWsServerKind, type DesktopWsServerRecord, type DesktopWsSessionGroup, type DesktopWsServerRuntimeState } from "./ws-contracts";
import { nowIso } from "./ws-values";
import { DESKTOP_WS_HOST, DESKTOP_WS_LAN_BIND_HOST, DESKTOP_WS_PATH } from "../../../shared/desktop-ws";

export const activeServers = new Map<DesktopWsServerKind, DesktopWsServerRecord>();

export const tunnelSessionGroup: DesktopWsSessionGroup = {
  kind: "tunnel",
  connections: new Set(),
  logger: console,
  startedAt: nowIso()
};

export function normalizeDesktopWsBindHost(value: unknown) {
  const host = typeof value === "string" ? value.trim() : "";
  return host || DESKTOP_WS_HOST;
}

export function isDesktopWsBindHostSatisfied(activeHost: string, requestedHost: string) {
  return activeHost === requestedHost || activeHost === DESKTOP_WS_LAN_BIND_HOST;
}

export function getDesktopWsLocalUrlHost(host: string) {
  return host === DESKTOP_WS_LAN_BIND_HOST ? DESKTOP_WS_HOST : host;
}

export function createDesktopWsServerRuntimeState(
  record: DesktopWsServerRecord | null,
  defaultPort: number
): DesktopWsServerRuntimeState {
  const host = record?.host ?? DESKTOP_WS_HOST;
  const urlHost = getDesktopWsLocalUrlHost(host);
  const port = record?.port ?? defaultPort;
  return {
    running: Boolean(record),
    host,
    port,
    path: DESKTOP_WS_PATH,
    url: `ws://${urlHost}:${port}${DESKTOP_WS_PATH}`
  };
}
