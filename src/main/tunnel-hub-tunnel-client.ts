import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { connectTunnelHubWebSocket, type TunnelHubWebSocketClient, type TunnelHubWebSocketMessage } from "./tunnel-hub-websocket-client";
import { TunnelHubYamuxSession, type TunnelHubYamuxStream } from "./tunnel-hub-yamux";

type HeaderRecord = Record<string, string[] | string>;

type StreamRequest = {
  kind?: unknown;
  requestId?: unknown;
  method?: unknown;
  path?: unknown;
  host?: unknown;
  target?: unknown;
  header?: unknown;
  bodyLength?: unknown;
};

type StreamResponse = {
  ok: boolean;
  statusCode: number;
  header?: HeaderRecord;
  bodyLength?: number;
  error?: string;
};

type TunnelHubTunnelClientOptions = {
  relayUrl: string;
  relayToken: string;
  desktopWebSocketTargetUrl?: string;
  tlsInsecureSkipVerify?: boolean;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
};

const KIND_HTTP = "http";
const KIND_WEBSOCKET = "websocket";
const KIND_DESKTOP_WEBSOCKET = "desktop.websocket";
const MAX_JSON_FRAME_BYTES = 1 << 20;
const MAX_WS_FRAME_BYTES = 64 << 20;

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readBodyLength(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return 0;
}

function normalizeHeader(value: unknown): HeaderRecord {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: HeaderRecord = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
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

function stripHopHeaders(header: HeaderRecord): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [key, value] of Object.entries(header)) {
    if (isHopHeader(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function stripWebSocketDialHeaders(header: HeaderRecord): HeaderRecord {
  const out = stripHopHeaders(header);
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

function buildTargetUrl(target: string, requestPath: string, websocket: boolean) {
  const base = new URL(target);
  const request = new URL(requestPath || "/", base);
  base.pathname = joinUrlPath(base.pathname, request.pathname);
  base.search = request.search;
  if (websocket) {
    if (base.protocol === "http:") {
      base.protocol = "ws:";
    } else if (base.protocol === "https:") {
      base.protocol = "wss:";
    } else if (base.protocol !== "ws:" && base.protocol !== "wss:") {
      throw new Error(`unsupported websocket target scheme: ${base.protocol}`);
    }
  }
  return base.toString();
}

function joinUrlPath(basePath: string, requestPath: string) {
  if (!basePath || basePath === "/") {
    return requestPath || "/";
  }
  if (!requestPath || requestPath === "/") {
    return basePath;
  }
  return `${basePath.replace(/\/+$/u, "")}/${requestPath.replace(/^\/+/u, "")}`;
}

function targetHost(rawUrl: string) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "";
  }
}

function incomingHeadersToRecord(headers: IncomingHttpHeaders): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

async function readTunnelJson(stream: TunnelHubYamuxStream) {
  const prefix = await stream.readExactly(4);
  const size = prefix.readUInt32BE(0);
  if (size > MAX_JSON_FRAME_BYTES) {
    throw new Error(`json frame too large: ${size}`);
  }
  const data = await stream.readExactly(size);
  return JSON.parse(data.toString("utf8")) as StreamRequest;
}

async function writeTunnelJson(stream: TunnelHubYamuxStream, value: StreamResponse) {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  if (data.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new Error(`json frame too large: ${data.byteLength}`);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.byteLength, 0);
  await stream.write(Buffer.concat([prefix, data]));
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

function requestLocalHttp(targetUrl: string, request: StreamRequest, body: Buffer) {
  return new Promise<{ statusCode: number; headers: HeaderRecord; body: Buffer }>((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const headers = stripHopHeaders(normalizeHeader(request.header));
    const requestId = readText(request.requestId);
    headers["X-Forwarded-Host"] = readText(request.host);
    if (requestId) {
      headers["X-Zenm-Request-ID"] = requestId;
    }
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      method: readText(request.method) || "GET",
      path: `${parsed.pathname || "/"}${parsed.search}`,
      headers,
      host: targetHost(targetUrl)
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 200,
          headers: stripHopHeaders(incomingHeadersToRecord(res.headers)),
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on("error", reject);
    if (body.byteLength > 0) {
      req.write(body);
    }
    req.end();
  });
}

export class TunnelHubTunnelClient extends EventEmitter {
  private ws: TunnelHubWebSocketClient | null = null;
  private session: TunnelHubYamuxSession | null = null;
  private closed = false;

  constructor(private readonly options: TunnelHubTunnelClientOptions) {
    super();
  }

  async connect() {
    if (this.closed) {
      throw new Error("tunnel client is closed");
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
        this.options.logger?.warn?.(`[tunnel-hub] stream failed: ${error instanceof Error ? error.message : String(error)}`);
        stream.reset();
      });
    });
    session.on("error", (error) => this.emit("error", error));
    session.on("close", () => this.emit("close"));
  }

  close() {
    this.closed = true;
    this.session?.close();
    this.ws?.close(1000, "tunnel client stopping");
    this.session = null;
    this.ws = null;
  }

  private async handleStream(stream: TunnelHubYamuxStream) {
    const request = await readTunnelJson(stream);
    switch (readText(request.kind)) {
      case KIND_HTTP:
        await this.handleHttpStream(stream, request);
        return;
      case KIND_WEBSOCKET:
        await this.handleWebSocketStream(stream, request);
        return;
      case KIND_DESKTOP_WEBSOCKET:
        await this.handleWebSocketStream(stream, request, readText(this.options.desktopWebSocketTargetUrl));
        return;
      default:
        await writeTunnelJson(stream, {
          ok: false,
          statusCode: 400,
          error: "unknown stream kind"
        });
        stream.end();
    }
  }

  private async handleHttpStream(stream: TunnelHubYamuxStream, request: StreamRequest) {
    try {
      const targetUrl = buildTargetUrl(readText(request.target), readText(request.path) || "/", false);
      const bodyLength = readBodyLength(request.bodyLength);
      const body = bodyLength > 0 ? await stream.readExactly(bodyLength) : Buffer.alloc(0);
      const response = await requestLocalHttp(targetUrl, request, body);
      await writeTunnelJson(stream, {
        ok: true,
        statusCode: response.statusCode,
        header: response.headers,
        bodyLength: response.body.byteLength
      });
      if (response.body.byteLength > 0) {
        await stream.write(response.body);
      }
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

  private async handleWebSocketStream(stream: TunnelHubYamuxStream, request: StreamRequest, targetOverride = "") {
    let localWs: TunnelHubWebSocketClient | null = null;
    try {
      const targetUrl = buildTargetUrl(targetOverride || readText(request.target), readText(request.path) || "/", true);
      const headers = stripWebSocketDialHeaders(normalizeHeader(request.header));
      const requestId = readText(request.requestId);
      headers["X-Forwarded-Host"] = readText(request.host);
      if (requestId) {
        headers["X-Zenm-Request-ID"] = requestId;
      }
      localWs = await connectTunnelHubWebSocket(targetUrl, {
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
        localWs.sendMessage(frame.type, frame.payload);
      }
    } catch {
      closeBoth();
    }
  }
}
