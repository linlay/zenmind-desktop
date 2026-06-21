import { EventEmitter, once } from "node:events";
import http from "node:http";
import https from "node:https";
import { connectTunnelHubWebSocket, type TunnelHubWebSocketClient, type TunnelHubWebSocketMessage } from "./tunnel-hub-websocket-client";
import { TunnelHubYamuxSession, type TunnelHubYamuxStream } from "./tunnel-hub-yamux";
import {
  createDesktopWsProtocolSession,
  type DesktopWsProtocolSession,
  type DesktopWsServerOptions
} from "./desktop-ws-server";

export const TUNNEL_NAMESPACE_DESKTOP = "d";
export const TUNNEL_NAMESPACE_AGENT_PLATFORM = "ap";
export const TUNNEL_NAMESPACE_WEBAPP = "wa";

type HeaderRecord = Record<string, string[] | string>;

type TunnelStreamEnvelope = {
  v?: unknown;
  ns?: unknown;
  frame?: unknown;
  type?: unknown;
  id?: unknown;
  payload?: unknown;
  code?: unknown;
  msg?: unknown;
  data?: unknown;
  public?: unknown;
  upstream?: unknown;
  bodyLength?: unknown;
  route?: unknown;
  authToken?: unknown;
  subprotocol?: unknown;
  source?: unknown;
  clientDeviceId?: unknown;
};

export type TunnelClientEndpointOptions = {
  relayUrl: string;
  relayToken: string;
  deviceId: string;
  desktopWsServerOptions: DesktopWsServerOptions;
  tlsInsecureSkipVerify?: boolean;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

const MAX_JSON_FRAME_BYTES = 1 << 20;
const MAX_WS_FRAME_BYTES = 64 << 20;
const STREAM_IO_CHUNK_BYTES = 64 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const TUNNEL_OPEN_TIMEOUT_MS = 10_000;
const TUNNEL_OPEN_ID_PREFIX = "tun";
const TUNNEL_CLIENT_NAME = ["zen", "mind-desktop"].join("");
const TUNNEL_CLIENT_CAPABILITIES = [
  "desktop.websocket",
  "webapp.http",
  "webapp.websocket"
];
const HTTP_UPSTREAM_SCHEMES = new Set(["http", "https"]);
const WS_UPSTREAM_SCHEMES = new Set(["ws", "wss"]);

type WebAppPublicRequest = {
  method: string;
  host: string;
  path: string;
  headers: HeaderRecord;
};

type WebAppUpstreamTarget = {
  scheme: "http" | "https" | "ws" | "wss";
  host: string;
  port: number;
  path: string;
  url: string;
};

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadRecord(envelope: TunnelStreamEnvelope) {
  return isRecord(envelope.payload) ? envelope.payload : {};
}

function readPort(value: unknown, fieldName = "upstream.port") {
  const port = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : 0;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return port;
}

function readBodyLength(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("bodyLength must be a non-negative safe integer");
  }
  return value;
}

function normalizeHeader(value: unknown): HeaderRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: HeaderRecord = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) {
      continue;
    }
    if (Array.isArray(raw)) {
      const values = raw.map((item) => typeof item === "string" ? item : String(item)).filter(Boolean);
      if (values.length > 0) {
        out[key] = values;
      }
    } else if (typeof raw === "string" && raw) {
      out[key] = raw;
    }
  }
  return out;
}

function isHopHeader(key: string) {
  switch (key.toLowerCase()) {
    case "connection":
    case "keep-alive":
    case "proxy-authenticate":
    case "proxy-authorization":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
      return true;
    default:
      return false;
  }
}

function stripHopHeaders(headers: HeaderRecord): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isHopHeader(key)) {
      out[key] = value;
    }
  }
  return out;
}

function stripWebSocketDialHeaders(headers: HeaderRecord): HeaderRecord {
  const out = stripHopHeaders(headers);
  for (const key of Object.keys(out)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "sec-websocket-accept" ||
      normalized === "sec-websocket-extensions" ||
      normalized === "sec-websocket-key" ||
      normalized === "sec-websocket-protocol" ||
      normalized === "sec-websocket-version"
    ) {
      delete out[key];
    }
  }
  return out;
}

