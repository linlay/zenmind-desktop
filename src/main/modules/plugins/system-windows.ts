import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, ipcMain, screen, session, type App, type Session } from "electron";
import { attachDesktopLayer } from "../../infrastructure/electron/system-window-layer";
import { SYSTEM_WINDOW_EVENT, SYSTEM_WINDOW_MESSAGE, systemWindowCreateSchema,
  systemWindowHandleSchema, systemWindowPostSchema, systemWindowUpdateSchema } from "../../../shared/system-windows";

type Emit = (pluginId: string, name: string, data: unknown) => void;
type RecordEntry = { id: string; pluginId: string; window: BrowserWindow; layer: "normal" | "desktop";
  attachment?: ReturnType<typeof attachDesktopLayer>; timer?: NodeJS.Timeout };
const origin = "https://plugin.local";

export function resolvePluginWindowAsset(root: string, entry: string) {
  if (!entry || entry.includes("\\") || entry.includes("\0") || entry.split("/").some(p => p === "..") || path.isAbsolute(entry)) {
    throw new Error("window entry must be a relative plugin asset path");
  }
  const realRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.join(realRoot, entry));
  const relative = path.relative(realRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(file).isFile()) throw new Error("window asset escapes plugin package");
  return file;
}

export function createPluginSystemWindows(app: App, emit: Emit) {
  let initialized = false;
  let disposed = false;
  const records = new Map<string, RecordEntry>();
  const sessions = new Map<string, { root: string; session: Session }>();
  const generations = new Map<string, number>();
  const sendEvent = (record: RecordEntry, type: string, data: unknown = {}) => emit(record.pluginId, "system.window.event", { windowId: record.id, type, data });
  const get = (pluginId: string, input: unknown) => {
    const { windowId } = systemWindowHandleSchema.parse(input);
    const record = records.get(windowId);
    if (!record || record.pluginId !== pluginId || record.window.isDestroyed()) throw new Error("window not owned by this plugin");
    return record;
  };
  const onMessage = (event: Electron.IpcMainEvent, data: unknown) => {
    const record = [...records.values()].find(r => r.window.webContents === event.sender);
    if (!record || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + "/")) return;
    if (Buffer.byteLength(JSON.stringify(data) ?? "") > 2 * 1024 * 1024) return;
    sendEvent(record, "message", data);
  };
  const displays = () => screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }));
  const displaysChanged = () => { for (const pluginId of sessions.keys()) emit(pluginId, "system.display.event", { displays: displays() }); };
  function initialize() {
    if (disposed) throw new Error("plugin system windows have been disposed");
    if (initialized) return;
    // Assembly and early shutdown must not touch Electron's ready-only APIs.
    // No whenReady callback: unused plugins add no work to the startup path.
    if (!app.isReady()) throw new Error("plugin system windows require Electron ready");
    screen.on("display-added", displaysChanged);
    screen.on("display-removed", displaysChanged);
    screen.on("display-metrics-changed", displaysChanged);
    ipcMain.on(SYSTEM_WINDOW_MESSAGE, onMessage);
    initialized = true;
  }

  function getSession(pluginId: string, root: string) {
    const existing = sessions.get(pluginId);
    if (existing) {
      if (existing.root !== root) throw new Error("stop plugin before changing its package");
      return existing.session;
    }
    const isolated = session.fromPartition(`plugin-window-${crypto.randomUUID()}`);
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.protocol.handle("https", async request => {
      try {
        const url = new URL(request.url);
        if (url.origin !== origin || request.method !== "GET") return new Response(null, { status: 403 });
        const file = resolvePluginWindowAsset(root, decodeURIComponent(url.pathname.slice(1)));
        const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
        return new Response(fs.readFileSync(file), { headers: { "content-type": types[path.extname(file)] ?? "application/octet-stream",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'" } });
      } catch { return new Response(null, { status: 404 }); }
    });
    sessions.set(pluginId, { root, session: isolated });
    return isolated;
  }

  async function handle(pluginId: string, root: string, method: string, input: unknown): Promise<unknown> {
    initialize();
    if (method === "system.capabilities") return { platform: process.platform, windowLayers: process.platform === "darwin" || process.platform === "win32" ? ["normal", "desktop"] : ["normal"] };
    if (method === "system.displays.list") return displays();
    if (method === "system.window.create") {
      const options = systemWindowCreateSchema.parse(input);
      resolvePluginWindowAsset(root, options.entry);
      if (path.extname(options.entry) !== ".html") throw new Error("window entry must be an HTML asset");
      const generation = generations.get(pluginId) ?? 0;
      const window = new BrowserWindow({ ...options.bounds, title: options.title, backgroundColor: options.backgroundColor,
        show: false, frame: options.frame, resizable: true, hasShadow: true,
        ...(process.platform === "darwin" ? { roundedCorners: true } : {}),
        ...(process.platform === "win32" ? { thickFrame: true, autoHideMenuBar: true, skipTaskbar: options.layer === "desktop" } : {}),
        webPreferences: { session: getSession(pluginId, root), preload: path.join(app.getAppPath(), "dist-electron/preload/plugin-window.js"),
          contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
      const record: RecordEntry = { id: crypto.randomUUID(), pluginId, window, layer: options.layer };
      records.set(record.id, record);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", event => event.preventDefault());
      window.on("close", event => { event.preventDefault(); sendEvent(record, "closeRequested"); });
      const changed = () => {
        try { sendEvent(record, "boundsChanged", record.attachment?.getBounds?.() ?? window.getBounds()); }
        catch (error) { sendEvent(record, "error", { message: String(error) }); }
      };
      window.on("move", changed);
      window.on("resize", changed);
      window.on("closed", () => { clearInterval(record.timer); records.delete(record.id); sendEvent(record, "closed"); });
      window.webContents.on("render-process-gone", (_event, details) => { sendEvent(record, "error", details); destroy(record); });
      try {
        const url = new URL(options.entry.split("/").map(encodeURIComponent).join("/"), origin + "/");
        if (options.data !== undefined) url.hash = encodeURIComponent(JSON.stringify(options.data));
        if (options.layer === "desktop") record.attachment = attachDesktopLayer(window);
        await window.loadURL(url.href);
        if (generation !== (generations.get(pluginId) ?? 0) || window.isDestroyed()) throw new Error("plugin stopped during window creation");
        record.attachment?.verify();
        if (record.attachment) record.timer = setInterval(() => {
          if (window.isDestroyed()) return;
          try { record.attachment?.verify(); }
          catch (error) { sendEvent(record, "error", { message: String(error) }); destroy(record); }
        }, 1500);
        record.timer?.unref();
        window.showInactive();
        return { windowId: record.id, platform: process.platform };
      } catch (error) { destroy(record); throw error; }
    }
    if (method === "system.window.postMessage") {
      const request = systemWindowPostSchema.parse(input);
      get(pluginId, { windowId: request.windowId }).window.webContents.send(SYSTEM_WINDOW_EVENT, request.data);
      return {};
    }
    if (method === "system.window.update") {
      const request = systemWindowUpdateSchema.parse(input);
      const record = get(pluginId, { windowId: request.windowId });
      if (request.title !== undefined) record.window.setTitle(request.title);
      if (request.backgroundColor !== undefined) record.window.setBackgroundColor(request.backgroundColor);
      if (request.bounds) {
        if (record.attachment?.setBounds) record.attachment.setBounds(request.bounds);
        else record.window.setBounds(request.bounds);
      }
      return {};
    }
    const record = get(pluginId, input);
    if (method === "system.window.destroy") destroy(record);
    else if (method === "system.window.show") record.window.showInactive();
    else if (method === "system.window.hide") record.window.hide();
    else if (method === "system.window.focus") { if (record.attachment) record.attachment.focus(); else record.window.focus(); }
    else throw new Error(`unsupported system bridge method: ${method}`);
    return {};
  }

  function destroy(record: RecordEntry) {
    clearInterval(record.timer);
    if (!record.window.isDestroyed()) { record.attachment?.dispose(); record.window.destroy(); }
  }
  function cleanup(pluginId: string) {
    generations.set(pluginId, (generations.get(pluginId) ?? 0) + 1);
    for (const record of records.values()) if (record.pluginId === pluginId) destroy(record);
    const stored = sessions.get(pluginId);
    stored?.session.protocol.unhandle("https");
    sessions.delete(pluginId);
  }
  return { handle, cleanup, dispose() {
    if (disposed) return;
    disposed = true;
    for (const id of sessions.keys()) cleanup(id);
    if (initialized) {
      ipcMain.removeListener(SYSTEM_WINDOW_MESSAGE, onMessage);
      screen.removeListener("display-added", displaysChanged);
      screen.removeListener("display-removed", displaysChanged);
      screen.removeListener("display-metrics-changed", displaysChanged);
      initialized = false;
    }
  } };
}
