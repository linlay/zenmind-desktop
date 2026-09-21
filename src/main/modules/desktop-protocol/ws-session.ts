import {
  type DesktopWsConnection,
  type DesktopWsServerOptions,
  type DesktopWsSessionGroup,
  type BindDesktopWsProtocolSessionInput,
  type DesktopWsProtocolSessionCreateInput
} from "./ws-contracts";
import { handleTextMessage } from "./ws-action-routing";
import { createSessionId, readText } from "./ws-values";
import { sendPush } from "./ws-wire";
import { AUTH_EXPIRING_WINDOW_MS, AUTH_EXPIRING_THROTTLE_MS, authenticateDesktopWsProtocolSession } from "./ws-authentication";
import { tunnelSessionGroup } from "./ws-server-state";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export function closeConnection(connection: DesktopWsConnection, code = 1000, reason = "closed") {
  if (connection.closed) {
    return;
  }
  connection.closed = true;
  connection.agentPlatformBridge?.close();
  connection.agentPlatformBridge = null;
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer);
    connection.heartbeatTimer = null;
  }
  connection.server.connections.delete(connection);
  connection.transport.close(code, reason);
}

export class DesktopWsProtocolSession {
  constructor(
    private readonly options: DesktopWsServerOptions,
    private readonly connection: DesktopWsConnection
  ) {}

  receiveTextFrame(text: string) {
    handleTextMessage(this.options, this.connection, text);
  }

  close(code = 1000, reason = "closed") {
    closeConnection(this.connection, code, reason);
  }

  get id() {
    return this.connection.id;
  }
}

export function bindProtocolSession(
  group: DesktopWsSessionGroup,
  options: DesktopWsServerOptions,
  input: BindDesktopWsProtocolSessionInput
) {
  group.logger = options.logger || console;
  const connection: DesktopWsConnection = {
    id: createSessionId(),
    server: group,
    auth: input.auth,
    source: readText(input.source),
    clientDeviceId: readText(input.clientDeviceId),
    buffer: Buffer.alloc(0),
    subscriptions: new Set(),
    closed: false,
    heartbeatTimer: null,
    authRefresh: null,
    agentPlatformBridge: null,
    transport: input.transport
  };
  group.connections.add(connection);
  sendPush(connection, "connected", { sessionId: connection.id });
  let lastAuthExpiringAt = 0;
  connection.heartbeatTimer = setInterval(() => {
    sendPush(connection, "heartbeat", { timestamp: new Date().toISOString() });
    if (connection.auth.expiresAt <= Date.now() + AUTH_EXPIRING_WINDOW_MS && Date.now() - lastAuthExpiringAt > AUTH_EXPIRING_THROTTLE_MS) {
      lastAuthExpiringAt = Date.now();
      sendPush(connection, "auth.expiring", { expiresAt: connection.auth.expiresAt });
    }
  }, HEARTBEAT_INTERVAL_MS);
  return {
    connection,
    session: new DesktopWsProtocolSession(options, connection)
  };
}

export async function createDesktopWsProtocolSession(
  options: DesktopWsServerOptions,
  input: DesktopWsProtocolSessionCreateInput
) {
  const authToken = readText(input.authToken);
  if (!authToken) {
    throw new Error("authToken is required");
  }
  const auth = await authenticateDesktopWsProtocolSession(options, authToken, input.subprotocol);
  await input.onAuthenticated?.(auth);
  return bindProtocolSession(tunnelSessionGroup, options, {
    auth,
    source: input.source,
    clientDeviceId: input.clientDeviceId,
    transport: input.transport
  }).session;
}