function deleteHeaders(headers: HeaderRecord, names: string[]) {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  for (const key of Object.keys(headers)) {
    if (normalizedNames.has(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

function normalizeRequestPath(value: unknown) {
  const raw = readText(value) || "/";
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) {
    throw new Error("path must be origin-form, not an absolute URL");
  }
  const parsed = new URL(raw.startsWith("/") ? raw : `/${raw}`, "http://127.0.0.1");
  return `${parsed.pathname || "/"}${parsed.search}`;
}

function normalizeBasePath(value: unknown) {
  const raw = readText(value);
  if (!raw || raw === "/") {
    return "";
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) {
    throw new Error("upstream.basePath must be an origin-form path, not an absolute URL");
  }
  const parsed = new URL(raw.startsWith("/") ? raw : `/${raw}`, "http://127.0.0.1");
  if (parsed.search) {
    throw new Error("upstream.basePath must not include a query string");
  }
  return parsed.pathname === "/" ? "" : parsed.pathname;
}

function joinUpstreamPath(basePath: string, publicPath: string) {
  const parsed = new URL(publicPath, "http://127.0.0.1");
  if (!basePath) {
    return `${parsed.pathname || "/"}${parsed.search}`;
  }
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const suffix = parsed.pathname === "/" ? "/" : parsed.pathname;
  return `${prefix}${suffix}${parsed.search}`;
}

function methodFromValue(value: unknown) {
  const method = readText(value).toUpperCase();
  return method || "GET";
}

function normalizeUpstreamHost(value: unknown) {
  const host = readText(value);
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const normalized = unbracketed.toLowerCase();
  if (normalized === "localhost" || normalized === LOOPBACK_HOST || normalized === "::1") {
    return normalized;
  }
  throw new Error("upstream.host must be a loopback host");
}

function hostForUrl(host: string) {
  return host.includes(":") ? `[${host}]` : host;
}

function hostForHeader(host: string, port: number) {
  return `${hostForUrl(host)}:${port}`;
}

function parseWebAppPublicRequest(payload: Record<string, unknown>): WebAppPublicRequest {
  if (!isRecord(payload.public)) {
    throw new Error("public must be an object");
  }
  const host = readText(payload.public.host);
  if (!host) {
    throw new Error("public.host is required");
  }
  return {
    method: methodFromValue(payload.public.method),
    host,
    path: normalizeRequestPath(payload.public.path),
    headers: normalizeHeader(payload.public.headers)
  };
}

function parseWebAppUpstreamTarget(
  payload: Record<string, unknown>,
  publicRequest: WebAppPublicRequest,
  websocket: boolean
): WebAppUpstreamTarget {
  if (!isRecord(payload.upstream)) {
    throw new Error("upstream must be an object");
  }
  const scheme = readText(payload.upstream.scheme).toLowerCase();
  const allowedSchemes = websocket ? WS_UPSTREAM_SCHEMES : HTTP_UPSTREAM_SCHEMES;
  if (!allowedSchemes.has(scheme)) {
    throw new Error(websocket ? "upstream.scheme must be ws or wss" : "upstream.scheme must be http or https");
  }
  const host = normalizeUpstreamHost(payload.upstream.host);
  const port = readPort(payload.upstream.port);
  const basePath = normalizeBasePath(payload.upstream.basePath);
  const path = joinUpstreamPath(basePath, publicRequest.path);
  return {
    scheme: scheme as WebAppUpstreamTarget["scheme"],
    host,
    port,
    path,
    url: `${scheme}://${hostForUrl(host)}:${port}${path}`
  };
}

function applyForwardHeaders(headers: HeaderRecord, publicRequest: WebAppPublicRequest, target: WebAppUpstreamTarget) {
  const host = publicRequest.host;
  deleteHeaders(headers, ["host", "x-forwarded-host"]);
  headers.Host = host || hostForHeader(target.host, target.port);
  if (host) {
    headers["X-Forwarded-Host"] = host;
  }
}

async function readTunnelJson(stream: TunnelHubYamuxStream) {
  const prefix = await stream.readExactly(4);
  const size = prefix.readUInt32BE(0);
  if (size > MAX_JSON_FRAME_BYTES) {
    throw new Error(`json frame too large: ${size}`);
  }
  const data = await stream.readExactly(size);
  return JSON.parse(data.toString("utf8")) as TunnelStreamEnvelope;
}

async function writeTunnelJson(stream: TunnelHubYamuxStream, value: Record<string, unknown>) {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  if (data.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new Error(`json frame too large: ${data.byteLength}`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.byteLength, 0);
  await stream.write(Buffer.concat([prefix, data]));
}

function createControlId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readTextJsonPayload(message: TunnelHubWebSocketMessage) {
  return message.type === 0x1 ? JSON.parse(message.payload.toString("utf8")) as TunnelStreamEnvelope : null;
}

async function writeTunnelOpen(ws: TunnelHubWebSocketClient, options: TunnelClientEndpointOptions) {
  const id = createControlId(TUNNEL_OPEN_ID_PREFIX);
  ws.sendMessage(0x1, Buffer.from(JSON.stringify({
    v: 1,
    ns: TUNNEL_NAMESPACE_DESKTOP,
    frame: "request",
    type: "tunnel.open",
    id,
    payload: {
      agentToken: options.relayToken,
      deviceId: options.deviceId,
      client: TUNNEL_CLIENT_NAME,
      capabilities: TUNNEL_CLIENT_CAPABILITIES
    }
  }), "utf8"));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleError = (error: Error) => fail(error);
    const handleClose = () => fail(new Error("tunnel websocket closed before tunnel.open completed"));
    const handleMessage = (message: TunnelHubWebSocketMessage) => {
      if (message.type !== 0x1) {
        return;
      }
      let response: TunnelStreamEnvelope | null = null;
      try {
        response = readTextJsonPayload(message);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!response || readText(response.id) !== id) {
        return;
      }
      const code = typeof response.code === "number" ? response.code : Number(response.code);
      if (
        response.v === 1 &&
        readText(response.ns) === TUNNEL_NAMESPACE_DESKTOP &&
        readText(response.frame) === "response" &&
        readText(response.type) === "tunnel.open" &&
        code === 0
      ) {
        settled = true;
        cleanup();
        resolve();
        return;
      }
      fail(new Error(readText(response.msg) || `tunnel.open failed with code ${Number.isFinite(code) ? code : "unknown"}`));
    };
    const timer = setTimeout(() => fail(new Error("tunnel.open timed out")), TUNNEL_OPEN_TIMEOUT_MS);
    ws.on("message", handleMessage);
    ws.on("error", handleError);
    ws.on("close", handleClose);
  });
}

async function readWsFrame(stream: TunnelHubYamuxStream) {
  const header = await stream.readExactly(9);
  const type = header[0];
  const length = Number(header.readBigUInt64BE(1));
  if (length > MAX_WS_FRAME_BYTES) {
    throw new Error(`websocket frame too large: ${length}`);
  }
  return {
    type,
    payload: await stream.readExactly(length)
  };
}

function encodeWsFrame(type: number, payload: Buffer) {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 1);
  return Buffer.concat([header, payload]);
}

async function pumpRequestBodyToLocal(stream: TunnelHubYamuxStream, req: http.ClientRequest, bodyLength: number) {
  let remaining = bodyLength;
  while (remaining > 0) {
    const readSize = Math.min(remaining, STREAM_IO_CHUNK_BYTES);
    const chunk = await stream.readExactly(readSize);
    remaining -= chunk.byteLength;
    if (!req.write(chunk)) {
      await once(req, "drain");
    }
  }
  req.end();
}

function readContentLength(headers: HeaderRecord) {
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-length") {
      continue;
    }
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (/^\d+$/u.test(value)) {
      const length = Number.parseInt(value, 10);
      if (Number.isSafeInteger(length)) {
        return length;
      }
    }
  }
  return -1;
}

