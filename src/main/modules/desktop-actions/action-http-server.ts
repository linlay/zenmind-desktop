import http from "node:http";
import { DESKTOP_ACTION_BRIDGE_HOST, DESKTOP_ACTION_DEFINITIONS, type DesktopActionCallRequest } from "../../../shared/desktop-actions";
import { type DesktopActionBridgeOptions, type DesktopCdpCallRequest } from "./action-contracts";
import { getConfiguredDesktopActionBridgePort } from "./settings";
import { fail, cdpFail } from "./action-values";
import { type AddressInfo } from "node:net";
import { handleActionCall } from "./action-handlers";
import { authorizeWebappActionToken } from "../webs";
import { handleDesktopCdpRequest } from "./cdp-handler";

export const desktopActionServerState = {
  activeServer: null as http.Server | null,
  activeServerPort: 0
};

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export const MAX_BODY_BYTES = 256 * 1024;

export async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writeJSON(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

export function isLocalhostRequest(req: http.IncomingMessage) {
  return req.socket.remoteAddress === DESKTOP_ACTION_BRIDGE_HOST ||
    req.socket.remoteAddress === "::ffff:127.0.0.1";
}

export function hasJsonContentType(req: http.IncomingMessage) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.split(";")[0].trim() === "application/json";
}

export function readBearerToken(req: http.IncomingMessage) {
  const authorization = String(req.headers.authorization || "").trim();
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
}

export function startDesktopActionBridge(options: DesktopActionBridgeOptions) {
  const bridgePort = getConfiguredDesktopActionBridgePort(options.app);
  if (desktopActionServerState.activeServer) {
    if (desktopActionServerState.activeServerPort === bridgePort) {
      return desktopActionServerState.activeServer;
    }
    const previousServer = desktopActionServerState.activeServer;
    desktopActionServerState.activeServer = null;
    desktopActionServerState.activeServerPort = 0;
    previousServer.close();
  }

  const server = http.createServer(async (req, res) => {
    if (!isLocalhostRequest(req)) {
      writeJSON(res, 403, fail("unknown", "forbidden", "Desktop Action Bridge only accepts localhost requests."));
      return;
    }

    const url = new URL(req.url || "/", `http://${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJSON(res, 200, {
        ok: true,
        host: DESKTOP_ACTION_BRIDGE_HOST,
        port: (server.address() as AddressInfo | null)?.port ?? bridgePort
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/actions") {
      writeJSON(res, 200, { ok: true, actions: DESKTOP_ACTION_DEFINITIONS });
      return;
    }
    if (req.method === "POST" && url.pathname === "/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const response = await handleActionCall(options, parsed);
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "backendActionToken"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp action token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappBackend", webappId: authorization.webappId, signal: authorization.signal }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/pages/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "localPageGateway"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp page token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappPage", webappId: authorization.webappId, signal: authorization.signal }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/cdp/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, cdpFail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopCdpCallRequest;
        const response = await handleDesktopCdpRequest(options, { ...parsed, source: undefined });
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, cdpFail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    writeJSON(res, 404, fail("unknown", "not_found", "Desktop Action Bridge route not found."));
  });

  server.listen(bridgePort, DESKTOP_ACTION_BRIDGE_HOST, () => {
    console.log(`[desktop-action-bridge] listening on ${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
  });
  server.on("error", (error) => {
    console.warn(`[desktop-action-bridge] failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  desktopActionServerState.activeServer = server;
  desktopActionServerState.activeServerPort = bridgePort;
  return server;
}

export function stopDesktopActionBridge() {
  const server = desktopActionServerState.activeServer;
  desktopActionServerState.activeServer = null;
  desktopActionServerState.activeServerPort = 0;
  server?.close();
}
