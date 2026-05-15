import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { WebContents, WebFrameMain } from "electron";
import {
  EMBEDDED_CDP_GATEWAY_HOST,
  EMBEDDED_CDP_GATEWAY_PORT
} from "../shared/embedded-cdp";

type EmbeddedCdpTargetKind = "webview" | "iframe";

export type EmbeddedCdpSurface = {
  id: string;
  label: string;
  url: string;
  kind?: EmbeddedCdpTargetKind;
  active?: boolean;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  agentKey?: string;
  frameMatchUrl?: string;
};

export type EmbeddedCdpFrameTarget = {
  frame: WebFrameMain;
  ownerContents: WebContents;
};

type EmbeddedCdpGatewayOptions = {
  host?: string;
  port?: number;
  getSurfaces: () => EmbeddedCdpSurface[] | Promise<EmbeddedCdpSurface[]>;
  resolveWebContents: (surface: EmbeddedCdpSurface) => WebContents | null | Promise<WebContents | null>;
  resolveFrameTarget?: (surface: EmbeddedCdpSurface) => EmbeddedCdpFrameTarget | null | Promise<EmbeddedCdpFrameTarget | null>;
  activateSurface?: (surface: EmbeddedCdpSurface) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  version?: string;
};

type CdpCommand = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type CdpConnectionSession = {
  targetId: string;
  debuggerRef: WebContents["debugger"];
  ownsAttach: boolean;
  messageListener: (event: unknown, method: string, params?: unknown) => void;
};

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PROTOCOL_VERSION = "1.3";
const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function normalizeTargetKind(kind: EmbeddedCdpSurface["kind"]): EmbeddedCdpTargetKind {
  return kind === "iframe" ? "iframe" : "webview";
}

function stableTargetId(surface: EmbeddedCdpSurface) {
  const source = `${normalizeTargetKind(surface.kind)}:${surface.id || surface.url || surface.label}`;
  return `zenmind-${crypto.createHash("sha1").update(source).digest("hex").slice(0, 16)}`;
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/%2F/giu, "-");
}

function cdpError(id: number | undefined, code: number, message: string, data?: unknown): CdpResponse {
  return {
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function responseJSON(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function parseRequestUrl(req: http.IncomingMessage, host: string, port: number) {
  return new URL(req.url || "/", `http://${host}:${port}`);
}

function parseTargetUrl(req: http.IncomingMessage, host: string, port: number) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").trim();
  const proto = forwardedProto === "https" ? "https" : "http";
  const headerHost = String(req.headers.host || `${host}:${port}`);
  return {
    httpOrigin: `${proto}://${headerHost}`,
    wsOrigin: `${proto === "https" ? "wss" : "ws"}://${headerHost}`
  };
}

function isLoopbackAddress(value: string | undefined) {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1" || value === "::1";
}

function targetDescriptor(
  surface: EmbeddedCdpSurface,
  targetId: string,
  origins: { httpOrigin: string; wsOrigin: string }
) {
  const url = surface.currentUrl || surface.url || "about:blank";
  const title = surface.title || surface.label || url;
  const encodedTargetId = encodePathSegment(targetId);
  return {
    description: "",
    devtoolsFrontendUrl: `/devtools/inspector.html?ws=${origins.wsOrigin.replace(/^wss?:\/\//u, "")}/devtools/page/${encodedTargetId}`,
    id: targetId,
    title,
    type: "page",
    url,
    webSocketDebuggerUrl: `${origins.wsOrigin}/devtools/page/${encodedTargetId}`,
    surfaceId: surface.id,
    surfaceLabel: surface.label,
    agentKey: surface.agentKey || "",
    webContentsId: surface.webContentsId ?? null,
    zenmind: {
      kind: normalizeTargetKind(surface.kind),
      surfaceId: surface.id,
      surfaceLabel: surface.label,
      agentKey: surface.agentKey || "",
      webContentsId: surface.webContentsId ?? null,
      active: Boolean(surface.active)
    }
  };
}

function remoteObject(value: unknown) {
  if (value === null) {
    return { type: "object", subtype: "null", value: null };
  }
  if (Array.isArray(value)) {
    return { type: "object", subtype: "array", value };
  }
  const valueType = typeof value;
  if (valueType === "undefined") {
    return { type: "undefined" };
  }
  if (valueType === "number") {
    return { type: "number", value };
  }
  if (valueType === "boolean") {
    return { type: "boolean", value };
  }
  if (valueType === "string") {
    return { type: "string", value };
  }
  if (valueType === "bigint") {
    return { type: "bigint", unserializableValue: String(value) };
  }
  if (valueType === "function") {
    return { type: "function", description: String(value) };
  }
  return { type: "object", value };
}

function evaluateParams(params: Record<string, unknown> | undefined) {
  const expression = typeof params?.expression === "string" ? params.expression : "";
  if (!expression.trim()) {
    throw new Error("Runtime.evaluate requires params.expression.");
  }
  return expression;
}

function ensureHttpUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function createWebSocketAccept(key: string) {
  return crypto
    .createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
}

function createServerFrame(opcode: number, payload: Buffer) {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(
      127,
      Number((length >> 56n) & 0xffn),
      Number((length >> 48n) & 0xffn),
      Number((length >> 40n) & 0xffn),
      Number((length >> 32n) & 0xffn),
      Number((length >> 24n) & 0xffn),
      Number((length >> 16n) & 0xffn),
      Number((length >> 8n) & 0xffn),
      Number(length & 0xffn)
    );
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

class CdpWebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void
  ) {
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.closeLocal());
    socket.on("error", () => this.closeLocal());
  }

  sendJSON(payload: unknown) {
    this.sendText(JSON.stringify(payload));
  }

  sendText(text: string) {
    if (this.closed || this.socket.destroyed) {
      return;
    }
    this.socket.write(createServerFrame(0x1, Buffer.from(text, "utf8")));
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.write(createServerFrame(0x8, Buffer.alloc(0)));
    } finally {
      this.socket.end();
      this.onClose();
    }
  }

  private closeLocal() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
  }

  private handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + payloadLength) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + payloadLength);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(createServerFrame(0xa, payload));
        continue;
      }
      if (opcode === 0x1) {
        this.onText(payload.toString("utf8"));
      }
    }
  }
}

