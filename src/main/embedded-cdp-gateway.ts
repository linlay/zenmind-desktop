import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { WebContents } from "electron";
import {
  EMBEDDED_CDP_GATEWAY_HOST,
  EMBEDDED_CDP_GATEWAY_PORT,
  type EmbeddedCdpSurfaceKind
} from "../shared/embedded-cdp";
import { PRODUCT_NAME } from "../shared/brand";
import type { SurfaceIdentity } from "../shared/surface-identity";
import {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  isDesktopCdpTimeoutError,
  readDesktopCdpErrorDetails,
  sendDesktopCdpCommand
} from "./desktop-cdp-debugger";

export type EmbeddedCdpSurface = SurfaceIdentity & {
  id: string;
  targetGeneration?: string;
  label: string;
  url: string;
  kind?: "webview";
  active?: boolean;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  copilotAgentKey?: string;
  surfaceRoute?: string;
  embedPath?: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  open: boolean;
  tabs?: EmbeddedCdpSurfaceTab[];
  activeTabId?: string | null;
  ownerChatId?: string;
};

export type EmbeddedCdpSurfaceTab = {
  tabId: string;
  currentUrl: string;
  title: string;
  webContentsId: number;
  faviconUrl?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
};

type EmbeddedCdpGatewayOptions = {
  host?: string;
  port?: number;
  getSurfaces: () => EmbeddedCdpSurface[] | Promise<EmbeddedCdpSurface[]>;
  resolveWebContents: (surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) => WebContents | null | Promise<WebContents | null>;
  activateTarget?: (surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) => Promise<void>;
  closeTarget?: (surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) => Promise<unknown>;
  version?: string;
  commandTimeoutMs?: number;
  logger?: Pick<Console, "debug" | "warn">;
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
  webContentsId: number;
  debuggerRef: WebContents["debugger"];
  ownsAttach: boolean;
  messageListener: (event: unknown, method: string, params?: unknown) => void;
};

export type EmbeddedCdpCommandRequest = {
  method: string;
  params?: Record<string, unknown>;
  targetId?: string;
  source?: { chatId?: string };
};

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PROTOCOL_VERSION = "1.3";
const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export class EmbeddedCdpInvalidArgsError extends Error {
  readonly code = "invalid_args";
}

export class EmbeddedCdpTargetError extends Error {
  constructor(readonly code: "target_required" | "current_target_unavailable" | "target_not_in_current_surface" | "target_not_owned_by_chat" | "target_not_found", message: string) {
    super(message);
  }
}

export function createEmbeddedCdpTargetId(surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) {
  const generation = surface.targetGeneration || String(tab.webContentsId);
  const source = `webview:${generation}:${surface.id}:${tab.tabId}`;
  return `desktop-${crypto.createHash("sha1").update(source).digest("hex").slice(0, 16)}`;
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
  tab: EmbeddedCdpSurfaceTab,
  targetId: string,
  origins: { httpOrigin: string; wsOrigin: string }
) {
  const url = tab.currentUrl || surface.currentUrl || surface.url || "about:blank";
  const title = tab.title || surface.title || surface.label || url;
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
    tabId: tab.tabId,
    surfaceKind: surface.surfaceKind,
    surfaceRole: surface.surfaceRole,
    surfaceLevel: surface.surfaceLevel,
    parentSurfaceId: surface.parentSurfaceId || "",
    interaction: surface.interaction,
    open: surface.open,
    surfaceRoute: surface.surfaceRoute || "",
    copilotAgentKey: surface.copilotAgentKey || ""
  };
}

function targetInfoDescriptor(surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab, targetId: string, current: boolean) {
  const url = tab.currentUrl || surface.currentUrl || surface.url || "about:blank";
  const title = tab.title || surface.title || surface.label || url;
  return {
    attached: false,
    canAccessOpener: false,
    active: current,
    current,
    targetId,
    title,
    type: "webview",
    url,
    surfaceId: surface.id,
    tabId: tab.tabId,
    surfaceKind: surface.surfaceKind,
    surfaceRole: surface.surfaceRole,
    surfaceLevel: surface.surfaceLevel,
    parentSurfaceId: surface.parentSurfaceId || "",
    interaction: surface.interaction,
    open: surface.open,
    surfaceRoute: surface.surfaceRoute || "",
    copilotAgentKey: surface.copilotAgentKey || ""
  };
}