function writeWebAppError(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope, statusCode: number, error: unknown) {
  return writeTunnelJson(stream, {
    v: 1,
    ns: TUNNEL_NAMESPACE_WEBAPP,
    frame: "error",
    type: readText(envelope.type) || "error",
    id: readText(envelope.id) || undefined,
    code: statusCode,
    msg: error instanceof Error ? error.message : String(error)
  });
}

export class TunnelClientEndpoint extends EventEmitter {
  private ws: TunnelHubWebSocketClient | null = null;
  private session: TunnelHubYamuxSession | null = null;
  private closed = false;

  constructor(private readonly options: TunnelClientEndpointOptions) {
    super();
  }

  async connect() {
    if (this.closed) {
      throw new Error("tunnel client endpoint is closed");
    }
    const ws = await connectTunnelHubWebSocket(this.options.relayUrl, {
      tlsInsecureSkipVerify: this.options.tlsInsecureSkipVerify,
      timeoutMs: 10_000
    });
    await writeTunnelOpen(ws, this.options);
    const session = new TunnelHubYamuxSession(ws);
    this.ws = ws;
    this.session = session;
    session.on("stream", (stream: TunnelHubYamuxStream) => {
      void this.handleStream(stream).catch((error) => {
        this.options.logger?.warn?.(`[tunnel-endpoint] stream failed: ${error instanceof Error ? error.message : String(error)}`);
        stream.reset();
      });
    });
    session.on("error", (error) => this.emit("error", error));
    session.on("close", () => this.emit("close"));
  }