export class EmbeddedCdpGateway {
  private readonly host: string;
  private readonly port: number;
  private readonly version: string;
  private server: http.Server | null = null;
  private readonly sessions = new Map<CdpWebSocketConnection, CdpConnectionSession>();

  constructor(private readonly options: EmbeddedCdpGatewayOptions) {
    this.host = options.host ?? EMBEDDED_CDP_GATEWAY_HOST;
    this.port = options.port ?? EMBEDDED_CDP_GATEWAY_PORT;
    this.version = options.version ?? "ZenMind Embedded Chromium";
  }

  start() {
    if (this.server) {
      return this.server;
    }

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((error) => {
        responseJSON(res, 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    server.on("upgrade", (req, socket) => {
      void this.handleUpgrade(req, socket as Socket).catch(() => {
        socket.destroy();
      });
    });
    server.on("error", (error) => {
      console.warn(`[embedded-cdp] failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    server.listen(this.port, this.host, () => {
      const address = server.address() as AddressInfo | null;
      console.log(`[embedded-cdp] listening on ${this.host}:${address?.port ?? this.port}`);
    });
    this.server = server;
    return server;
  }

  stop() {
    for (const connection of [...this.sessions.keys()]) {
      connection.close();
    }
    const server = this.server;
    this.server = null;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  async listTargets(req?: http.IncomingMessage) {
    const origins = req
      ? parseTargetUrl(req, this.host, this.port)
      : {
          httpOrigin: `http://${this.host}:${this.port}`,
          wsOrigin: `ws://${this.host}:${this.port}`
        };
    const surfaces = await this.options.getSurfaces();
    return surfaces
      .filter((surface) => surface.id && surface.url)
      .map((surface) => targetDescriptor(surface, stableTargetId(surface), origins));
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      responseJSON(res, 403, { error: "Embedded CDP Gateway only accepts localhost requests." });
      return;
    }
    const url = parseRequestUrl(req, this.host, this.port);
    if (req.method === "GET" && (url.pathname === "/json" || url.pathname === "/json/list")) {
      responseJSON(res, 200, await this.listTargets(req));
      return;
    }
    if (req.method === "GET" && url.pathname === "/json/version") {
      const { wsOrigin } = parseTargetUrl(req, this.host, this.port);
      responseJSON(res, 200, {
        Browser: this.version,
        "Protocol-Version": DEFAULT_PROTOCOL_VERSION,
        "User-Agent": this.version,
        webSocketDebuggerUrl: `${wsOrigin}/devtools/browser/zenmind-embedded`
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/json/activate/")) {
      const targetId = decodeURIComponent(url.pathname.slice("/json/activate/".length));
      const target = await this.resolveSurface(targetId);
      if (!target) {
        responseJSON(res, 404, { error: "target_not_found" });
        return;
      }
      await this.options.activateSurface?.(target);
      const origins = parseTargetUrl(req, this.host, this.port);
      responseJSON(res, 200, targetDescriptor(await this.refreshSurface(target), stableTargetId(target), origins));
      return;
    }
    if (req.method === "GET" && url.pathname === "/json/new") {
      const targetUrl = ensureHttpUrl(decodeURIComponent(url.search.slice(1)));
      if (!targetUrl) {
        responseJSON(res, 400, { error: "invalid_url" });
        return;
      }
      await this.options.openUrl?.(targetUrl);
      const targets = await this.listTargets(req);
      responseJSON(res, 200, targets.find((target) => target.url === targetUrl) ?? targets[0] ?? {});
      return;
    }
    responseJSON(res, 404, { error: "not_found" });
  }

  private async handleUpgrade(req: http.IncomingMessage, socket: Socket) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const url = parseRequestUrl(req, this.host, this.port);
    if (!url.pathname.startsWith("/devtools/page/")) {
      socket.destroy();
      return;
    }
    const key = String(req.headers["sec-websocket-key"] || "");
    if (!key) {
      socket.destroy();
      return;
    }
    const targetId = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
    const surface = await this.resolveSurface(targetId);
    if (!surface) {
      socket.destroy();
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
      "",
      ""
    ].join("\r\n"));

    const connection = new CdpWebSocketConnection(
      socket,
      (text) => {
        void this.handleTextMessage(connection, targetId, text);
      },
      () => this.releaseConnection(connection)
    );
  }

  private async handleTextMessage(connection: CdpWebSocketConnection, targetId: string, text: string) {
    let command: CdpCommand;
    try {
      command = JSON.parse(text) as CdpCommand;
    } catch {
      connection.sendJSON(cdpError(undefined, -32700, "Parse error"));
      return;
    }
    const id = command.id;
    const method = typeof command.method === "string" ? command.method : "";
    if (!method) {
      connection.sendJSON(cdpError(id, -32600, "Invalid request: method is required."));
      return;
    }
    try {
      const surface = await this.resolveSurface(targetId);
      if (!surface) {
        connection.sendJSON(cdpError(id, -32000, "Target not found."));
        return;
      }
      const kind = normalizeTargetKind(surface.kind);
      const result = kind === "iframe"
        ? await this.handleFrameCommand(surface, method, command.params ?? {})
        : await this.handleWebContentsCommand(connection, targetId, surface, method, command.params ?? {});
      connection.sendJSON({ id, result });
    } catch (error) {
      connection.sendJSON(cdpError(
        id,
        -32000,
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  private async handleWebContentsCommand(
    connection: CdpWebSocketConnection,
    targetId: string,
    surface: EmbeddedCdpSurface,
    method: string,
    params: Record<string, unknown>
  ) {
    const contents = await this.ensureWebContents(surface);
    if (!contents || contents.isDestroyed()) {
      throw new Error("Embedded webContents target is unavailable.");
    }
    if (method === "Page.bringToFront") {
      await this.options.activateSurface?.(surface);
      return {};
    }
    const session = this.ensureDebuggerSession(connection, targetId, contents);
    return session.debuggerRef.sendCommand(method, params);
  }

  private async handleFrameCommand(surface: EmbeddedCdpSurface, method: string, params: Record<string, unknown>) {
    const target = await this.ensureFrameTarget(surface);
    if (!target) {
      throw new Error("Embedded iframe target is unavailable.");
    }
    switch (method) {
      case "Runtime.evaluate": {
        const value = await target.frame.executeJavaScript(evaluateParams(params));
        return { result: remoteObject(value) };
      }
      case "Page.enable":
      case "Runtime.enable":
      case "DOM.enable":
      case "Network.enable":
        return {};
      case "Page.bringToFront":
        await this.options.activateSurface?.(surface);
        return {};
      case "Page.reload":
        await target.frame.executeJavaScript("location.reload(); true;");
        return {};
      case "Page.navigate": {
        const nextUrl = ensureHttpUrl(params.url);
        if (!nextUrl) {
          throw new Error("Page.navigate requires an http(s) url.");
        }
        await target.frame.executeJavaScript(`location.href = ${JSON.stringify(nextUrl)}; true;`);
        return { frameId: surface.id, loaderId: "" };
      }
      case "Page.captureScreenshot": {
        const image = await target.ownerContents.capturePage();
        return { data: image.toPNG().toString("base64") };
      }
      case "DOM.getDocument":
        return {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: 9,
            nodeName: "#document",
            localName: "",
            nodeValue: "",
            documentURL: target.frame.url
          }
        };
      case "Input.dispatchMouseEvent": {
        const type = typeof params.type === "string" ? params.type : "";
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("Input.dispatchMouseEvent requires numeric x and y.");
        }
        if (type === "mousePressed" || type === "mouseReleased" || type === "mouseMoved") {
          await target.frame.executeJavaScript([
            "(() => {",
            `  const x = ${JSON.stringify(x)};`,
            `  const y = ${JSON.stringify(y)};`,
            `  const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});`,
            "  if (!el) return false;",
            `  const type = ${JSON.stringify(type === "mousePressed" ? "mousedown" : type === "mouseReleased" ? "mouseup" : "mousemove")};`,
            "  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));",
            "  if (type === 'mouseup') el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));",
            "  return true;",
            "})();"
          ].join("\n"));
        }
        return {};
      }
      case "Input.insertText": {
        const text = typeof params.text === "string" ? params.text : "";
        await target.frame.executeJavaScript([
          "(() => {",
          `  const text = ${JSON.stringify(text)};`,
          "  const el = document.activeElement;",
          "  if (!el) return false;",
          "  if ('value' in el) {",
          "    const start = typeof el.selectionStart === 'number' ? el.selectionStart : String(el.value || '').length;",
          "    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;",
          "    el.value = String(el.value || '').slice(0, start) + text + String(el.value || '').slice(end);",
          "    el.dispatchEvent(new Event('input', { bubbles: true }));",
          "    return true;",
          "  }",
          "  document.execCommand('insertText', false, text);",
          "  return true;",
          "})();"
        ].join("\n"));
        return {};
      }
      default:
        throw new Error(`CDP method is not supported for iframe targets: ${method}`);
    }
  }

  private async ensureFrameTarget(surface: EmbeddedCdpSurface) {
    let target = await this.options.resolveFrameTarget?.(surface);
    if (target) {
      return target;
    }
    await this.options.activateSurface?.(surface);
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_CDP_TIMEOUT_MS) {
      target = await this.options.resolveFrameTarget?.(surface);
      if (target) {
        return target;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  private async ensureWebContents(surface: EmbeddedCdpSurface) {
    let contents = await this.options.resolveWebContents(surface);
    if (contents && !contents.isDestroyed()) {
      return contents;
    }
    await this.options.activateSurface?.(surface);
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_CDP_TIMEOUT_MS) {
      contents = await this.options.resolveWebContents(surface);
      if (contents && !contents.isDestroyed()) {
        return contents;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  private ensureDebuggerSession(
    connection: CdpWebSocketConnection,
    targetId: string,
    contents: WebContents
  ): CdpConnectionSession {
    const current = this.sessions.get(connection);
    if (current && current.targetId === targetId) {
      return current;
    }
    if (current) {
      this.releaseConnection(connection);
    }

    const debuggerRef = contents.debugger;
    const ownsAttach = !debuggerRef.isAttached();
    if (ownsAttach) {
      debuggerRef.attach(DEFAULT_PROTOCOL_VERSION);
    }
    const messageListener = (_event: unknown, method: string, params?: unknown) => {
      connection.sendJSON({
        method,
        params: params ?? {}
      });
    };
    debuggerRef.on("message", messageListener);
    const session = {
      targetId,
      debuggerRef,
      ownsAttach,
      messageListener
    };
    this.sessions.set(connection, session);
    return session;
  }

  private releaseConnection(connection: CdpWebSocketConnection) {
    const session = this.sessions.get(connection);
    if (!session) {
      return;
    }
    this.sessions.delete(connection);
    session.debuggerRef.off("message", session.messageListener);
    if (session.ownsAttach && session.debuggerRef.isAttached()) {
      try {
        session.debuggerRef.detach();
      } catch {
        // Ignore detach failures while the target is closing.
      }
    }
  }

  private async resolveSurface(targetId: string) {
    const surfaces = await this.options.getSurfaces();
    return surfaces.find((surface) => stableTargetId(surface) === targetId || surface.id === targetId) ?? null;
  }

  private async refreshSurface(surface: EmbeddedCdpSurface) {
    const targetId = stableTargetId(surface);
    return (await this.resolveSurface(targetId)) ?? surface;
  }
}

export const __testInternals = {
  createServerFrame,
  stableTargetId,
  targetDescriptor,
  remoteObject
};
