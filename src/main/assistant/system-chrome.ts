import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { App } from "electron";

type BrowserSurface = {
  id: string;
  label: string;
  url: string;
  active: boolean;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
};

type BrowserToolResult = {
  ok: boolean;
  action: string;
  target: string;
  url?: string;
  title?: string;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
};

type DebuggerLike = {
  isAttached: () => boolean;
  attach: () => void;
  detach: () => void;
  sendCommand: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>;
};

type WebContentsLike = {
  readonly debugger: DebuggerLike;
  isDestroyed: () => boolean;
  focus: () => void;
  getURL: () => string;
  getTitle: () => string;
};

type CdpTargetDescriptor = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type CdpSocketMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type SocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

type SocketConstructor = {
  new(url: string): SocketLike;
};

const SOCKET_OPEN_STATE = 1;
const CHROME_CDP_COMMAND_TIMEOUT_MS = 20000;
const CHROME_CDP_READY_TIMEOUT_MS = 8000;
const SYSTEM_CHROME_SURFACE_ID = "system-chrome";
const SYSTEM_CHROME_SURFACE_LABEL = "Google Chrome";
const DEFAULT_SYSTEM_CHROME_URL = "https://www.google.com/";
const execFileAsync = promisify(execFile);

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("无法分配 Chrome CDP 端口。"));
      });
    });
  });
}

function existingFile(candidate: string | undefined) {
  if (!candidate) {
    return "";
  }
  return fs.existsSync(candidate) ? candidate : "";
}

function findChromeExecutable(app: App) {
  const platform = process.platform;
  const home = app.getPath("home");
  if (platform === "darwin") {
    return [
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ].map(existingFile).find(Boolean) || "";
  }

  if (platform === "win32") {
    return [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
    ].map(existingFile).find(Boolean) || "";
  }

  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    ].map(existingFile).find(Boolean) || "";
  }

  return "";
}