  close() {
    this.closed = true;
    this.session?.close();
    this.ws?.close(1000, "tunnel client endpoint stopping");
    this.session = null;
    this.ws = null;
  }

  private async handleStream(stream: TunnelHubYamuxStream) {
    const envelope = await readTunnelJson(stream);
    const namespace = readText(envelope.ns);
    switch (namespace) {
      case TUNNEL_NAMESPACE_DESKTOP:
        await this.handlePlatformStream(stream, envelope);
        return;
      case TUNNEL_NAMESPACE_WEBAPP:
        await this.handleWebAppStream(stream, envelope);
        return;
      default:
        await writeTunnelJson(stream, {
          v: 1,
          ns: namespace || undefined,
          frame: "error",
          type: readText(envelope.type) || "error",
          id: readText(envelope.id) || undefined,
          code: 400,
          msg: namespace ? `unknown namespace: ${namespace}` : "namespace is required"
        });
        stream.end();
    }
  }

  private async handlePlatformStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    const payload = payloadRecord(envelope);
    const id = readText(envelope.id) || undefined;
    if (
      envelope.v !== 1 ||
      readText(envelope.frame) !== "request" ||
      readText(envelope.type) !== "desktop.websocket.open"
    ) {
      await writeTunnelJson(stream, {
        v: 1,
        ns: TUNNEL_NAMESPACE_DESKTOP,
        frame: "error",
        type: readText(envelope.type) || "desktop.websocket.open",
        id,
        code: 400,
        msg: "desktop.websocket.open request is required"
      });
      stream.end();
      return;
    }
    let protocolSession: DesktopWsProtocolSession | null = null;
    try {
      protocolSession = await createDesktopWsProtocolSession(this.options.desktopWsServerOptions, {
        authToken: readText(payload.authToken),
        subprotocol: readText(payload.subprotocol),
        source: readText(payload.source) || "tunnel-client",
        clientDeviceId: readText(payload.clientDeviceId),
        onAuthenticated: async () => {
          await writeTunnelJson(stream, {
            v: 1,
            ns: TUNNEL_NAMESPACE_DESKTOP,
            frame: "response",
            type: "desktop.websocket.open",
            id,
            code: 0,
            msg: "success",
            data: {
              statusCode: 101,
              headers: {}
            }
          });
        },
        transport: {
          sendText: (text) => {
            void stream.write(encodeWsFrame(0x1, Buffer.from(text, "utf8"))).catch(() => {
              protocolSession?.close(1011, "tunnel stream write failed");
            });
          },
          close: () => {
            stream.end();
          }
        }
      });
    } catch (error) {
      await writeTunnelJson(stream, {
        v: 1,
        ns: TUNNEL_NAMESPACE_DESKTOP,
        frame: "error",
        type: "desktop.websocket.open",
        id,
        code: 401,
        msg: error instanceof Error ? error.message : String(error)
      });
      stream.end();
      return;
    }

