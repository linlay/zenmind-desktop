import { EventEmitter, once } from "node:events";
import http from "node:http";
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
  ns?: unknown;
  kind?: unknown;
  routeId?: unknown;
  requestId?: unknown;
  nsPort?: unknown;
  nsProtocol?: unknown;
  method?: unknown;
  path?: unknown;
  host?: unknown;
  headers?: unknown;
  authToken?: unknown;
  subprotocol?: unknown;
  source?: unknown;
  clientDeviceId?: unknown;
};

type TunnelJsonResponse = {
  ok: boolean;
  statusCode: number;
  headers?: HeaderRecord;
  error?: string;
};

export type TunnelClientEndpointOptions = {
  relayUrl: string;
  relayToken: string;
  desktopWsServerOptions: DesktopWsServerOptions;
  tlsInsecureSkipVerify?: boolean;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

const MAX_JSON_FRAME_BYTES = 1 << 20;
const MAX_WS_FRAME_BYTES = 64 << 20;
const MAX_STREAM_CHUNK_BYTES = 64 << 20;
const LOOPBACK_HOST = "127.0.0.1";

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readPort(value: unknown) {
  const port = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : 0;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("nsPort must be an integer between 1 and 65535");
  }
  return port;
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

function normalizeRequestPath(value: unknown) {
  const raw = readText(value) || "/";
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) {
    throw new Error("path must be origin-form, not an absolute URL");
  }
  const parsed = new URL(raw.startsWith("/") ? raw : `/${raw}`, "http://127.0.0.1");
  return `${parsed.pathname || "/"}${parsed.search}`;
}

function methodFromEnvelope(value: unknown) {
  const method = readText(value).toUpperCase();
  return method || "GET";
}

