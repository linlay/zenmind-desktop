import { type DesktopWsServerRecord, type DesktopWsServerOptions, type DesktopWsAuthSession, type DesktopWsServerKind } from "./ws-contracts";
import http from "node:http";
import { type Socket, type AddressInfo } from "node:net";
import { bindProtocolSession, closeConnection } from "./ws-session";
import { readText, nowIso } from "./ws-values";
import { encodeWebSocketFrame, closeSocketWithFrame, parseFrames, writeUpgradeFailure, writeUpgradeSuccess, sendPush } from "./ws-wire";
import { DESKTOP_WS_PATH, DESKTOP_WS_PORT, type DesktopWsPushType } from "../../../shared/desktop-ws";
import { readTokenFromRequest, authenticateDesktopWsProtocolSession, verifyRs256Jwt } from "./ws-authentication";
import {
  normalizeDesktopWsBindHost,
  activeServers,
  isDesktopWsBindHostSatisfied,
  createDesktopWsServerRuntimeState,
  tunnelSessionGroup
} from "./ws-server-state";
import { normalizePublicActionName, listPublicActions } from "./ws-action-routing";

export function bindSocketConnection(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket, auth: DesktopWsAuthSession) {
  const parsed = new URL(req.url || "/", `http://${record.host}:${record.port}`);
  const { connection, session } = bindProtocolSession(record, options, {
    auth,
    source: readText(parsed.searchParams.get("source")),
    clientDeviceId: readText(parsed.searchParams.get("deviceId")) || readText(parsed.searchParams.get("device_id")),
    transport: {
      sendText(text) {
        if (!socket.destroyed) {
          socket.write(encodeWebSocketFrame(0x1, Buffer.from(text, "utf8")));
        }
      },
      close(code, reason) {
        closeSocketWithFrame(socket, code, reason);
      }
    }
  });
  socket.on("data", (chunk) => {
    try {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      const frames = parseFrames(connection);
      for (const frame of frames) {
        if (frame.opcode === 0x1) {
          session.receiveTextFrame(frame.payload.toString("utf8"));
        } else if (frame.opcode === 0x8) {
          session.close();
        } else if (frame.opcode === 0x9) {
          socket.write(encodeWebSocketFrame(0xA, frame.payload));
        }
      }
    } catch (error) {
      record.logger.warn?.(`[desktop-ws] closing invalid websocket frame: ${error instanceof Error ? error.message : String(error)}`);
      session.close(1002, "protocol error");
    }
  });
  socket.on("close", () => session.close());
  socket.on("error", () => session.close());
}

export async function handleUpgrade(record: DesktopWsServerRecord, options: DesktopWsServerOptions, req: http.IncomingMessage, socket: Socket) {
  const parsed = new URL(req.url || "/", `http://${record.host}:${record.port}`);
  if (parsed.pathname !== DESKTOP_WS_PATH) {
    writeUpgradeFailure(socket, 404, "Not Found");
    return;
  }
  const tokenInfo = readTokenFromRequest(req);
  if (!tokenInfo) {
    writeUpgradeFailure(socket, 401, "Unauthorized");
    return;
  }
  try {
    const auth = await authenticateDesktopWsProtocolSession(options, tokenInfo.token, tokenInfo.subprotocol);
    writeUpgradeSuccess(socket, req, tokenInfo.subprotocol);
    bindSocketConnection(record, options, req, socket, auth);
  } catch (error) {
    record.logger.warn?.(`[desktop-ws] unauthorized websocket upgrade: ${error instanceof Error ? error.message : String(error)}`);
    writeUpgradeFailure(socket, 401, "Unauthorized");
  }
}

export async function startDesktopWsServerInstance(
  kind: DesktopWsServerKind,
  options: DesktopWsServerOptions,
  defaultPort: number
) {
  const host = normalizeDesktopWsBindHost(options.host);
  const logger = options.logger || console;
  const activeServer = activeServers.get(kind) ?? null;
  if (activeServer) {
    if (isDesktopWsBindHostSatisfied(activeServer.host, host)) {
      const runtimeState = createDesktopWsServerRuntimeState(activeServer, defaultPort);
      return {
        ...runtimeState,
        webSocketUrl: runtimeState.url
      };
    }
    await stopDesktopWsServerInstance(kind);
  }
  const port = options.port ?? defaultPort;
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Desktop WS Server only accepts WebSocket upgrades on /ws.");
  });
  const record: DesktopWsServerRecord = {
    kind,
    server,
    host,
    port,
    connections: new Set(),
    logger,
    startedAt: nowIso()
  };
  server.on("upgrade", (req, socket) => {
    const wsSocket = socket as Socket;
    void handleUpgrade(record, options, req, wsSocket).catch((error) => {
      logger.warn?.(`[desktop-ws] upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
      writeUpgradeFailure(wsSocket, 500, "Internal Server Error");
    });
  });
  server.on("error", (error) => {
    logger.warn?.(`[desktop-ws] failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
  const address = server.address() as AddressInfo | null;
  record.port = address?.port ?? port;
  activeServers.set(kind, record);
  logger.log?.(`[desktop-ws:${kind}] listening on ${host}:${record.port}`);
  const runtimeState = createDesktopWsServerRuntimeState(record, defaultPort);
  return {
    ...runtimeState,
    webSocketUrl: runtimeState.url
  };
}

export function startDesktopWsServer(options: DesktopWsServerOptions) {
  return startDesktopWsServerInstance("debug", options, DESKTOP_WS_PORT);
}

export function getDesktopWsServerRuntimeState() {
  return createDesktopWsServerRuntimeState(activeServers.get("debug") ?? null, DESKTOP_WS_PORT);
}

export function emitDesktopWsPush(type: DesktopWsPushType | string, data?: unknown) {
  for (const record of [...activeServers.values(), tunnelSessionGroup]) {
    for (const connection of record.connections) {
      if (connection.subscriptions.has(type)) {
        sendPush(connection, type, data);
      }
    }
  }
}

export function hasTunnelDesktopWsSubscriber(type: DesktopWsPushType | string) {
  const now = Date.now();
  return [...tunnelSessionGroup.connections].some((connection) =>
    !connection.closed &&
    connection.auth.scope === "app" &&
    connection.auth.expiresAt > now &&
    Boolean(connection.auth.deviceId) &&
    connection.subscriptions.has(type)
  );
}

export function stopDesktopWsServerInstance(kind: DesktopWsServerKind) {
  const record = activeServers.get(kind) ?? null;
  activeServers.delete(kind);
  if (!record) {
    return Promise.resolve();
  }
  for (const connection of [...record.connections]) {
    closeConnection(connection, 1001, "server stopping");
  }
  return new Promise<void>((resolve) => {
    record.server.close(() => resolve());
  });
}

export function stopDesktopWsServer() {
  return stopDesktopWsServerInstance("debug");
}

export const __testInternals = {
  encodeWebSocketFrame,
  parseFrames,
  normalizePublicActionName,
  verifyRs256Jwt,
  listPublicActions,
  startDesktopWsServerInstance,
  stopDesktopWsServerInstance
};
export * from "./ws-contracts";
export * from "./ws-wire";
export * from "./ws-session";
export * from "./ws-authentication";
export * from "./ws-platform-adapter";
export * from "./ws-server-state";
export * from "./ws-action-routing";
export * from "./ws-values";
