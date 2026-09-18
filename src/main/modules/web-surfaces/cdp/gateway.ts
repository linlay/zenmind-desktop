import type { EmbeddedCdpContainer, EmbeddedCdpSurfaceTab } from "./containers";
export type { EmbeddedCdpContainer, EmbeddedCdpSurfaceTab } from "./containers";
import { targetDescriptor, targetInfoDescriptor } from "./surface-descriptors";
import { createWebSurfaceId, type WebContainer } from "../../../../shared/web-surface";
import { executeClick } from "./click";
import { withCdpCommandQueue } from "./command-queue";
import type { DesktopClickParams } from "../../../../shared/desktop-click";
import { validateDesktopCdpParams, DesktopCdpParamsError } from "./params";
import { requireSiteControlScope, type SiteControlScope } from "./site-scope";
import { withSiteCdpFocus } from "./site-focus";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { WebContents } from "electron";
import {
  EMBEDDED_CDP_GATEWAY_HOST,
  EMBEDDED_CDP_GATEWAY_PORT
} from "../../../../shared/embedded-cdp";
import { PRODUCT_NAME } from "../../../../shared/brand";

import {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  isDesktopCdpTimeoutError,
  readDesktopCdpErrorDetails,
  sendDesktopCdpCommand
} from "./debugger";

type EmbeddedCdpGatewayOptions = {
  host?: string;
  port?: number;
  getSurfaces: () => EmbeddedCdpContainer[] | Promise<EmbeddedCdpContainer[]>;
  resolveWebContents: (surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab) => WebContents | null | Promise<WebContents | null>;
  activateTarget?: (surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab, scope?: SiteControlScope) => Promise<void>;
  acquireWorkPanelScope?: (containerId: string, chatId: string) => SiteControlScope;
  openPage?: (container: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab, url: string, scope?: SiteControlScope) => Promise<unknown>;
  closeTarget?: (surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab, scope?: SiteControlScope) => Promise<unknown>;
  controlSiteFocus?: (surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab, scope: SiteControlScope, phase: "capture" | "restore" | "input") => Promise<unknown>;
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
  surfaceId: string;
  webContentsId: number;
  debuggerRef: WebContents["debugger"];
  ownsAttach: boolean;
  messageListener: (event: unknown, method: string, params?: unknown) => void;
};

