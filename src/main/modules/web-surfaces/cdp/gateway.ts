import type { EmbeddedCdpContainer, EmbeddedCdpSurfaceTab } from "./containers";
export type { EmbeddedCdpContainer, EmbeddedCdpSurfaceTab } from "./containers";
import { targetDescriptor, targetInfoDescriptor } from "./surface-descriptors";
import { createWebSurfaceId, type WebContainer } from "../../../../shared/web-surface";
import { executeClick } from "./click";
import { assertPageAutomationNotHeld, holdPageAutomation, withCdpCommandQueue } from "./command-queue";
import type { DesktopClickParams } from "../../../../shared/desktop-click";
import { validateDesktopCdpParams, DesktopCdpParamsError } from "./params";
import { requireSiteControlScope, type SiteControlScope, type WorkPanelContainerContent } from "./site-scope";
import {
  WORK_PANEL_HTML_FILE_CAPABILITIES,
  WORK_PANEL_HTML_FILE_CDP_METHODS,
  WORK_PANEL_WEB_CAPABILITIES,
} from "../../../../shared/work-panel-surface";
import { withSiteCdpFocus } from "./site-focus";
import { SurfaceObservationRegistry } from "./observation";
import type { SurfaceObserveParams, SurfaceClickParams, SurfaceInteractParams, SurfaceScrollParams } from "./observation-params";
import { WorkPanelPageAutomation } from "./page-automation";
import { executePageAutomationCommand, PAGE_AUTOMATION_METHODS } from "./page-automation-commands";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { IpcMain, WebContents } from "electron";
import {
  EMBEDDED_CDP_GATEWAY_HOST,
  EMBEDDED_CDP_GATEWAY_PORT,
  DESKTOP_CDP_HOST_METHODS,
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
  /** Classifies a WorkPanel container; without it only HTTP(S) pages are controllable. */
  classifyWorkPanelContainer?: (surface: EmbeddedCdpContainer) => WorkPanelContainerContent | null;
  version?: string;
  commandTimeoutMs?: number;
  logger?: Pick<Console, "debug" | "warn">;
  dialogIpc?: Pick<IpcMain, "on">;
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

const hostCommands = new WeakSet<EmbeddedCdpCommandRequest>();
/** Main-only, single-use acknowledgement marker; JSON/source fields cannot issue it. */
export function authorizeDesktopHostCdpCommand(request: EmbeddedCdpCommandRequest): EmbeddedCdpCommandRequest {
  if (!DESKTOP_CDP_HOST_METHODS.some(method => method === request.method)) throw new EmbeddedCdpCapabilityError("This is not a host acknowledgement.");
  hostCommands.add(request);
  return request;
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PROTOCOL_VERSION = "1.3";
// These read or resolve a pending native modal; every other page command waits until it is handled.
const modalFreeMethods = new Set(["Surface.observe", "Surface.handleDialog", "Surface.uploadFiles", "Surface.getDownloads", "Surface.readDownload", "Surface.releaseDownload"]);
const DEFAULT_CDP_TIMEOUT_MS = 15_000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export class EmbeddedCdpInvalidArgsError extends Error {
  readonly code = "invalid_args";
}

export class EmbeddedCdpCapabilityError extends Error {
  readonly code = "capability_denied";
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

const VIEWPORT_MIN_PX = 120;
const VIEWPORT_MAX_PX = 8192;

/**
 * Emulates a device viewport on the page's own guest without a debugger
 * session, so the override survives individual commands. `reset: true`
 * restores the panel size. The page stays the same surface.
 */
export function setWebContentsViewport(contents: Pick<WebContents, "enableDeviceEmulation" | "disableDeviceEmulation">, params: Record<string, unknown>) {
  const keys = Object.keys(params);
  if (params.reset === true) {
    if (keys.length !== 1) throw new EmbeddedCdpInvalidArgsError("Surface.setViewport with reset accepts no other params.");
    contents.disableDeviceEmulation();
    return { reset: true };
  }
  if (keys.some((key) => !["width", "height", "deviceScaleFactor", "mobile"].includes(key))) {
    throw new EmbeddedCdpInvalidArgsError("Surface.setViewport accepts width, height, deviceScaleFactor and mobile, or reset: true alone.");
  }
  const size = (value: unknown) => Number.isInteger(value) && (value as number) >= VIEWPORT_MIN_PX && (value as number) <= VIEWPORT_MAX_PX;
  if (!size(params.width) || !size(params.height)) {
    throw new EmbeddedCdpInvalidArgsError(`Surface.setViewport width and height must be integers from ${VIEWPORT_MIN_PX} to ${VIEWPORT_MAX_PX}.`);
  }
  const deviceScaleFactor = params.deviceScaleFactor ?? 1;
  if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.5 || deviceScaleFactor > 4) {
    throw new EmbeddedCdpInvalidArgsError("Surface.setViewport deviceScaleFactor must be a number from 0.5 to 4.");
  }
  const mobile = params.mobile === true;
  const width = params.width as number;
  const height = params.height as number;
  contents.enableDeviceEmulation({
    screenPosition: mobile ? "mobile" : "desktop",
    screenSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor,
    viewSize: { width, height },
    scale: 1,
  });
  return { width, height, deviceScaleFactor, mobile };
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
  private readonly pageAutomation: WorkPanelPageAutomation;
  private readonly observations = new SurfaceObservationRegistry((contents) => this.pageAutomation.modalState(contents));

  constructor(private readonly options: EmbeddedCdpGatewayOptions) {
    this.pageAutomation = new WorkPanelPageAutomation(options.logger, options.dialogIpc);
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
    this.observations.dispose();
    this.pageAutomation.dispose();
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
      /** Refuses new CDP/AWCP commands for this page until released, then runs `execute` behind the ones already queued. */
      holdAutomation: <T>(execute: (release: () => void) => Promise<T>) => {
        const release = holdPageAutomation(contents.id);
        return withCdpCommandQueue(contents.id, () => execute(release)).catch((error) => { release(); throw error; });
      },
    };
  }

  async executeCommand(request: EmbeddedCdpCommandRequest, scope?: SiteControlScope, signal?: AbortSignal) {
    if (scope) requireSiteControlScope(scope);
    const method = typeof request.method === "string" ? request.method.trim() : "";
    if (!method) {
      throw new Error("method is required");
    }
    const hostOnly = DESKTOP_CDP_HOST_METHODS.some(candidate => candidate === method);
    if (hostOnly && !hostCommands.delete(request)) throw new EmbeddedCdpCapabilityError("This acknowledgement requires a trusted host request.");
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
            const capabilities = container.surfaceKind === "chat-work-panel" && this.workPanelContent(container) === "html-file"
              ? WORK_PANEL_HTML_FILE_CAPABILITIES : WORK_PANEL_WEB_CAPABILITIES;
            return { ...targetInfoDescriptor(container, tab, id, id === surfaceId), capabilities: [...capabilities] };
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
    if (surface.surfaceKind === "chat-work-panel" && this.workPanelContent(surface) === "html-file" &&
      !WORK_PANEL_HTML_FILE_CDP_METHODS.has(method)) {
      throw new EmbeddedCdpCapabilityError(`${method} is unavailable for an HTML file preview. It cannot navigate, reach the network, use AWCP or saved logins.`);
    }
    assertPageAutomationNotHeld(tab.webContentsId);
    const ownedScope = !scope && surface.surfaceKind === "chat-work-panel" && request.source?.chatId
      ? this.options.acquireWorkPanelScope?.(surface.id, request.source.chatId) : undefined;
    scope ??= ownedScope;
    try {
      if (hostOnly && !scope) throw new EmbeddedCdpCapabilityError("This acknowledgement requires an authorized page scope.");
      return await withCdpCommandQueue(tab.webContentsId, () => withSiteCdpFocus(scope, scope && this.options.controlSiteFocus
      ? (phase) => this.options.controlSiteFocus!(surface, tab, scope, phase) : undefined, async () => {
      const live = await this.resolveCommandTarget(request, scope);
      if (live.tab.webContentsId !== tab.webContentsId || live.surface.targetGeneration !== surface.targetGeneration) {
        throw new EmbeddedCdpTargetError("target_not_found", "The page instance was replaced before execution.");
      }
      // Queue waits can outlive the Run, including host-managed tab operations.
      if (signal?.aborted) throw new Error("canceled");
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
      const result = await this.handleWebContentsCommandOnce(surface, tab, surfaceId, method, params, scope, signal, ownedScope === scope);
      return {
        surfaceId,
        containerId: surface.id,
        result
      };
    })); } finally { if (ownedScope && !this.pageAutomation.retainsScope(ownedScope)) ownedScope.release(); }
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
      if (DESKTOP_CDP_HOST_METHODS.some(candidate => candidate === method)) throw new EmbeddedCdpCapabilityError("Host acknowledgements are not exposed over WebSocket.");
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
      assertPageAutomationNotHeld(target.tab.webContentsId);
      const result = await withCdpCommandQueue(target.tab.webContentsId, () => method === "Input.click" || ["Surface.observe", "Surface.click", "Surface.interact", "Surface.scroll"].includes(method)
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
    if (method === "Surface.setViewport") {
      const result = setWebContentsViewport(contents, params);
      this.observations.invalidate(contents);
      return result;
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
    signal?: AbortSignal,
    ownsScope = false
  ) {
    const contents = await this.ensureWebContents(surface, tab);
    if (!contents || contents.isDestroyed()) {
      throw new Error("Embedded webContents target is unavailable.");
    }
    if (signal?.aborted) throw new Error("canceled");
    scope?.validateTab(tab);
    if (scope && (method.startsWith("Input.") || method === "Surface.click" || method === "Surface.interact" || method === "Surface.scroll")) {
      await this.options.controlSiteFocus?.(surface, tab, scope, "input");
      scope.validateTab(tab);
      if (signal?.aborted) throw new Error("canceled");
    }
    // WorkPanel guests keep a modal-aware debugger session while the agent operates them.
    const automation = surface.surfaceKind === "chat-work-panel" ? this.pageAutomation : undefined;
    if (automation) {
      await automation.prepare(contents);
      const pending = modalFreeMethods.has(method) ? undefined : automation.pendingModal(contents);
      if (pending) throw pending;
    } else if (PAGE_AUTOMATION_METHODS.has(method)) {
      throw Object.assign(new Error("Dialogs, uploads and downloads are available for WorkPanel and Chrome pages."), { code: "capability_unavailable" });
    }
    if (method === "Page.bringToFront") {
      await this.options.activateTarget?.(surface, tab, scope);
      return {};
    }
    if (method === "Page.reload") {
      return this.reloadWebContents(surface, surfaceId, contents, params);
    }
    if (method === "Surface.setViewport") {
      const result = setWebContentsViewport(contents, params);
      this.observations.invalidate(contents);
      return result;
    }
    const debuggerRef = contents.debugger;
    const ownsAttach = !debuggerRef.isAttached();
    if (ownsAttach) {
      debuggerRef.attach(DEFAULT_PROTOCOL_VERSION);
    }
    const emulateFocus = Boolean(scope) && (method.startsWith("Input.") || method === "Surface.click" || method === "Surface.interact" || method === "Surface.scroll");
    let releaseFocus: (() => Promise<void>) | undefined;
    const input = (emulateFocus || method === "Surface.uploadFiles") && automation && scope ? automation.beginInput(contents, scope, tab, signal, ownsScope) : undefined;
    const debugContext = { ...this.buildCommandDebugContext(surface, surfaceId, contents), ...(input ? { trackCommand: input.track } : {}) };
    try {
      if (emulateFocus) {
        // Chromium ignores input in an unfocused guest. Emulation does not focus the host window.
        const setFocus = (enabled: boolean) => sendDesktopCdpCommand(debuggerRef, "Emulation.setFocusEmulationEnabled", { enabled }, debugContext);
        if (automation) releaseFocus = await automation.acquireFocus(contents, setFocus);
        else await setFocus(true);
        scope?.validateTab(tab);
      }
      if (method === "Surface.goBack") {
        const history = await sendDesktopCdpCommand(debuggerRef, "Page.getNavigationHistory", {}, debugContext) as { currentIndex: number; entries: Array<{ id: number }> };
        const previous = history.entries[history.currentIndex - 1];
        if (!previous) throw new EmbeddedCdpInvalidArgsError("The page has no previous history entry.");
        return await sendDesktopCdpCommand(debuggerRef, "Page.navigateToHistoryEntry", { entryId: previous.id }, debugContext);
      }
      const validate = async () => {
        scope?.validateTab(tab);
        const current = await this.resolveCommandTarget({ method, surfaceId, source: { chatId: surface.ownerChatId } }, scope);
        if (current.tab.webContentsId !== contents.id || current.surface.targetGeneration !== surface.targetGeneration) throw new Error("target_replaced");
      };
      const send = async (name: string, args: Record<string, unknown>, timeoutMs: number) => {
        if (automation && params.captureDownload === true && (method === "Surface.click" || method === "Input.click")
          && name === "Input.dispatchMouseEvent" && args.type === "mousePressed") {
          await validate();
          if (signal?.aborted) throw new Error("canceled");
          automation.armDownload(contents, signal);
        }
        const work = sendDesktopCdpCommand(debuggerRef, name, args, { ...debugContext, timeoutMs });
        return automation ? automation.raceModal(contents, work) : work;
      };
      // Typed actions report the state they produced, as the Chrome provider does; the action outcome stays separate.
      const withObservation = async <T extends object>(result: T, observe: SurfaceObserveParams = {}) => ({
        ...result, ...await this.observations.observeAfterAction(surfaceId, observe, contents, send, validate, signal),
      });
      if (method === "Surface.observe") return await this.observations.observe(surfaceId, params as SurfaceObserveParams, contents, send, validate, signal);
      if (automation && PAGE_AUTOMATION_METHODS.has(method)) {
        try {
          const { result, observe } = await executePageAutomationCommand({ method, params, surfaceId, contents, automation, observations: this.observations, send, validate, signal });
          return observe ? await withObservation(result) : result;
        } catch (error) {
          if (method !== "Surface.uploadFiles" || (error as { code?: unknown })?.code !== "dialog_pending") throw error;
          return await withObservation({ status: "failed", action: "upload", error: "dialog_pending", outcome: "unknown" });
        }
      }
      if (method === "Surface.click") return await withObservation(await this.observations.click(surfaceId, params as SurfaceClickParams, contents, send, validate, signal));
      if (method === "Surface.interact" || method === "Surface.scroll") {
        const interact = method === "Surface.scroll" ? { ...(params as SurfaceScrollParams), action: "scroll" as const } : params as SurfaceInteractParams;
        let result: object;
        try {
          result = await this.observations.interact(surfaceId, interact, contents, send, validate, signal,
            (phase, evidence) => (debugContext.logger ?? console).debug?.("[desktop-cdp] semantic-input-focus", { surfaceId, phase, ...evidence }));
        } catch (error) {
          // The action opened a native modal: its effect is unknown and it must never be replayed.
          const code = (error as { code?: unknown })?.code;
          if (!automation || (code !== "dialog_pending" && code !== "file_chooser_pending")) throw error;
          result = { status: "failed", action: interact.action, error: code, outcome: "unknown" };
        }
        return await withObservation(result, interact.action === "scroll" ? { viewportOnly: true } : {});
      }
      if (method === "Input.click") {
        const result = await executeClick(params as DesktopClickParams, contents, send, async () => {
          scope?.validateTab(tab);
          const current = await this.resolveCommandTarget({ method, surfaceId, source: { chatId: surface.ownerChatId } }, scope);
          if (current.tab.webContentsId !== contents.id) throw new Error("target_replaced");
        }, signal);
        return result.action.outcome === "not_started" ? result : await withObservation(result);
      }
      // A beforeunload dialog can block navigation; release the caller so it can be handled.
      const work = sendDesktopCdpCommand(debuggerRef, method, params, debugContext);
      return await (automation ? automation.raceModal(contents, work) : work);
    } finally {
      try {
        if (releaseFocus) await releaseFocus();
        else if (emulateFocus && !automation && debuggerRef.isAttached() && !contents.isDestroyed()) {
          await sendDesktopCdpCommand(debuggerRef, "Emulation.setFocusEmulationEnabled", { enabled: false }, debugContext);
        }
      } finally {
        input?.end();
        if (ownsAttach && debuggerRef.isAttached()) {
          try { this.observations.detachOwnedDebugger(contents, () => debuggerRef.detach()); } catch { /* Target is closing. */ }
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
      container.ownerChatId === chatId && this.workPanelContent(container) !== null
    ));
  }

  private workPanelContent(container: EmbeddedCdpContainer): WorkPanelContainerContent | null {
    if (this.options.classifyWorkPanelContainer) return this.options.classifyWorkPanelContainer(container);
    return container.surfaceRole === "workpanel-web" && /^https?:/u.test(container.url) ? "web" : null;
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
          this.workPanelContent(matchingTarget.surface) !== null) {
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
