import { t } from "../../support/i18n/main-i18n";
import { randomUUID } from "node:crypto";
import { BrowserWindow, webContents, type IpcMain, type WebContents } from "electron";
import { CHAT_WORK_PANEL_WEB_DIALOG_CHANNEL, CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED, CHAT_WORK_PANEL_WEB_DIALOG_RESTORE_REQUESTED, type WorkPanelWebDialogResult } from "../../../shared/chat-work-panel-tab-context-menu";
import { normalizeWorkPanelWebUrl } from "../../../shared/work-panel";
import type { BrowserSurfaceRegistry } from "../web-surfaces";

export type WorkPanelDialogSurfaces = Pick<BrowserSurfaceRegistry,
  "resolveWebviewSurfaceTarget" | "getRegisteredSurfaceSnapshot" | "registerSurface" | "unregisterSurface" |
  "retainWorkPanelDialogSurface" | "releaseWorkPanelDialogSurface">;
type Snapshot = NonNullable<ReturnType<WorkPanelDialogSurfaces["getRegisteredSurfaceSnapshot"]>>["registered"];
type Transfer = {
  owner: BrowserWindow; source: WebContents; snapshot: Snapshot; url: string;
  window?: BrowserWindow; guest?: WebContents; opening: boolean; disposed: boolean;
  timer?: ReturnType<typeof setTimeout>; dispose(): void;
};

export function workPanelWebDialogOptions(title: string, platform: NodeJS.Platform = process.platform): Electron.BrowserWindowConstructorOptions {
  const options: Electron.BrowserWindowConstructorOptions = {
    // No parent/modal/alwaysOnTop: use normal system window stacking.
    width: 1180, height: 780, minWidth: 480, minHeight: 320, show: false, title,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: true },
  };
  if (platform === "darwin") options.titleBarStyle = "default";
  else if (platform === "win32") options.autoHideMenuBar = true;
  return options;
}

export const WORK_PANEL_DIALOG_RESTORE_URL = "https://workpanel.invalid/restore";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellHtml(url: string) {
  return `<!doctype html><html><head><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex;flex-direction:column;font:13px system-ui;background:Canvas;color:CanvasText}
header{display:flex;align-items:center;justify-content:flex-end;padding:8px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 16%,transparent)}
a{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;color:CanvasText;text-decoration:none;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:6px}
a:hover{background:color-mix(in srgb,CanvasText 8%,Canvas)}a:focus-visible{outline:2px solid Highlight;outline-offset:2px}webview{display:flex;flex:1;min-height:0;width:100%}
</style></head><body><header><a href="${WORK_PANEL_DIALOG_RESTORE_URL}">${escapeHtml(t("chatWorkPanel.dialog.restore"))}</a></header><webview src="${escapeHtml(url)}"></webview></body></html>`;
}

async function disposeTransfer(record: Transfer) {
  const guest = record.guest;
  const released = guest && !guest.isDestroyed()
    ? new Promise<void>((resolve) => guest.once("destroyed", resolve)) : Promise.resolve();
  record.dispose();
  await released;
}

