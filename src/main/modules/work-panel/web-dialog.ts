import { t } from "../../support/i18n/main-i18n";
import { randomUUID } from "node:crypto";
import { BrowserWindow, webContents, type IpcMain, type WebContents } from "electron";
import { CHAT_WORK_PANEL_WEB_DIALOG_CHANNEL, CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED, CHAT_WORK_PANEL_WEB_DIALOG_RESTORE_REQUESTED, CHAT_WORK_PANEL_WEB_DIALOG_OPEN_REQUESTED, type WorkPanelWebDialogResult } from "../../../shared/chat-work-panel-tab-context-menu";
import { normalizeWorkPanelWebUrl } from "../../../shared/work-panel";
import { createChatChildSurfaceIdentity } from "../../../shared/surface-identity";
import type { BrowserSurfaceRegistry } from "../web-surfaces";
import { WORK_PANEL_DIALOG_RESTORE_URL, WORK_PANEL_DIALOG_ACTION_URL, workPanelDialogShell } from "./web-dialog-shell";
export { WORK_PANEL_DIALOG_RESTORE_URL } from "./web-dialog-shell";

export type WorkPanelDialogSurfaces = Pick<BrowserSurfaceRegistry,
  "resolveWebviewSurfaceTarget" | "getRegisteredSurfaceSnapshot" | "registerSurface" | "unregisterSurface" |
  "retainWorkPanelDialogSurface" | "retainWorkPanelDialogSibling" | "releaseWorkPanelDialogSurface">;
type Snapshot = NonNullable<ReturnType<WorkPanelDialogSurfaces["getRegisteredSurfaceSnapshot"]>>["registered"];
type Transfer = {
  id: string; owner: BrowserWindow; source?: WebContents; snapshot: Snapshot; url: string;
  agentLabel: string; chatLabel: string; group?: Group; guest?: WebContents; opening: boolean; disposed: boolean;
  timer?: ReturnType<typeof setTimeout>; dispose(): void;
};
type Group = { window: BrowserWindow; records: Map<string, Transfer>; activeId: string; pending?: (guest: WebContents) => void; restoring: boolean };

export function workPanelWebDialogOptions(title: string, platform: NodeJS.Platform = process.platform): Electron.BrowserWindowConstructorOptions {
  const options: Electron.BrowserWindowConstructorOptions = {
    // No parent/modal/alwaysOnTop: use normal system window stacking.
    width: 1180, height: 780, minWidth: 480, minHeight: 320, show: false, title,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: true },
  };
  if (platform === "darwin") {
    // Draw ownership and restore alongside the native traffic lights, without
    // a second native title row above the browser chrome.
    options.titleBarStyle = "hidden";
    options.trafficLightPosition = { x: 12, y: 13 };
    options.acceptFirstMouse = true;
  } else if (platform === "win32") {
    options.titleBarStyle = "hidden";
    options.titleBarOverlay = { height: 40 };
    options.autoHideMenuBar = true;
  }
  return options;
}