function normalizeChromeUrlTarget(rawTarget: string) {
  const target = rawTarget.trim();
  const lower = target.toLowerCase();
  if (!target) {
    return "";
  }
  if (lower === "chrome" || lower === "google chrome" || lower === "谷歌浏览器" || lower === SYSTEM_CHROME_SURFACE_ID) {
    return DEFAULT_SYSTEM_CHROME_URL;
  }
  if (lower === "google" || target === "谷歌") {
    return "https://www.google.com/";
  }
  if (lower === "bing" || target === "必应") {
    return "https://www.bing.com/";
  }
  if (target === "百度") {
    return "https://www.baidu.com/";
  }

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(target) ? target : `https://${target}`);
    if (!/^https?:$/iu.test(parsed.protocol)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function getControlledChromeUserDataDir(app: App) {
  return path.join(app.getPath("userData"), "controlled-system-chrome");
}

function normalizeProcessPathForCompare(value: string, platform = process.platform) {
  const normalized = value.trim().replace(/^["']|["']$/gu, "");
  return platform === "win32"
    ? normalized.replace(/\//gu, "\\").toLowerCase()
    : normalized;
}

function extractChromeCommandArg(command: string, argName: string) {
  const marker = `--${argName}=`;
  const index = command.indexOf(marker);
  if (index < 0) {
    return "";
  }
  const rest = command.slice(index + marker.length);
  const quote = rest[0];
  if (quote === "\"" || quote === "'") {
    const end = rest.indexOf(quote, 1);
    return (end >= 0 ? rest.slice(1, end) : rest.slice(1)).trim();
  }
  const nextFlag = rest.search(/\s--[a-z0-9-]+(?:=|\b)/iu);
  return (nextFlag >= 0 ? rest.slice(0, nextFlag) : rest).trim();
}

function findCdpPortInProcessTableForPlatform(processTable: string, userDataDir: string, platform = process.platform) {
  const expectedUserDataDir = normalizeProcessPathForCompare(userDataDir, platform);
  for (const line of processTable.split(/\r?\n/u)) {
    const portValue = extractChromeCommandArg(line, "remote-debugging-port");
    const processUserDataDir = extractChromeCommandArg(line, "user-data-dir");
    const port = Number(portValue);
    if (
      Number.isInteger(port) &&
      port > 0 &&
      port < 65536 &&
      normalizeProcessPathForCompare(processUserDataDir, platform) === expectedUserDataDir
    ) {
      return port;
    }
  }
  return null;
}

function readDevToolsActivePort(userDataDir: string) {
  try {
    const activePortPath = path.join(userDataDir, "DevToolsActivePort");
    const firstLine = fs.readFileSync(activePortPath, "utf8").split(/\r?\n/u)[0]?.trim();
    const port = Number(firstLine);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function readProcessCommandLinesForPlatform(platform = process.platform) {
  if (platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"
    ], { windowsHide: true, maxBuffer: 1024 * 1024 * 4 });
    return stdout;
  }
  if (platform === "darwin" || platform === "linux") {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], { maxBuffer: 1024 * 1024 * 4 });
    return stdout;
  }
  return "";
}

async function isCdpReachable(port: number) {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function discoverExistingCdpPortForUserDataDir(userDataDir: string) {
  const activePort = readDevToolsActivePort(userDataDir);
  if (activePort && await isCdpReachable(activePort)) {
    return activePort;
  }

  try {
    const processTable = await readProcessCommandLinesForPlatform();
    const processPort = findCdpPortInProcessTableForPlatform(processTable, userDataDir);
    if (processPort && await isCdpReachable(processPort)) {
      return processPort;
    }
  } catch {
    // Process discovery is best-effort; launching a fresh controlled Chrome remains the fallback.
  }
  return null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(port: number) {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < CHROME_CDP_READY_TIMEOUT_MS) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "Chrome CDP 未就绪。");
}

function parseSocketPayload(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data ?? "");
}

function cdpErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isTransientCdpContextError(error: unknown) {
  return /Cannot find default execution context|Execution context was destroyed|Cannot find context with specified id|context.*destroyed|target.*(?:closed|navigat)|frame.*(?:detached|navigat)/iu.test(cdpErrorMessage(error));
}

class ChromeCdpDebugger implements DebuggerLike {
  private socket: SocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private nextCommandId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly webSocketDebuggerUrl: string,
    private readonly onEvent?: (message: CdpSocketMessage) => void
  ) {}

  isAttached() {
    return this.socket?.readyState === SOCKET_OPEN_STATE;
  }

  attach() {
    this.connecting ??= this.connect();
  }

  detach() {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Chrome CDP 连接已关闭。"));
    }
    this.pending.clear();
    socket?.close();
  }

  async sendCommand(method: string, commandParams: Record<string, unknown> = {}) {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN_STATE) {
      throw new Error("Chrome CDP 连接不可用。");
    }
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP 命令超时：${method}`));
      }, CHROME_CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    socket.send(JSON.stringify({
      id,
      method,
      params: commandParams
    }));
    return result;
  }

  private async ensureConnected() {
    if (this.socket?.readyState === SOCKET_OPEN_STATE) {
      return;
    }
    this.connecting ??= this.connect();
    await this.connecting;
  }

  private connect() {
    return new Promise<void>((resolve, reject) => {
      const Socket = globalThis.WebSocket as unknown as SocketConstructor | undefined;
      if (!Socket) {
        reject(new Error("当前 Node/Electron 运行时没有 WebSocket，无法连接 Chrome CDP。"));
        return;
      }

      const socket = new Socket(this.webSocketDebuggerUrl);
      this.socket = socket;
      socket.onopen = () => {
        resolve();
      };
      socket.onerror = () => {
        reject(new Error("连接 Chrome CDP 失败。"));
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.connecting = null;
        }
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Chrome CDP 连接已断开。"));
        }
        this.pending.clear();
      };
      socket.onmessage = (event) => {
        let message: CdpSocketMessage | null = null;
        try {
          message = JSON.parse(parseSocketPayload(event.data)) as CdpSocketMessage;
        } catch {
          return;
        }
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) {
            return;
          }
          this.pending.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error) {
            pending.reject(new Error(message.error.message || message.error.data || "Chrome CDP 命令失败。"));
          } else {
            pending.resolve(message.result);
          }
          return;
        }
        this.onEvent?.(message);
      };
    });
  }
}

class SystemChromeWebContents implements WebContentsLike {
  readonly debugger: DebuggerLike;
  private destroyed = false;
  private currentUrl: string;
  private currentTitle: string;

  constructor(
    readonly id: number,
    readonly cdpTargetId: string,
    descriptor: CdpTargetDescriptor
  ) {
    this.currentUrl = descriptor.url || "about:blank";
    this.currentTitle = descriptor.title || SYSTEM_CHROME_SURFACE_LABEL;
    this.debugger = new ChromeCdpDebugger(String(descriptor.webSocketDebuggerUrl || ""), (message) => {
      if (message.method === "Page.frameNavigated") {
        const frame = message.params?.frame;
        if (frame && typeof frame === "object" && "url" in frame) {
          this.currentUrl = String((frame as { url?: unknown }).url || this.currentUrl);
        }
      }
    });
  }

  updateFromDescriptor(descriptor: CdpTargetDescriptor) {
    if (descriptor.url) {
      this.currentUrl = descriptor.url;
    }
    if (descriptor.title) {
      this.currentTitle = descriptor.title;
    }
  }

  isDestroyed() {
    return this.destroyed;
  }

  focus() {
    void this.debugger.sendCommand("Page.bringToFront").catch(() => undefined);
  }

  getURL() {
    return this.currentUrl;
  }

  getTitle() {
    return this.currentTitle;
  }

  async waitForExecutionContext(timeoutMs = 8000) {
    const startedAt = Date.now();
    let lastError: unknown = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const result = await this.debugger.sendCommand("Runtime.evaluate", {
          expression: `(() => ({
            readyState: document.readyState,
            url: location.href,
            title: document.title
          }))()`,
          awaitPromise: true,
          returnByValue: true
        }) as {
          result?: {
            value?: {
              readyState?: string;
              url?: string;
              title?: string;
            };
          };
        };
        const value = result.result?.value;
        const url = String(value?.url || "");
        if (value?.readyState && url && url !== "about:blank") {
          this.currentUrl = url;
          this.currentTitle = String(value.title || this.currentTitle);
          return;
        }
      } catch (error) {
        lastError = error;
        if (!isTransientCdpContextError(error)) {
          throw error;
        }
      }
      await delay(200);
    }
    throw new Error(`page_context_not_ready: ${cdpErrorMessage(lastError) || "系统 Chrome 页面上下文未就绪。"}`);
  }
}

export class SystemChromeController {
  private port: number | null = null;
  private child: ChildProcess | null = null;
  private nextWebContentsId = -100000;
  private readonly targets = new Map<number, SystemChromeWebContents>();
  private readonly targetsByCdpId = new Map<string, SystemChromeWebContents>();

  constructor(private readonly app: App) {}

  resolveWebContents(webContentsId: number) {
    return this.targets.get(webContentsId) ?? null;
  }

  async listSurfaces(): Promise<BrowserSurface[]> {
    if (!this.port) {
      return [];
    }

    try {
      const descriptors = await this.listPageTargets(this.port);
      return descriptors.map((descriptor) => {
        const contents = this.registerTarget(descriptor);
        return this.toSurface(contents, descriptor, false);
      });
    } catch {
      return [];
    }
  }

  async activateSurface(target: string): Promise<BrowserToolResult> {
    const rawTarget = target.trim();
    const chrome = findChromeExecutable(this.app);
    if (!chrome) {
      return {
        ok: false,
        action: "activate_surface",
        target: rawTarget,
        error: "chrome_not_found",
        message: "没有找到 Google Chrome，无法激活系统 Chrome。"
      };
    }

    try {
      const port = this.port ? await this.ensureChrome(chrome) : null;
      const descriptors = port ? await this.listPageTargets(port).catch(() => []) : [];
      const matched = this.matchDescriptor(descriptors, rawTarget);
      if (matched) {
        const contents = this.registerTarget(matched);
        contents.focus();
        const surface = this.toSurface(contents, matched, true);
        return {
          ok: true,
          action: "activate_surface",
          target: rawTarget,
          url: surface.currentUrl || surface.url,
          title: surface.title,
          message: `已激活系统 Chrome：${surface.title || surface.currentUrl || rawTarget}。`,
          data: {
            surface
          }
        };
      }

      const targetUrl = normalizeChromeUrlTarget(rawTarget);
      if (targetUrl) {
        return this.openUrl({
          url: targetUrl,
          label: rawTarget || SYSTEM_CHROME_SURFACE_LABEL
        });
      }

      return {
        ok: false,
        action: "activate_surface",
        target: rawTarget,
        error: "surface_not_found",
        message: "没有找到匹配的系统 Chrome 标签页。"
      };
    } catch (error) {
      return {
        ok: false,
        action: "activate_surface",
        target: rawTarget,
        error: "chrome_activate_failed",
        message: error instanceof Error ? error.message : "激活系统 Chrome 失败。"
      };
    }
  }

  async openUrl(input: { url: string; label?: string }): Promise<BrowserToolResult> {
    const targetUrl = input.url || "https://www.google.com/";
    const chrome = findChromeExecutable(this.app);
    if (!chrome) {
      return {
        ok: false,
        action: "open_url",
        target: targetUrl,
        error: "chrome_not_found",
        message: "没有找到 Google Chrome，无法打开可操作的系统 Chrome。"
      };
    }

    try {
      const port = await this.ensureChrome(chrome);
      const descriptor = await this.createTab(port, targetUrl);
      const contents = this.registerTarget(descriptor);
      await contents.waitForExecutionContext();
      contents.focus();
      const surface = this.toSurface(contents, descriptor, true, input.label || SYSTEM_CHROME_SURFACE_LABEL);
      return {
        ok: true,
        action: "open_url",
        target: targetUrl,
        url: surface.currentUrl,
        title: surface.title,
        message: `已在系统 Chrome 打开${input.label || targetUrl}。`,
        data: {
          surface
        }
      };
    } catch (error) {
      return {
        ok: false,
        action: "open_url",
        target: targetUrl,
        error: "chrome_open_failed",
        message: error instanceof Error ? error.message : "打开系统 Chrome 失败。"
      };
    }
  }

  private async ensureChrome(chromeExecutable: string) {
    const userDataDir = getControlledChromeUserDataDir(this.app);
    if (this.port) {
      try {
        await waitForCdp(this.port);
        return this.port;
      } catch {
        this.port = null;
      }
    }

    const existingPort = await discoverExistingCdpPortForUserDataDir(userDataDir);
    if (existingPort) {
      this.port = existingPort;
      return existingPort;
    }

    const port = await getAvailablePort();
    fs.mkdirSync(userDataDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ];
    const child = spawn(chromeExecutable, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
    });
    this.child = child;
    this.port = port;
    await waitForCdp(port);
    return port;
  }

  private targetKey(descriptor: CdpTargetDescriptor) {
    return descriptor.id || descriptor.webSocketDebuggerUrl || `${descriptor.type || "page"}:${descriptor.url || ""}:${descriptor.title || ""}`;
  }

  private registerTarget(descriptor: CdpTargetDescriptor) {
    const key = this.targetKey(descriptor);
    const existing = this.targetsByCdpId.get(key);
    if (existing) {
      existing.updateFromDescriptor(descriptor);
      return existing;
    }

    const webContentsId = this.nextWebContentsId;
    this.nextWebContentsId -= 1;
    const contents = new SystemChromeWebContents(webContentsId, key, descriptor);
    this.targets.set(webContentsId, contents);
    this.targetsByCdpId.set(key, contents);
    return contents;
  }

  private toSurface(
    contents: SystemChromeWebContents,
    descriptor: CdpTargetDescriptor,
    active: boolean,
    fallbackLabel = SYSTEM_CHROME_SURFACE_LABEL
  ): BrowserSurface {
    const currentUrl = descriptor.url || contents.getURL();
    const title = descriptor.title || contents.getTitle() || fallbackLabel;
    return {
      id: `${SYSTEM_CHROME_SURFACE_ID}:${contents.cdpTargetId}`,
      label: fallbackLabel,
      url: currentUrl || DEFAULT_SYSTEM_CHROME_URL,
      active,
      currentUrl,
      title,
      webContentsId: contents.id
    };
  }

  private async listPageTargets(port: number) {
    const list = await fetchJson<CdpTargetDescriptor[]>(`http://127.0.0.1:${port}/json/list`);
    return list.filter((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }

  private matchDescriptor(descriptors: CdpTargetDescriptor[], rawTarget: string) {
    const target = rawTarget.trim();
    const normalizedTarget = target.toLowerCase();
    const targetUrl = normalizeChromeUrlTarget(target);
    const targetHost = (() => {
      try {
        return targetUrl ? new URL(targetUrl).hostname.toLowerCase() : "";
      } catch {
        return "";
      }
    })();

    if (!target || normalizedTarget === "chrome" || normalizedTarget === "google chrome" || normalizedTarget === "谷歌浏览器" || normalizedTarget === SYSTEM_CHROME_SURFACE_ID) {
      return descriptors.find((item) => item.url && item.url !== "about:blank") ?? descriptors[0] ?? null;
    }

    return descriptors.find((item) => {
      const id = this.targetKey(item);
      const surfaceId = `${SYSTEM_CHROME_SURFACE_ID}:${id}`;
      const url = (item.url || "").toLowerCase();
      const title = (item.title || "").toLowerCase();
      if (normalizedTarget === id.toLowerCase() || normalizedTarget === surfaceId.toLowerCase()) {
        return true;
      }
      if (targetUrl && url === targetUrl.toLowerCase()) {
        return true;
      }
      if (targetHost) {
        try {
          return new URL(item.url || "about:blank").hostname.toLowerCase() === targetHost;
        } catch {
          return false;
        }
      }
      return title.includes(normalizedTarget) || url.includes(normalizedTarget);
    }) ?? null;
  }

  private async createTab(port: number, targetUrl: string) {
    const encoded = encodeURIComponent(targetUrl);
    const candidates = [
      `http://127.0.0.1:${port}/json/new?${encoded}`,
      `http://127.0.0.1:${port}/json/new?url=${encoded}`
    ];
    for (const url of candidates) {
      for (const method of ["PUT", "GET"] as const) {
        try {
          const descriptor = await fetchJson<CdpTargetDescriptor>(url, { method });
          if (descriptor.webSocketDebuggerUrl) {
            return descriptor;
          }
        } catch {
          // Try the next endpoint shape for Chrome versions with different /json/new handling.
        }
      }
    }

    const list = await this.listPageTargets(port);
    const target = list.find((item) =>
      item.type === "page" &&
      item.webSocketDebuggerUrl &&
      (item.url === targetUrl || item.url?.startsWith(targetUrl))
    ) ?? list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("系统 Chrome 已打开，但没有暴露可操作的 CDP 标签页。");
    }
    return target;
  }
}

export const __testInternals = {
  extractChromeCommandArg,
  findCdpPortInProcessTableForPlatform,
  readDevToolsActivePort
};