function applyForwardHeaders(headers: HeaderRecord, envelope: TunnelStreamEnvelope, port: number) {
  const host = readText(envelope.host);
  headers.Host = host || `${LOOPBACK_HOST}:${port}`;
  if (host) {
    headers["X-Forwarded-Host"] = host;
  }
  const requestId = readText(envelope.requestId);
  if (requestId) {
    headers["X-Zenm-Request-ID"] = requestId;
  }
  const routeId = readText(envelope.routeId);
  if (routeId) {
    headers["X-Zenm-Route-ID"] = routeId;
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

async function writeTunnelJson(stream: TunnelHubYamuxStream, value: TunnelJsonResponse) {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  if (data.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new Error(`json frame too large: ${data.byteLength}`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.byteLength, 0);
  await stream.write(Buffer.concat([prefix, data]));
}

async function readTunnelChunk(stream: TunnelHubYamuxStream) {
  const prefix = await stream.readExactly(4);
  const size = prefix.readUInt32BE(0);
  if (size === 0) {
    return null;
  }
  if (size > MAX_STREAM_CHUNK_BYTES) {
    throw new Error(`stream chunk too large: ${size}`);
  }
  return stream.readExactly(size);
}

async function writeTunnelChunk(stream: TunnelHubYamuxStream, chunk: Buffer = Buffer.alloc(0)) {
  if (chunk.byteLength > MAX_STREAM_CHUNK_BYTES) {
    throw new Error(`stream chunk too large: ${chunk.byteLength}`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(chunk.byteLength, 0);
  await stream.write(Buffer.concat([prefix, chunk]));
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

function createWebappTarget(envelope: TunnelStreamEnvelope, websocket: boolean) {
  const protocol = readText(envelope.nsProtocol) || "http";
  if (protocol !== "http") {
    throw new Error("nsProtocol must be http");
  }
  const port = readPort(envelope.nsPort);
  const path = normalizeRequestPath(envelope.path);
  return {
    port,
    path,
    url: `${websocket ? "ws" : "http"}://${LOOPBACK_HOST}:${port}${path}`
  };
}

async function pumpRequestBodyToLocal(stream: TunnelHubYamuxStream, req: http.ClientRequest) {
  for (;;) {
    const chunk = await readTunnelChunk(stream);
    if (!chunk) {
      req.end();
      return;
    }
    if (!req.write(chunk)) {
      await once(req, "drain");
    }
  }
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
      headers: {
        Authorization: `Bearer ${this.options.relayToken}`
      },
      tlsInsecureSkipVerify: this.options.tlsInsecureSkipVerify,
      timeoutMs: 10_000
    });
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
      case TUNNEL_NAMESPACE_AGENT_PLATFORM:
        await this.handlePlatformStream(stream, envelope);
        return;
      case TUNNEL_NAMESPACE_WEBAPP:
        await this.handleWebAppStream(stream, envelope);
        return;
      default:
        await writeTunnelJson(stream, {
          ok: false,
          statusCode: 400,
          error: namespace ? `unknown namespace: ${namespace}` : "namespace is required"
        });
        stream.end();
    }
  }

  private async handlePlatformStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    let protocolSession: DesktopWsProtocolSession | null = null;
    try {
      protocolSession = await createDesktopWsProtocolSession(this.options.desktopWsServerOptions, {
        authToken: readText(envelope.authToken),
        subprotocol: readText(envelope.subprotocol),
        source: readText(envelope.source) || "tunnel-client",
        clientDeviceId: readText(envelope.clientDeviceId),
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
        ok: false,
        statusCode: 401,
        error: error instanceof Error ? error.message : String(error)
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
    const kind = readText(envelope.kind);
    switch (kind) {
      case "http":
        await this.handleWebAppHttpStream(stream, envelope);
        return;
      case "websocket":
        await this.handleWebAppWebSocketStream(stream, envelope);
        return;
      default:
        await writeTunnelJson(stream, {
          ok: false,
          statusCode: 400,
          error: kind ? `unknown webapp stream kind: ${kind}` : "webapp stream kind is required"
        });
        stream.end();
    }
  }

  private async handleWebAppHttpStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    let target: ReturnType<typeof createWebappTarget>;
    try {
      target = createWebappTarget(envelope, false);
    } catch (error) {
      await writeTunnelJson(stream, {
        ok: false,
        statusCode: 400,
        error: error instanceof Error ? error.message : String(error)
      });
      stream.end();
      return;
    }

    try {
      const headers = stripHopHeaders(normalizeHeader(envelope.headers));
      applyForwardHeaders(headers, envelope, target.port);
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          host: LOOPBACK_HOST,
          port: target.port,
          method: methodFromEnvelope(envelope.method),
          path: target.path,
          headers
        }, (res) => {
          void (async () => {
            await writeTunnelJson(stream, {
              ok: true,
              statusCode: res.statusCode ?? 200,
              headers: stripHopHeaders(normalizeHeader(res.headers))
            });
            for await (const chunk of res) {
              await writeTunnelChunk(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            await writeTunnelChunk(stream);
            resolve();
          })().catch(reject);
        });
        req.on("error", reject);
        void pumpRequestBodyToLocal(stream, req).catch((error) => {
          req.destroy(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        });
      });
    } catch (error) {
      await writeTunnelJson(stream, {
        ok: false,
        statusCode: 502,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      stream.end();
    }
  }

  private async handleWebAppWebSocketStream(stream: TunnelHubYamuxStream, envelope: TunnelStreamEnvelope) {
    let localWs: TunnelHubWebSocketClient | null = null;
    let target: ReturnType<typeof createWebappTarget>;
    try {
      target = createWebappTarget(envelope, true);
    } catch (error) {
      await writeTunnelJson(stream, {
        ok: false,
        statusCode: 400,
        error: error instanceof Error ? error.message : String(error)
      });
      stream.end();
      return;
    }

    try {
      const headers = stripWebSocketDialHeaders(normalizeHeader(envelope.headers));
      applyForwardHeaders(headers, envelope, target.port);
      localWs = await connectTunnelHubWebSocket(target.url, {
        headers,
        timeoutMs: 10_000
      });
      await writeTunnelJson(stream, {
        ok: true,
        statusCode: 101
      });
    } catch (error) {
      await writeTunnelJson(stream, {
        ok: false,
        statusCode: 502,
        error: error instanceof Error ? error.message : String(error)
      });
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