    try {
      for (;;) {
        const frame = await readWsFrame(stream);
        if (frame.type === 0x1) {
          protocolSession.receiveTextFrame(frame.payload.toString("utf8"));
        } else if (frame.type === 0x8) {
          break;
        } else if (frame.type === 0x9) {
          await stream.write(encodeWsFrame(0xA, frame.payload));
        } else {
          throw new Error(`unsupported platform websocket opcode: ${frame.type}`);
        }
      }
    } finally {
      protocolSession.close(1000, "tunnel platform stream closed");
    }
  }

  private async handleWebAppStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    if (envelope.v !== 1 || readText(envelope.frame) !== "request") {
      await writeWebAppError(stream, envelope, 400, "webapp request frame with v=1 is required");
      stream.end();
      return;
    }
    const type = readText(envelope.type);
    switch (type) {
      case "http.request":
        await this.handleWebAppHttpStream(stream, envelope);
        return;
      case "websocket.connect":
        await this.handleWebAppWebSocketStream(stream, envelope);
        return;
      default:
        await writeWebAppError(stream, envelope, 400, type ? `unknown webapp stream type: ${type}` : "webapp stream type is required");
        stream.end();
    }
  }

  private async handleWebAppHttpStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    let publicRequest: WebAppPublicRequest;
    let target: WebAppUpstreamTarget;
    let bodyLength = 0;
    const payload = payloadRecord(envelope);
    try {
      publicRequest = parseWebAppPublicRequest(payload);
      target = parseWebAppUpstreamTarget(payload, publicRequest, false);
      bodyLength = readBodyLength(payload.bodyLength);
    } catch (error) {
      await writeWebAppError(stream, envelope, 400, error);
      stream.end();
      return;
    }

    try {
      const headers = stripHopHeaders(publicRequest.headers);
      applyForwardHeaders(headers, publicRequest, target);
      await new Promise<void>((resolve, reject) => {
        const requestModule = target.scheme === "https" ? https : http;
        const req = requestModule.request({
          host: target.host,
          port: target.port,
          method: publicRequest.method,
          path: target.path,
          headers
        }, (res) => {
          void (async () => {
            const responseHeaders = stripHopHeaders(normalizeHeader(res.headers));
            await writeTunnelJson(stream, {
              v: 1,
              ns: TUNNEL_NAMESPACE_WEBAPP,
              frame: "response",
              type: "http.request",
              id: readText(envelope.id) || undefined,
              code: 0,
              msg: "success",
              data: {
                statusCode: res.statusCode ?? 200,
                headers: responseHeaders,
                bodyLength: readContentLength(responseHeaders)
              }
            });
            for await (const chunk of res) {
              await stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            resolve();
          })().catch(reject);
        });
        req.on("error", reject);
        void pumpRequestBodyToLocal(stream, req, bodyLength).catch((error) => {
          req.destroy(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        });
      });
    } catch (error) {
      await writeWebAppError(stream, envelope, 502, error);
    } finally {
      stream.end();
    }
  }

  private async handleWebAppWebSocketStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    let localWs: TunnelHubWebSocketClient | null = null;
    let publicRequest: WebAppPublicRequest;
    let target: WebAppUpstreamTarget;
    const payload = payloadRecord(envelope);
    try {
      publicRequest = parseWebAppPublicRequest(payload);
      target = parseWebAppUpstreamTarget(payload, publicRequest, true);
    } catch (error) {
      await writeWebAppError(stream, envelope, 400, error);
      stream.end();
      return;
    }

    try {
      const headers = stripWebSocketDialHeaders(publicRequest.headers);
      applyForwardHeaders(headers, publicRequest, target);
      localWs = await connectTunnelHubWebSocket(target.url, {
        headers,
        timeoutMs: 10_000
      });
      await writeTunnelJson(stream, {
        v: 1,
        ns: TUNNEL_NAMESPACE_WEBAPP,
        frame: "response",
        type: "websocket.connect",
        id: readText(envelope.id) || undefined,
        code: 0,
        msg: "success",
        data: {
          statusCode: 101,
          headers: {}
        }
      });
    } catch (error) {
      await writeWebAppError(stream, envelope, 502, error);
      stream.end();
      return;
    }

    const closeBoth = () => {
      localWs?.close(1000, "tunnel websocket closing");
      stream.end();
    };
    localWs.on("message", (message: TunnelHubWebSocketMessage) => {
      if (message.type === 0x1 || message.type === 0x2) {
        void stream.write(encodeWsFrame(message.type, message.payload)).catch(() => closeBoth());
      }
    });
    localWs.on("close", closeBoth);
    localWs.on("error", closeBoth);

    try {
      for (;;) {
        const frame = await readWsFrame(stream);
        if (frame.type === 0x8) {
          closeBoth();
          return;
        }
        if (frame.type !== 0x1 && frame.type !== 0x2) {
          throw new Error(`unsupported webapp websocket opcode: ${frame.type}`);
        }
        localWs.sendMessage(frame.type, frame.payload);
      }
    } catch {
      closeBoth();
    }
  }
}