function readWebContentsString(contents: WebContents, key: "getTitle" | "getURL") {
  try {
    const reader = (contents as unknown as Record<string, unknown>)[key];
    return typeof reader === "function" ? String(reader.call(contents) || "") : "";
  } catch {
    return "";
  }
}

function surfaceTabs(surface: EmbeddedCdpSurface): EmbeddedCdpSurfaceTab[] {
  if (Array.isArray(surface.tabs) && surface.tabs.length > 0) {
    return surface.tabs;
  }
  if (!Number.isSafeInteger(surface.webContentsId) || !surface.webContentsId) {
    return [];
  }
  return [{
    tabId: `${surface.id}:default`,
    currentUrl: surface.currentUrl || surface.url,
    title: surface.title || surface.label,
    webContentsId: surface.webContentsId
  }];
}

function activeSurfaceTab(surface: EmbeddedCdpSurface) {
  const tabs = surfaceTabs(surface);
  if (Array.isArray(surface.tabs)) {
    return surface.activeTabId
      ? tabs.find((tab) => tab.tabId === surface.activeTabId) ?? null
      : null;
  }
  return tabs[0] ?? null;
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
    this.version = options.version ?? `${PRODUCT_NAME} Embedded Chromium`;
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
    const surface = this.resolveCurrentSurface(await this.listValidSurfaces());
    if (!surface) {
      return [];
    }
    return surfaceTabs(surface).map((tab) =>
      targetDescriptor(surface, tab, createEmbeddedCdpTargetId(surface, tab), origins)
    );
  }

  async executeCommand(request: EmbeddedCdpCommandRequest) {
    const method = typeof request.method === "string" ? request.method.trim() : "";
    if (!method) {
      throw new Error("method is required");
    }
    const params = request.params ?? {};
    if (method === "Target.getTargets" || method === "Target.getCurrentTarget") {
      if (Object.keys(params).length > 0) {
        throw new EmbeddedCdpInvalidArgsError(`${method} does not accept params.`);
      }
      const surface = this.resolveCurrentSurface(await this.listValidSurfaces());
      const tabs = surface ? surfaceTabs(surface) : [];
      const currentTab = surface ? activeSurfaceTab(surface) : null;
      const targetId = surface && currentTab ? createEmbeddedCdpTargetId(surface, currentTab) : null;
      const targetInfo = surface && currentTab && targetId
        ? targetInfoDescriptor(surface, currentTab, targetId, true)
        : null;
      if (method === "Target.getCurrentTarget") {
        return {
          ...(targetId && surface ? { targetId, surfaceId: surface.id } : {}),
          result: {
            targetInfo,
            currentTargetId: targetId,
            currentSurfaceId: surface?.id ?? null,
            activeTabId: currentTab?.tabId ?? null
          }
        };
      }
      return {
        ...(targetId && surface ? { targetId, surfaceId: surface.id } : {}),
        result: {
          targetInfos: surface
            ? tabs.map((tab) => {
                const candidateTargetId = createEmbeddedCdpTargetId(surface, tab);
                return targetInfoDescriptor(surface, tab, candidateTargetId, candidateTargetId === targetId);
              })
            : [],
          currentTargetInfo: targetInfo,
          currentTargetId: targetId,
          currentSurfaceId: surface?.id ?? null,
          activeTabId: currentTab?.tabId ?? null
        }
      };
    }
    const { surface, tab, targetId } = await this.resolveCommandTarget(request);
    if (method === "Target.closeTarget") {
      if (Object.keys(params).length > 0) {
        throw new EmbeddedCdpInvalidArgsError("Target.closeTarget does not accept params after targetId resolution.");
      }
      if (!this.options.closeTarget) {
        throw new Error("Target.closeTarget is unavailable.");
      }
      await this.options.closeTarget(surface, tab);
      return {
        targetId,
        surfaceId: surface.id,
        result: { success: true }
      };
    }
    const result = await this.handleWebContentsCommandOnce(surface, tab, targetId, method, params);
    return {
      targetId,
      surfaceId: surface.id,
      result
    };
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
        webSocketDebuggerUrl: `${wsOrigin}/devtools/browser/desktop-embedded`
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/json/activate/")) {
      const targetId = decodeURIComponent(url.pathname.slice("/json/activate/".length));
      let target: { surface: EmbeddedCdpSurface; tab: EmbeddedCdpSurfaceTab; targetId: string };
      try {
        target = await this.resolveCommandTarget({ method: "Page.bringToFront", targetId });
      } catch (error) {
        const code = error instanceof EmbeddedCdpTargetError ? error.code : "target_not_found";
        responseJSON(res, 404, { error: code });
        return;
      }
      await this.options.activateTarget?.(target.surface, target.tab);
      const origins = parseTargetUrl(req, this.host, this.port);
      responseJSON(res, 200, targetDescriptor(target.surface, target.tab, target.targetId, origins));
      return;
    }
    if (req.method === "GET" && url.pathname === "/json/new") {
      responseJSON(res, 405, { error: "method_not_allowed" });
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
    const target = await this.resolveCurrentTargetById(targetId);
    if (!target) {
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
      if (method === "Target.closeTarget") {
        const paramsTargetId = typeof command.params?.targetId === "string"
          ? command.params.targetId.trim()
          : "";
        if (paramsTargetId && paramsTargetId !== targetId) {
          throw new EmbeddedCdpInvalidArgsError("params.targetId conflicts with the current WebSocket target.");
        }
        const extraParamKeys = Object.keys(command.params ?? {}).filter((key) => key !== "targetId");
        if (extraParamKeys.length > 0) {
          throw new EmbeddedCdpInvalidArgsError("Target.closeTarget only accepts params.targetId.");
        }
      }
      const target = await this.resolveCommandTarget({ method, targetId });
      const result = await this.handleWebContentsCommand(connection, target, method, command.params ?? {});
      connection.sendJSON({ id, result });
      if (method === "Target.closeTarget") {
        this.releaseConnection(connection);
      }
    } catch (error) {
      if (isDesktopCdpTimeoutError(error)) {
        this.releaseConnection(connection);
        connection.sendJSON(cdpError(id, -32000, error.message, {
          code: DESKTOP_CDP_TARGET_TIMEOUT_CODE,
          details: readDesktopCdpErrorDetails(error)
        }));
        return;
      }
      if (error instanceof EmbeddedCdpTargetError) {
        if (error.code === "target_not_in_current_surface" || error.code === "target_not_found") {
          this.releaseConnection(connection);
        }
        connection.sendJSON(cdpError(id, -32000, error.message, { code: error.code }));
        return;
      }
      if (error instanceof EmbeddedCdpInvalidArgsError) {
        connection.sendJSON(cdpError(id, -32602, error.message, { code: error.code }));
        return;
      }
      connection.sendJSON(cdpError(
        id,
        -32000,
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  private async handleWebContentsCommand(
    connection: CdpWebSocketConnection,
    target: { surface: EmbeddedCdpSurface; tab: EmbeddedCdpSurfaceTab; targetId: string },
    method: string,
    params: Record<string, unknown>
  ) {
    if (method === "Target.closeTarget") {
      if (!this.options.closeTarget) {
        throw new Error("Target.closeTarget is unavailable.");
      }
      await this.options.closeTarget(target.surface, target.tab);
      return { success: true };
    }
    const contents = await this.ensureWebContents(target.surface, target.tab);
    if (!contents || contents.isDestroyed()) {
      throw new Error("Embedded webContents target is unavailable.");
    }
    if (method === "Page.bringToFront") {
      await this.options.activateTarget?.(target.surface, target.tab);
      return {};
    }
    const session = this.ensureDebuggerSession(connection, target.targetId, contents);
    return sendDesktopCdpCommand(session.debuggerRef, method, params, this.buildCommandDebugContext(target.surface, target.targetId, contents));
  }

  private async handleWebContentsCommandOnce(
    surface: EmbeddedCdpSurface,
    tab: EmbeddedCdpSurfaceTab,
    targetId: string,
    method: string,
    params: Record<string, unknown>
  ) {
    const contents = await this.ensureWebContents(surface, tab);
    if (!contents || contents.isDestroyed()) {
      throw new Error("Embedded webContents target is unavailable.");
    }
    if (method === "Page.bringToFront") {
      await this.options.activateTarget?.(surface, tab);
      return {};
    }
    const debuggerRef = contents.debugger;
    const ownsAttach = !debuggerRef.isAttached();
    if (ownsAttach) {
      debuggerRef.attach(DEFAULT_PROTOCOL_VERSION);
    }
    try {
      return await sendDesktopCdpCommand(debuggerRef, method, params, this.buildCommandDebugContext(surface, targetId, contents));
    } finally {
      if (ownsAttach && debuggerRef.isAttached()) {
        try {
          debuggerRef.detach();
        } catch {
          // Ignore detach failures while the target is closing.
        }
      }
    }
  }

  private buildCommandDebugContext(
    surface: EmbeddedCdpSurface,
    targetId: string,
    contents: WebContents
  ) {
    return {
      targetId,
      surfaceId: surface.id,
      webContentsId: contents.id,
      url: readWebContentsString(contents, "getURL") || surface.currentUrl || surface.url,
      title: readWebContentsString(contents, "getTitle") || surface.title || surface.label,
      timeoutMs: this.options.commandTimeoutMs,
      logger: this.options.logger
    };
  }

  private async ensureWebContents(surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) {
    let contents = await this.options.resolveWebContents(surface, tab);
    if (contents && !contents.isDestroyed()) {
      return contents;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEFAULT_CDP_TIMEOUT_MS) {
      contents = await this.options.resolveWebContents(surface, tab);
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
    if (current && current.targetId === targetId && current.webContentsId === contents.id) {
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
      webContentsId: contents.id,
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
    try {
      session.debuggerRef.off("message", session.messageListener);
    } catch {
      // The guest may already be destroyed by the shared tab-close transaction.
    }
    if (session.ownsAttach && session.debuggerRef.isAttached()) {
      try {
        session.debuggerRef.detach();
      } catch {
        // Ignore detach failures while the target is closing.
      }
    }
  }

  private async listValidSurfaces() {
    const surfaces = await this.options.getSurfaces();
    return surfaces.filter((surface) => surface.id && surface.url);
  }

  private resolveCurrentSurface(surfaces: EmbeddedCdpSurface[]) {
    return surfaces.find((surface) => surface.active) ?? null;
  }

  private targetsForSurface(surface: EmbeddedCdpSurface) {
    return surfaceTabs(surface).map((tab) => ({
      surface,
      tab,
      targetId: createEmbeddedCdpTargetId(surface, tab)
    }));
  }

  private async resolveCurrentTargetById(targetId: string) {
    const surfaces = await this.listValidSurfaces();
    const currentSurface = this.resolveCurrentSurface(surfaces);
    if (!currentSurface) {
      return null;
    }
    return this.targetsForSurface(currentSurface).find((target) => target.targetId === targetId) ?? null;
  }

  private async resolveCommandTarget(request: EmbeddedCdpCommandRequest) {
    const targetId = typeof request.targetId === "string" ? request.targetId.trim() : "";
    if (!targetId) {
      throw new EmbeddedCdpTargetError("target_required", "targetId is required for this CDP method.");
    }
    const surfaces = await this.listValidSurfaces();
    const currentSurface = this.resolveCurrentSurface(surfaces);
    const requestedChatId = typeof request.source?.chatId === "string" ? request.source.chatId.trim() : "";
    const matchingTarget = surfaces
      .flatMap((surface) => this.targetsForSurface(surface))
      .find((target) => target.targetId === targetId) ?? null;
    if (matchingTarget?.surface.surfaceKind === "chat-work-panel") {
      if (requestedChatId && matchingTarget.surface.ownerChatId === requestedChatId) {
        return matchingTarget;
      }
      if (requestedChatId) {
        throw new EmbeddedCdpTargetError(
          "target_not_owned_by_chat",
          "The Work Panel target does not belong to the calling chat."
        );
      }
    }
    if (!currentSurface) {
      const existsOutsideCurrentSurface = surfaces
        .some((surface) => this.targetsForSurface(surface).some((target) => target.targetId === targetId));
      if (existsOutsideCurrentSurface) {
        throw new EmbeddedCdpTargetError("target_not_in_current_surface", "The target does not belong to the current Desktop surface.");
      }
      throw new EmbeddedCdpTargetError(
        requestedChatId ? "target_not_found" : "current_target_unavailable",
        requestedChatId
          ? "The target is closed or unavailable."
          : "The current Desktop surface does not expose a CDP target."
      );
    }
    const currentTarget = this.targetsForSurface(currentSurface).find((target) => target.targetId === targetId);
    if (currentTarget) {
      return currentTarget;
    }
    const existsInAnotherSurface = surfaces
      .filter((surface) => surface.id !== currentSurface.id)
      .some((surface) => this.targetsForSurface(surface).some((target) => target.targetId === targetId));
    if (existsInAnotherSurface) {
      throw new EmbeddedCdpTargetError("target_not_in_current_surface", "The target does not belong to the current Desktop surface.");
    }
    throw new EmbeddedCdpTargetError("target_not_found", "The target is closed or unavailable.");
  }
}

export const __testInternals = {
  createServerFrame,
  stableTargetId: createEmbeddedCdpTargetId,
  targetDescriptor
};