export function registerWorkPanelWebDialogIpc(
  ipcMain: Pick<IpcMain, "handle">,
  getMainWindow: () => BrowserWindow | null,
  surfaces?: WorkPanelDialogSurfaces,
  Window: typeof BrowserWindow = BrowserWindow,
  contents: Pick<typeof webContents, "fromId"> = webContents,
) {
  const transfers = new Map<string, Transfer>();
  ipcMain.handle(CHAT_WORK_PANEL_WEB_DIALOG_CHANNEL, async (event, input: unknown): Promise<WorkPanelWebDialogResult> => {
    const owner = getMainWindow();
    if (!surfaces || !owner || owner.isDestroyed() || event.sender !== owner.webContents ||
        event.senderFrame !== owner.webContents.mainFrame || !input || typeof input !== "object" || Array.isArray(input)) return { ok: false };
    const request = input as Record<string, unknown>;
    if (request.action === "prepare") {
      if (Object.keys(request).some((key) => !["action", "sourceGuestId"].includes(key)) ||
          !Number.isSafeInteger(request.sourceGuestId)) return { ok: false };
      const source = contents.fromId(request.sourceGuestId as number);
      const target = source && surfaces.resolveWebviewSurfaceTarget(source.id);
      if (!source || source.isDestroyed() || source.hostWebContents !== owner.webContents ||
          source.getType() !== "webview" || target?.surfaceKind !== "chat-work-panel" ||
          target.surfaceRole !== "workpanel-web" || !target.ownerChatId || target.ownerWebContentsId !== owner.webContents.id) return { ok: false };
      const registered = surfaces.getRegisteredSurfaceSnapshot(target.surfaceId, target.registrationId, owner.webContents.id);
      const url = normalizeWorkPanelWebUrl(source.getURL());
      if (!registered || registered.tabs.length !== 1 || !url || [...transfers.values()].some((entry) => entry.snapshot.surfaceId === target.surfaceId)) return { ok: false };
      const transferId = randomUUID();
      const registrationId = randomUUID();
      if (!surfaces.retainWorkPanelDialogSurface(target.surfaceId, target.registrationId, owner.webContents.id, registrationId)) return { ok: false };
      const onOwnerNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace) record.dispose();
      };
      const record: Transfer = {
        owner, source, url, opening: false, disposed: false,
        snapshot: { ...registered.registered, registrationId, tabs: registered.tabs.map((tab) => ({ ...tab })) },
        dispose: () => {
          if (record.disposed) return;
          record.disposed = true;
          clearTimeout(record.timer);
          transfers.delete(transferId);
          owner.removeListener("closed", record.dispose);
          owner.webContents.removeListener("render-process-gone", record.dispose);
          owner.webContents.removeListener("did-start-navigation", onOwnerNavigation);
          surfaces.releaseWorkPanelDialogSurface(record.snapshot.surfaceId, record.snapshot.registrationId);
          surfaces.unregisterSurface({ surfaceId: record.snapshot.surfaceId, registrationId: record.snapshot.registrationId }, owner.webContents.id);
          if (record.window && !record.window.isDestroyed()) record.window.destroy();
        },
      };
      transfers.set(transferId, record);
      owner.once("closed", record.dispose);
      owner.webContents.once("render-process-gone", record.dispose);
      owner.webContents.on("did-start-navigation", onOwnerNavigation);
      record.timer = setTimeout(record.dispose, 30_000);
      record.timer.unref();
      return { ok: true, transferId, surfaceId: target.surfaceId, ownerChatId: target.ownerChatId };
    }
    if (typeof request.transferId !== "string" || Object.keys(request).some((key) => key !== "action" && key !== "transferId")) return { ok: false };
    const record = transfers.get(request.transferId);
    if (!record || record.owner !== owner) return { ok: false };
    const transferId = request.transferId;
    if (request.action === "close") { await disposeTransfer(record); return { ok: true }; }
    if (request.action === "restore") {
      if (record.opening || !record.guest || record.guest.isDestroyed()) return { ok: false };
      const url = normalizeWorkPanelWebUrl(record.guest.getURL()) || record.url;
      await disposeTransfer(record);
      if (!owner.isDestroyed()) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
      return { ok: true, url, surfaceId: record.snapshot.surfaceId, ownerChatId: record.snapshot.ownerChatId };
    }
    if (request.action === "focus" || request.action === "reload") {
      if (!record.window || record.window.isDestroyed() || !record.guest || record.guest.isDestroyed()) return { ok: false };
      if (request.action === "reload") record.guest.reload();
      else { if (record.window.isMinimized()) record.window.restore(); record.window.show(); record.window.focus(); }
      return { ok: true };
    }
    if (request.action !== "open" || record.opening || record.window) return { ok: false };
    record.opening = true;
    clearTimeout(record.timer);
    try {
      // Renderer first unmounts the embedded page. Never create the destination
      // until Electron has released that page, including any delayed teardown.
      if (!record.source.isDestroyed()) await new Promise<void>((resolve) => {
        record.source.once("destroyed", resolve);
        record.source.close({ waitForBeforeUnload: false });
      });
      if (record.disposed || owner.isDestroyed()) return { ok: false };
      const dialog = new Window(workPanelWebDialogOptions(record.snapshot.label));
      record.window = dialog;
      dialog.setMenuBarVisibility(false);
      dialog.webContents.on("page-title-updated", (event) => event.preventDefault());
      dialog.on("close", (closeEvent) => {
        closeEvent.preventDefault();
        if (!owner.isDestroyed()) owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED, transferId);
      });
      dialog.once("closed", record.dispose);
      const closeShortcut = (event: Electron.Event, input: Electron.Input) => {
        const modifier = process.platform === "darwin" ? input.meta : input.control;
        if (input.type === "keyDown" && modifier && input.key.toLowerCase() === "w") { event.preventDefault(); dialog.close(); }
      };
      dialog.webContents.on("before-input-event", closeShortcut);
      dialog.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      dialog.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        // Only this trusted shell can request restoration; guest navigation does
        // not enter this handler and cannot select a different item or Chat.
        if (url === WORK_PANEL_DIALOG_RESTORE_URL && !record.opening && !record.disposed && !owner.isDestroyed()) {
          owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_RESTORE_REQUESTED, transferId);
        }
      });
      dialog.webContents.on("will-attach-webview", (_event, preferences) => {
        delete preferences.preload;
        preferences.nodeIntegration = false;
        preferences.contextIsolation = true;
        preferences.sandbox = true;
        preferences.webSecurity = true;
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("dialog_load_timeout")), 30_000);
        const cleanup = () => clearTimeout(timer);
        dialog.once("closed", () => { cleanup(); reject(new Error("dialog_closed")); });
        dialog.webContents.once("did-attach-webview", (_event, guest) => {
          record.guest = guest;
          const update = () => {
            if (record.disposed || guest.isDestroyed()) return false;
            const tab = record.snapshot.tabs[0];
            return surfaces.registerSurface({ ...record.snapshot, active: false, activeTabId: tab.tabId,
              tabs: [{ ...tab, webContentsId: guest.id, currentUrl: guest.getURL() || record.url,
                title: guest.getTitle(), canGoBack: guest.navigationHistory.canGoBack(),
                canGoForward: guest.navigationHistory.canGoForward(), isLoading: guest.isLoading() }],
            }, owner.webContents.id);
          };
          const guard = (event: Electron.Event, url: string) => { if (!normalizeWorkPanelWebUrl(url)) event.preventDefault(); };
          guest.on("will-navigate", guard);
          guest.on("will-redirect", guard);
          guest.setWindowOpenHandler(() => ({ action: "deny" }));
          guest.on("before-input-event", closeShortcut);
          guest.on("did-navigate", update);
          guest.on("did-navigate-in-page", update);
          guest.on("page-title-updated", update);
          guest.once("did-finish-load", () => { cleanup(); if (update()) resolve(); else reject(new Error("surface_registration_failed")); });
          guest.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
            if (mainFrame && code !== -3) { cleanup(); reject(new Error("dialog_load_failed")); }
          });
        });
      });
      await Promise.all([ready, dialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shellHtml(record.url))}`)]);
      if (record.disposed || dialog.isDestroyed()) return { ok: false };
      dialog.show();
      dialog.focus();
      return { ok: true };
    } catch {
      await disposeTransfer(record);
      return { ok: false };
    } finally { record.opening = false; }
  });
}