export type EmbeddedCdpCommandRequest = {
  method: string;
  params?: Record<string, unknown>;
  surfaceId?: string;
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

export function createEmbeddedWebSurfaceId(surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab) {
  return createWebSurfaceId(surface.id, surface.targetGeneration || String(tab.webContentsId), tab.tabId);
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

function readWebContentsString(contents: WebContents, key: "getTitle" | "getURL") {
  try {
    const reader = (contents as unknown as Record<string, unknown>)[key];
    return typeof reader === "function" ? String(reader.call(contents) || "") : "";
  } catch {
    return "";
  }
}

function surfaceTabs(surface: EmbeddedCdpContainer): EmbeddedCdpSurfaceTab[] {
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

function activeSurfaceTab(surface: EmbeddedCdpContainer) {
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
      targetDescriptor(surface, tab, createEmbeddedWebSurfaceId(surface, tab), origins)
    );
  }

  /** Main-only resolver for capabilities that consume bytes without exposing them to tools. */
  async resolveWebSurface(request: EmbeddedCdpCommandRequest, scope?: SiteControlScope) {
    if (scope) requireSiteControlScope(scope);
    const target = await this.resolveCommandTarget(request, scope);
    const contents = await this.options.resolveWebContents(target.surface, target.tab);
    if (!contents || contents.isDestroyed()) throw new EmbeddedCdpTargetError("target_not_found", "The page is unavailable.");
    return {
      surfaceId: target.surfaceId, containerId: target.surface.id, surfaceKind: target.surface.surfaceKind, contents,
      validate: async () => {
        const live = await this.resolveCommandTarget(request, scope);
        if (contents.isDestroyed() || live.tab.webContentsId !== contents.id || live.surface.targetGeneration !== target.surface.targetGeneration) {
          throw new EmbeddedCdpTargetError("target_not_found", "The page was closed or replaced.");
        }
      },
    };
  }

  async executeCommand(request: EmbeddedCdpCommandRequest, scope?: SiteControlScope, signal?: AbortSignal) {
    if (scope) requireSiteControlScope(scope);
    const method = typeof request.method === "string" ? request.method.trim() : "";
    if (!method) {
      throw new Error("method is required");
    }
    const params = request.params ?? {};
    if (method === "Surface.list" || method === "Surface.getCurrent") {
      validateDesktopCdpParams(method, request.params);
      if (Object.keys(params).length > 0) {
        throw new EmbeddedCdpInvalidArgsError(`${method} does not accept params.`);
      }
      const surface = scope ? scope.readContainer() : request.source?.chatId ? null : this.resolveCurrentSurface(await this.listValidSurfaces());
      const visible = scope ? [scope.readContainer()] : await this.authorizedContainers(request);

      const currentTab = surface ? activeSurfaceTab(surface) : null;
      const surfaceId = surface && currentTab ? createEmbeddedWebSurfaceId(surface, currentTab) : null;
      const targetInfo = surface && currentTab && surfaceId
        ? targetInfoDescriptor(surface, currentTab, surfaceId, true)
        : null;
      if (method === "Surface.getCurrent") {
        return {
          ...(surfaceId && surface ? { surfaceId, containerId: surface.id } : {}),
          result: {
            surface: targetInfo,
            currentSurfaceId: surfaceId,
            currentContainerId: surface?.id ?? null,
            activeTabId: currentTab?.tabId ?? null
          }
        };
      }
      return {
        ...(surfaceId && surface ? { surfaceId, containerId: surface.id } : {}),
        result: {
          containers: visible.map((container): WebContainer => ({
            containerId: container.id, label: container.label, kind: container.surfaceKind, active: Boolean(container.active),
            surfaceIds: surfaceTabs(container).map((tab) => createEmbeddedWebSurfaceId(container, tab)),
          })),
          surfaces: visible.flatMap((container) => surfaceTabs(container).map((tab) => {
            const id = createEmbeddedWebSurfaceId(container, tab);
            return targetInfoDescriptor(container, tab, id, id === surfaceId);
          })),
          currentSurface: targetInfo,
          currentSurfaceId: surfaceId,
          currentContainerId: surface?.id ?? null,
          activeTabId: currentTab?.tabId ?? null
        }
      };
    }
    if (method === "Page.navigate") {
      let url: URL;
      try { url = new URL(String(params.url)); } catch { throw new EmbeddedCdpInvalidArgsError("Page.navigate requires an HTTP(S) URL."); }
      if (!/^https?:$/u.test(url.protocol) || url.username || url.password) throw new EmbeddedCdpInvalidArgsError("Page.navigate requires an HTTP(S) URL without credentials.");
    }
    const { surface, tab, surfaceId } = await this.resolveCommandTarget(request, scope);
    validateDesktopCdpParams(method, request.params);
    const ownedScope = !scope && surface.surfaceKind === "chat-work-panel" && request.source?.chatId
      ? this.options.acquireWorkPanelScope?.(surface.id, request.source.chatId) : undefined;
    scope ??= ownedScope;
    try { return await withCdpCommandQueue(tab.webContentsId, () => withSiteCdpFocus(scope, scope && this.options.controlSiteFocus
      ? (phase) => this.options.controlSiteFocus!(surface, tab, scope, phase) : undefined, async () => {
      const live = await this.resolveCommandTarget(request, scope);
      if (live.tab.webContentsId !== tab.webContentsId || live.surface.targetGeneration !== surface.targetGeneration) {
        throw new EmbeddedCdpTargetError("target_not_found", "The page instance was replaced before execution.");
      }
      if (method === "Surface.open") {
        if (typeof params.url !== "string" || !/^https?:\/\//u.test(params.url) || !this.options.openPage) {
          throw new EmbeddedCdpInvalidArgsError("Surface.open requires an HTTP(S) URL and a supported container.");
        }
        const url = new URL(params.url);
        if (url.username || url.password) throw new EmbeddedCdpInvalidArgsError("URL credentials are not allowed.");
        return { result: await this.options.openPage(surface, tab, url.href, scope) };
      }
      if (method === "Surface.getState") {
        return { surfaceId, result: { surface: targetInfoDescriptor(surface, tab, surfaceId, Boolean(surface.active && surface.activeTabId === tab.tabId)) } };
      }
      if (method === "Surface.close") {
        if (Object.keys(params).length > 0) {
          throw new EmbeddedCdpInvalidArgsError("Surface.close does not accept params after surfaceId resolution.");
        }
        if (!this.options.closeTarget) {
          throw new Error("Surface.close is unavailable.");
        }
        await this.options.closeTarget(surface, tab, scope);
        return {
          surfaceId,
          containerId: surface.id,
          result: { success: true }
        };
      }
      if (signal?.aborted) throw new Error("canceled");
      const result = await this.handleWebContentsCommandOnce(surface, tab, surfaceId, method, params, scope, signal);
      return {
        surfaceId,
        containerId: surface.id,
        result
      };
    })); } finally { ownedScope?.release(); }
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
      const surfaceId = decodeURIComponent(url.pathname.slice("/json/activate/".length));
      let target: { surface: EmbeddedCdpContainer; tab: EmbeddedCdpSurfaceTab; surfaceId: string };
      try {
        target = await this.resolveCommandTarget({ method: "Page.bringToFront", surfaceId });
      } catch (error) {
        const code = error instanceof EmbeddedCdpTargetError ? error.code : "target_not_found";
        responseJSON(res, 404, { error: code });
        return;
      }
      await this.options.activateTarget?.(target.surface, target.tab);
      const origins = parseTargetUrl(req, this.host, this.port);
      responseJSON(res, 200, targetDescriptor(target.surface, target.tab, target.surfaceId, origins));
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
    const surfaceId = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
    const target = await this.resolveCurrentTargetById(surfaceId);
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
        void this.handleTextMessage(connection, surfaceId, text);
      },
      () => this.releaseConnection(connection)
    );
  }

  private async handleTextMessage(connection: CdpWebSocketConnection, surfaceId: string, text: string) {
    let command: CdpCommand;
    try {
      command = JSON.parse(text) as CdpCommand;
    } catch {
      connection.sendJSON(cdpError(undefined, -32700, "Parse error"));
      return;
    }
    const id = command.id;
    const rawMethod = typeof command.method === "string" ? command.method : "";
    const method = rawMethod === "Target.closeTarget" ? "Surface.close" : rawMethod;
    if (rawMethod === "Target.closeTarget" && command.params && "targetId" in command.params) {
      command.params = { ...command.params, surfaceId: command.params.targetId };
      delete command.params.targetId;
    }
    if (!method) {
      connection.sendJSON(cdpError(id, -32600, "Invalid request: method is required."));
      return;
    }
    try {
      validateDesktopCdpParams(method, command.params);
      if (method === "Surface.close") {
        const paramsSurfaceId = typeof command.params?.surfaceId === "string"
          ? command.params.surfaceId.trim()
          : "";
        if (paramsSurfaceId && paramsSurfaceId !== surfaceId) {
          throw new EmbeddedCdpInvalidArgsError("params.surfaceId conflicts with the current WebSocket target.");
        }
        const extraParamKeys = Object.keys(command.params ?? {}).filter((key) => key !== "surfaceId");
        if (extraParamKeys.length > 0) {
          throw new EmbeddedCdpInvalidArgsError("Target.closeTarget only accepts params.surfaceId.");
        }
      }
      const target = await this.resolveCommandTarget({ method, surfaceId });
      const result = await withCdpCommandQueue(target.tab.webContentsId, () => method === "Input.click"
        ? this.handleWebContentsCommandOnce(target.surface, target.tab, surfaceId, method, command.params ?? {})
        : this.handleWebContentsCommand(connection, target, method, command.params ?? {}));
      connection.sendJSON({ id, result });
      if (method === "Surface.close") {
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
      if (error instanceof DesktopCdpParamsError) {
        connection.sendJSON(cdpError(id, -32602, error.message, { code: error.code, details: error.details }));
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
    target: { surface: EmbeddedCdpContainer; tab: EmbeddedCdpSurfaceTab; surfaceId: string },
    method: string,
    params: Record<string, unknown>
  ) {
    if (method === "Surface.close") {
      if (!this.options.closeTarget) {
        throw new Error("Surface.close is unavailable.");
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
    if (method === "Page.reload") {
      return this.reloadWebContents(target.surface, target.surfaceId, contents, params);
    }
    const session = this.ensureDebuggerSession(connection, target.surfaceId, contents);
    return sendDesktopCdpCommand(session.debuggerRef, method, params, this.buildCommandDebugContext(target.surface, target.surfaceId, contents));
  }

  private async handleWebContentsCommandOnce(
    surface: EmbeddedCdpContainer,
    tab: EmbeddedCdpSurfaceTab,
    surfaceId: string,
    method: string,
    params: Record<string, unknown>,
    scope?: SiteControlScope,
    signal?: AbortSignal
  ) {
    const contents = await this.ensureWebContents(surface, tab);
    if (!contents || contents.isDestroyed()) {
      throw new Error("Embedded webContents target is unavailable.");
    }
    scope?.validateTab(tab);
    if (scope && method.startsWith("Input.")) {
      await this.options.controlSiteFocus?.(surface, tab, scope, "input");
      scope.validateTab(tab);
    }
    if (method === "Page.bringToFront") {
      await this.options.activateTarget?.(surface, tab, scope);
      return {};
    }
    if (method === "Page.reload") {
      return this.reloadWebContents(surface, surfaceId, contents, params);
    }
    const debuggerRef = contents.debugger;
    const ownsAttach = !debuggerRef.isAttached();
    if (ownsAttach) {
      debuggerRef.attach(DEFAULT_PROTOCOL_VERSION);
    }
    const emulateFocus = Boolean(scope);
    const debugContext = this.buildCommandDebugContext(surface, surfaceId, contents);
    try {
      if (emulateFocus) {
        // Chromium ignores input in an unfocused guest. Emulation does not focus the host window.
        await sendDesktopCdpCommand(debuggerRef, "Emulation.setFocusEmulationEnabled", { enabled: true }, debugContext);
        scope?.validateTab(tab);
      }
      if (method === "Surface.goBack") {
        const history = await sendDesktopCdpCommand(debuggerRef, "Page.getNavigationHistory", {}, debugContext) as { currentIndex: number; entries: Array<{ id: number }> };
        const previous = history.entries[history.currentIndex - 1];
        if (!previous) throw new EmbeddedCdpInvalidArgsError("The page has no previous history entry.");
        return await sendDesktopCdpCommand(debuggerRef, "Page.navigateToHistoryEntry", { entryId: previous.id }, debugContext);
      }
      if (method === "Input.click") {
        return await executeClick(params as DesktopClickParams, contents,
          (name, args, timeoutMs) => sendDesktopCdpCommand(debuggerRef, name, args, { ...debugContext, timeoutMs }),
          async () => {
            scope?.validateTab(tab);
            const current = await this.resolveCommandTarget({ method, surfaceId, source: { chatId: surface.ownerChatId } }, scope);
            if (current.tab.webContentsId !== contents.id) throw new Error("target_replaced");
          }, signal);
      }
      return await sendDesktopCdpCommand(debuggerRef, method, params, debugContext);
    } finally {
      try {
        if (emulateFocus && debuggerRef.isAttached() && !contents.isDestroyed()) {
          await sendDesktopCdpCommand(debuggerRef, "Emulation.setFocusEmulationEnabled", { enabled: false }, debugContext);
        }
      } finally {
        if (ownsAttach && debuggerRef.isAttached()) {
          try { debuggerRef.detach(); } catch { /* Target is closing. */ }
        }
      }
    }
  }

  private buildCommandDebugContext(
    surface: EmbeddedCdpContainer,
    surfaceId: string,
    contents: WebContents
  ) {
    return {
      surfaceId,
      containerId: surface.id,
      webContentsId: contents.id,
      url: readWebContentsString(contents, "getURL") || surface.currentUrl || surface.url,
      title: readWebContentsString(contents, "getTitle") || surface.title || surface.label,
      timeoutMs: this.options.commandTimeoutMs,
      logger: this.options.logger
    };
  }

  private reloadWebContents(
    surface: EmbeddedCdpContainer,
    surfaceId: string,
    contents: WebContents,
    params: Record<string, unknown>
  ) {
    const extraParamKeys = Object.keys(params).filter((key) => key !== "ignoreCache");
    if (extraParamKeys.length > 0) {
      throw new EmbeddedCdpInvalidArgsError("Page.reload only accepts params.ignoreCache.");
    }
    const hasIgnoreCache = Object.prototype.hasOwnProperty.call(params, "ignoreCache");
    if (hasIgnoreCache && typeof params.ignoreCache !== "boolean") {
      throw new EmbeddedCdpInvalidArgsError("Page.reload params.ignoreCache must be a boolean.");
    }
    const ignoreCache = params.ignoreCache === true;
    const logger = this.options.logger ?? console;
    const details = {
      method: "Page.reload",
      surfaceId,
      containerId: surface.id,
      webContentsId: contents.id,
      mode: ignoreCache ? "reloadIgnoringCache" : "reload"
    };
    logger.debug?.("[desktop-cdp] host-command start", details);
    try {
      if (ignoreCache) {
        contents.reloadIgnoringCache();
      } else {
        contents.reload();
      }
      logger.debug?.("[desktop-cdp] host-command success", details);
      return {};
    } catch (error) {
      logger.warn?.("[desktop-cdp] host-command failed", {
        ...details,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async ensureWebContents(surface: EmbeddedCdpContainer, tab: EmbeddedCdpSurfaceTab) {
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
    surfaceId: string,
    contents: WebContents
  ): CdpConnectionSession {
    const current = this.sessions.get(connection);
    if (current && current.surfaceId === surfaceId && current.webContentsId === contents.id) {
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
      surfaceId,
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

  private async authorizedContainers(request: EmbeddedCdpCommandRequest) {
    const containers = await this.listValidSurfaces();
    const current = this.resolveCurrentSurface(containers);
    const chatId = request.source?.chatId?.trim();
    return containers.filter((container) => (!chatId && container === current) || (
      Boolean(chatId) && container.surfaceKind === "chat-work-panel" &&
      container.surfaceRole === "workpanel-web" && container.ownerChatId === chatId &&
      /^https?:/u.test(container.url)
    ));
  }

  private resolveCurrentSurface(surfaces: EmbeddedCdpContainer[]) {
    const currentSurfaces = surfaces.filter((surface) => (
      surface.active &&
      surface.surfaceLevel !== "child" &&
      surface.surfaceKind !== "chat-work-panel"
    ));
    return currentSurfaces.length === 1 ? currentSurfaces[0] : null;
  }

  private targetsForSurface(surface: EmbeddedCdpContainer) {
    return surfaceTabs(surface).map((tab) => ({
      surface,
      tab,
      surfaceId: createEmbeddedWebSurfaceId(surface, tab)
    }));
  }

  private async resolveCurrentTargetById(surfaceId: string) {
    const surfaces = await this.listValidSurfaces();
    const currentSurface = this.resolveCurrentSurface(surfaces);
    if (!currentSurface) {
      return null;
    }
    return this.targetsForSurface(currentSurface).find((target) => target.surfaceId === surfaceId) ?? null;
  }

  private async resolveCommandTarget(request: EmbeddedCdpCommandRequest, scope?: SiteControlScope) {
    const surfaceId = typeof request.surfaceId === "string" ? request.surfaceId.trim() : "";
    if (!surfaceId) {
      throw new EmbeddedCdpTargetError("target_required", "surfaceId is required for this CDP method.");
    }
    if (scope) {
      const surface = scope.readContainer();
      const target = this.targetsForSurface(surface).find((candidate) => candidate.surfaceId === surfaceId);
      if (!target) throw new EmbeddedCdpTargetError("target_not_in_current_surface", "The target does not belong to the Run application instance.");
      return target;
    }
    const surfaces = await this.listValidSurfaces();
    const currentSurface = this.resolveCurrentSurface(surfaces);
    const requestedChatId = typeof request.source?.chatId === "string" ? request.source.chatId.trim() : "";
    const matchingTarget = surfaces
      .flatMap((surface) => this.targetsForSurface(surface))
      .find((target) => target.surfaceId === surfaceId) ?? null;
    if (matchingTarget?.surface.surfaceKind === "chat-work-panel") {
      if (requestedChatId && matchingTarget.surface.ownerChatId === requestedChatId &&
          matchingTarget.surface.surfaceRole === "workpanel-web" && /^https?:/u.test(matchingTarget.surface.url)) {
        return matchingTarget;
      }
      if (requestedChatId) {
        throw new EmbeddedCdpTargetError(
          "target_not_owned_by_chat",
          "The Work Panel target does not belong to the calling chat."
        );
      }
    }
    if (requestedChatId && !matchingTarget) throw new EmbeddedCdpTargetError("target_not_found", "The page is closed or unavailable.");
    if (requestedChatId) {
      throw new EmbeddedCdpTargetError("target_not_owned_by_chat", "The page is outside this Chat's authorized WorkPanel. A Website/WebApp Run requires its own page grant.");
    }
    if (!currentSurface) {
      const existsOutsideCurrentSurface = surfaces
        .some((surface) => this.targetsForSurface(surface).some((target) => target.surfaceId === surfaceId));
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
    const currentTarget = this.targetsForSurface(currentSurface).find((target) => target.surfaceId === surfaceId);
    if (currentTarget) {
      return currentTarget;
    }
    const existsInAnotherSurface = surfaces
      .filter((surface) => surface.id !== currentSurface.id)
      .some((surface) => this.targetsForSurface(surface).some((target) => target.surfaceId === surfaceId));
    if (existsInAnotherSurface) {
      throw new EmbeddedCdpTargetError("target_not_in_current_surface", "The target does not belong to the current Desktop surface.");
    }
    throw new EmbeddedCdpTargetError("target_not_found", "The target is closed or unavailable.");
  }
}

export const __testInternals = {
  createServerFrame,
  stableSurfaceId: createEmbeddedWebSurfaceId,
  targetDescriptor
};