async function shell(group: Group, method: string, ...args: unknown[]) {
  if (!group.window.isDestroyed()) {
    await group.window.webContents.executeJavaScript(`window.workPanelBrowser.${method}(${args.map((arg) => JSON.stringify(arg)).join(",")})`);
  }
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
  const groups = new Map<string, Group>();
  const ownerWatches = new Map<BrowserWindow, () => void>();
  function watchOwner(owner: BrowserWindow) {
    if (ownerWatches.has(owner)) return;
    const dispose = () => { for (const entry of [...transfers.values()]) if (entry.owner === owner) entry.dispose(); };
    const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) dispose(); };
    owner.once("closed", dispose);
    owner.webContents.once("render-process-gone", dispose);
    owner.webContents.on("did-start-navigation", navigate);
    ownerWatches.set(owner, () => {
      owner.removeListener("closed", dispose);
      owner.webContents.removeListener("render-process-gone", dispose);
      owner.webContents.removeListener("did-start-navigation", navigate);
      ownerWatches.delete(owner);
    });
  }
  let openQueue: Promise<unknown> = Promise.resolve();
  const requestRestore = (group: Group) => {
    const first = group.records.values().next().value as Transfer | undefined;
    if (!first || group.restoring || first.owner.isDestroyed()) return;
    first.owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_RESTORE_REQUESTED, first.id);
  };
  const requestOpen = (record: Transfer, url: string) => {
    const normalized = normalizeWorkPanelWebUrl(url);
    if (normalized && !record.disposed && !record.owner.isDestroyed() && !record.group?.restoring) {
      record.owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_OPEN_REQUESTED, { transferId: record.id, url: normalized });
    }
  };
  function publish(record: Transfer) {
    const guest = record.guest;
    if (!guest || guest.isDestroyed() || record.disposed) return false;
    const tab = record.snapshot.tabs[0];
    const url = normalizeWorkPanelWebUrl(guest.getURL()) || record.url;
    record.url = url;
    const title = (guest.getTitle() || record.snapshot.label).slice(0, 512);
    const back = guest.navigationHistory.canGoBack(), forward = guest.navigationHistory.canGoForward();
    if (record.group) void shell(record.group, "update", record.id, { url, title, back, forward }).catch(() => undefined);
    return surfaces!.registerSurface({ ...record.snapshot, active: false, activeTabId: tab.tabId,
      tabs: [{ ...tab, webContentsId: guest.id, currentUrl: url, title, canGoBack: back, canGoForward: forward, isLoading: guest.isLoading() }],
    }, record.owner.webContents.id);
  }
  function select(record: Transfer) {
    const group = record.group;
    if (!group || group.window.isDestroyed()) return;
    group.activeId = record.id;
    void shell(group, "select", record.id).catch(() => undefined);
  }
  function createGroup(record: Transfer) {
    const dialog = new Window(workPanelWebDialogOptions(`${record.agentLabel} · ${record.chatLabel} · ${record.snapshot.ownerChatId}`));
    const group: Group = { window: dialog, records: new Map(), activeId: record.id, restoring: false };
    groups.set(record.snapshot.ownerChatId!, group);
    dialog.setMenuBarVisibility(false);
    dialog.webContents.on("page-title-updated", (event) => event.preventDefault());
    dialog.on("close", (event) => { event.preventDefault(); requestRestore(group); });
    dialog.once("closed", () => {
      groups.delete(record.snapshot.ownerChatId!);
      for (const entry of [...group.records.values()]) entry.dispose();
    });
    dialog.webContents.on("render-process-gone", () => requestRestore(group));
    const shortcut = (event: Electron.Event, input: Electron.Input) => {
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (input.type === "keyDown" && modifier && input.key.toLowerCase() === "w") {
        event.preventDefault();
        const current = group.records.get(group.activeId);
        if (input.shift || group.records.size <= 1) requestRestore(group);
        else if (current) current.owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED, current.id);
      }
    };
    dialog.webContents.on("before-input-event", shortcut);
    dialog.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    dialog.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (url === WORK_PANEL_DIALOG_RESTORE_URL) { requestRestore(group); return; }
      let actionUrl: URL;
      try { actionUrl = new URL(url); } catch { return; }
      if (`${actionUrl.origin}${actionUrl.pathname}` !== WORK_PANEL_DIALOG_ACTION_URL || group.restoring) return;
      const current = group.records.get(actionUrl.searchParams.get("id") || "");
      if (!current || current.disposed) return;
      const action = actionUrl.searchParams.get("action");
      const guest = current.guest;
      if (action === "new") requestOpen(current, actionUrl.searchParams.get("url") || "");
      else if (action === "select") select(current);
      else if (action === "close") current.owner.webContents.send(CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED, current.id);
      else if (guest && !guest.isDestroyed()) {
        if (action === "reload") guest.reload();
        else if (action === "back" && guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack();
        else if (action === "forward" && guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward();
        else if (action === "navigate") {
          const nextUrl = normalizeWorkPanelWebUrl(actionUrl.searchParams.get("url") || "");
          if (nextUrl) void guest.loadURL(nextUrl).catch(() => undefined);
        }
      }
    });
    dialog.webContents.on("will-attach-webview", (event, preferences, params) => {
      if (!group.pending || !normalizeWorkPanelWebUrl(params.src)) { event.preventDefault(); return; }
      delete preferences.preload;
      delete preferences.partition;
      preferences.nodeIntegration = false;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.webSecurity = true;
    });
    dialog.webContents.on("did-attach-webview", (_event, guest) => {
      guest.on("before-input-event", shortcut);
      const attach = group.pending;
      group.pending = undefined;
      if (attach) attach(guest); else guest.close({ waitForBeforeUnload: false });
    });
    return group;
  }
  async function open(record: Transfer): Promise<WorkPanelWebDialogResult> {
    if (record.disposed) return { ok: false };
    record.opening = true;
    clearTimeout(record.timer);
    let phase = "release-source";
    try {
      if (record.source && !record.source.isDestroyed()) await new Promise<void>((resolve) => {
        record.source!.once("destroyed", resolve);
        record.source!.close({ waitForBeforeUnload: false });
      });
      if (record.disposed || record.owner.isDestroyed()) return { ok: false };
      let group = groups.get(record.snapshot.ownerChatId!);
      if (group?.restoring) throw new Error("dialog_restoring");
      const fresh = !group;
      group ??= createGroup(record);
      record.group = group;
      group.records.set(record.id, record);
      phase = "load-shell";
      if (fresh) await group.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(workPanelDialogShell(randomUUID(), record.agentLabel, record.chatLabel, record.snapshot.ownerChatId!))}`);
      phase = "attach-guest";
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { group!.pending = undefined; reject(new Error("dialog_attach_timeout")); }, 15_000);
        group!.pending = (guest) => {
          clearTimeout(timer);
          record.guest = guest;
          const guard = (event: Electron.Event, url: string) => { if (!normalizeWorkPanelWebUrl(url)) event.preventDefault(); };
          guest.on("will-navigate", guard);
          guest.on("will-redirect", guard);
          guest.setWindowOpenHandler(({ url }) => { requestOpen(record, url); return { action: "deny" }; });
          const update = () => { publish(record); };
          guest.on("did-navigate", update);
          guest.on("did-navigate-in-page", update);
          guest.on("page-title-updated", update);
          guest.on("did-start-loading", () => { update(); if (record.group) void shell(record.group, "error", record.id, "").catch(() => undefined); });
          guest.on("did-stop-loading", update);
          guest.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
            if (mainFrame && code !== -3 && record.group) void shell(record.group, "error", record.id, `${code}: ${description}`).catch(() => undefined);
          });
          if (publish(record)) resolve(); else reject(new Error("surface_registration_failed"));
        };
      });
      await Promise.all([ready, shell(group, "add", record.id, record.url, record.snapshot.label)]);
      select(record);
      group.window.show();
      group.window.focus();
      return { ok: true };
    } catch (error) {
      // Never log URLs or raw Electron errors: they may contain credentials or
      // private query parameters. Phase and bounded failure codes are enough.
      const knownReasons = new Set(["dialog_restoring", "dialog_attach_timeout", "surface_registration_failed"]);
      const reason = error instanceof Error && knownReasons.has(error.message) ? error.message : "operation_failed";
      console.warn("[work-panel-web-dialog] open failed", { phase, reason, surfaceId: record.snapshot.surfaceId, disposed: record.disposed });
      await disposeTransfer(record);
      return { ok: false };
    } finally { record.opening = false; }
  }
  ipcMain.handle(CHAT_WORK_PANEL_WEB_DIALOG_CHANNEL, async (event, input: unknown): Promise<WorkPanelWebDialogResult> => {
    const owner = getMainWindow();
    if (!surfaces || !owner || owner.isDestroyed() || event.sender !== owner.webContents ||
        event.senderFrame !== owner.webContents.mainFrame || !input || typeof input !== "object" || Array.isArray(input)) return { ok: false };
    const request = input as Record<string, unknown>;
    const reject = (reason: string): WorkPanelWebDialogResult => {
      console.warn("[work-panel-web-dialog] request rejected", {
        action: ["prepare", "prepareSibling", "open", "focus", "reload", "close", "restore"].includes(String(request.action)) ? request.action : "unknown",
        reason,
      });
      return { ok: false };
    };
    if (request.action === "prepare" || request.action === "prepareSibling") {
      const sibling = request.action === "prepareSibling";
      const allowed = sibling ? ["action", "transferId", "itemId", "stableKey", "url", "title", "sourceGuestId"] : ["action", "sourceGuestId", "agentLabel", "chatLabel"];
      if (Object.keys(request).some((key) => !allowed.includes(key))) return { ok: false };
      const anchor = sibling && typeof request.transferId === "string" ? transfers.get(request.transferId) : undefined;
      if (sibling && (!anchor || anchor.disposed || anchor.owner !== owner || anchor.group?.restoring)) return { ok: false };
      const source = Number.isSafeInteger(request.sourceGuestId) ? contents.fromId(request.sourceGuestId as number) ?? undefined : undefined;
      const target = source && surfaces.resolveWebviewSurfaceTarget(source.id);
      const registered = target && surfaces.getRegisteredSurfaceSnapshot(target.surfaceId, target.registrationId, owner.webContents.id);
      if (source && (source.isDestroyed() || source.hostWebContents !== owner.webContents || source.getType() !== "webview")) return { ok: false };
      let snapshot: Snapshot;
      let url: string;
      const registrationId = randomUUID();
      if (target && registered) {
        if (target.surfaceKind !== "chat-work-panel" || target.surfaceRole !== "workpanel-web" || !target.ownerChatId ||
            target.ownerWebContentsId !== owner.webContents.id || registered.tabs.length !== 1 ||
            (anchor && anchor.snapshot.ownerChatId !== target.ownerChatId)) return { ok: false };
        url = normalizeWorkPanelWebUrl(source!.getURL());
        if (!url) return reject("source_url_unavailable");
        if ([...transfers.values()].some((entry) => entry.snapshot.surfaceId === target.surfaceId)) return reject("transfer_already_prepared");
        if (!surfaces.retainWorkPanelDialogSurface(target.surfaceId, target.registrationId, owner.webContents.id, registrationId)) return reject("source_reservation_failed");
        snapshot = { ...registered.registered, registrationId, tabs: registered.tabs.map((tab) => ({ ...tab })) };
      } else {
        if (!anchor) return reject("source_not_registered");
        if (![request.itemId, request.stableKey, request.title].every((v) => typeof v === "string" && v.length > 0 && v.length <= 4096)) return { ok: false };
        url = typeof request.url === "string" ? normalizeWorkPanelWebUrl(request.url) : "";
        if (!url) return { ok: false };
        const identity = createChatChildSurfaceIdentity("workpanel-web", request.stableKey as string, anchor.snapshot.ownerChatId!);
        if (!surfaces.retainWorkPanelDialogSibling(anchor.snapshot.surfaceId, anchor.snapshot.registrationId, identity.surfaceId, registrationId)) return { ok: false };
        snapshot = { ...anchor.snapshot, ...identity, registrationId, surfaceIdentityKey: request.stableKey as string,
          label: request.title as string, url, activeTabId: request.itemId as string,
          tabs: [{ tabId: request.itemId as string, currentUrl: url, title: request.title as string, webContentsId: 0, canGoBack: false, canGoForward: false, isLoading: false }] };
      }
      const transferId = randomUUID();
      const label = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : fallback;
      const record: Transfer = {
        id: transferId, owner, source, url, snapshot, opening: false, disposed: false,
        agentLabel: anchor?.agentLabel || label(request.agentLabel, t("chatWorkPanel.dialog.agent")),
        chatLabel: anchor?.chatLabel || label(request.chatLabel, snapshot.ownerChatId!),
        dispose: () => {
          if (record.disposed) return;
          record.disposed = true;
          clearTimeout(record.timer);
          transfers.delete(transferId);
          if (![...transfers.values()].some((entry) => entry.owner === owner)) ownerWatches.get(owner)?.();
          surfaces.releaseWorkPanelDialogSurface(snapshot.surfaceId, snapshot.registrationId);
          surfaces.unregisterSurface({ surfaceId: snapshot.surfaceId, registrationId: snapshot.registrationId }, owner.webContents.id);
          const group = record.group;
          if (group) {
            group.records.delete(record.id);
            if (record.guest && !record.guest.isDestroyed()) record.guest.close({ waitForBeforeUnload: false });
            if (!group.window.isDestroyed()) {
              if (!group.records.size) group.window.destroy();
              else {
                void shell(group, "remove", record.id).catch(() => undefined);
                if (group.activeId === record.id) select(group.records.values().next().value!);
              }
            }
          }
        },
      };
      transfers.set(transferId, record);
      watchOwner(owner);
      record.timer = setTimeout(record.dispose, 30_000);
      record.timer.unref();
      return { ok: true, transferId, surfaceId: snapshot.surfaceId, ownerChatId: snapshot.ownerChatId };
    }
    if (typeof request.transferId !== "string" || Object.keys(request).some((key) => key !== "action" && key !== "transferId")) return { ok: false };
    const record = transfers.get(request.transferId);
    if (!record || record.owner !== owner) return reject("transfer_unavailable");
    if (request.action === "close") { await disposeTransfer(record); return { ok: true }; }
    if (request.action === "restore") {
      const group = record.group;
      if (!group || group.restoring) return { ok: false };
      group.restoring = true;
      const records = [...transfers.values()].filter((entry) => entry.snapshot.ownerChatId === record.snapshot.ownerChatId);
      records.sort((a, b) => Number(a.id === group.activeId) - Number(b.id === group.activeId));
      const restoredItems = records.map((entry) => ({ transferId: entry.id, surfaceId: entry.snapshot.surfaceId,
        url: (entry.guest && !entry.guest.isDestroyed() && normalizeWorkPanelWebUrl(entry.guest.getURL())) || entry.url }));
      for (const entry of records) await disposeTransfer(entry);
      if (!owner.isDestroyed()) { if (owner.isMinimized()) owner.restore(); owner.show(); owner.focus(); }
      return { ok: true, url: restoredItems.find((entry) => entry.transferId === record.id)?.url, surfaceId: record.snapshot.surfaceId, ownerChatId: record.snapshot.ownerChatId, restoredItems };
    }
    if (request.action === "focus" || request.action === "reload") {
      const group = record.group;
      if (!group || group.window.isDestroyed() || !record.guest || record.guest.isDestroyed()) return { ok: false };
      if (request.action === "reload") record.guest.reload();
      else { select(record); if (group.window.isMinimized()) group.window.restore(); group.window.show(); group.window.focus(); }
      return { ok: true };
    }
    if (request.action !== "open" || record.opening || record.group) return { ok: false };
    record.opening = true;
    const result = openQueue.then(() => open(record));
    openQueue = result.catch(() => undefined);
    return result;
  });
}
