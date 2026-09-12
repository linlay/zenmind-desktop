import { BrowserWindow, Menu, dialog, screen, type App } from "electron";
import type { WebappEntry } from "../../../../shared/contracts";
import { DESKTOP_BROWSER_WEBVIEW_PARTITION } from "../../../../shared/browser-surfaces";
import { documentWindowRequestSchema, type DocumentWindowResult } from "../../../../shared/webapp-document-windows";
import { t } from "../../../support/i18n/main-i18n";
import { readDocumentWindows, writeDocumentWindows, fitDocumentBounds, documentWindowOptions, type DocumentWindowPreference } from "./document-window-state";

type RecordEntry = { window: BrowserWindow; app: App; webappId: string; id: string; forced: boolean; preference: DocumentWindowPreference; saveTimer?: NodeJS.Timeout };

/** Document windows share the app's backend, but each has its own native window and editor. */
export class DocumentWindowManager {
  private openLibrary?: (app: App, id: string) => Promise<unknown>;
  setLibraryOpener(open: (app: App, id: string) => Promise<unknown>) { this.openLibrary = open; }
  private records = new Map<string, RecordEntry>();
  private pending = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();

  private persist(record: RecordEntry, open = true) {
    if (!record.window.isDestroyed()) record.preference.bounds = record.window.getNormalBounds();
    record.preference.open = open;
    const saved = readDocumentWindows(record.app, record.webappId);
    saved[record.id] = record.preference;
    writeDocumentWindows(record.app, record.webappId, saved);
  }

  private remember(record: RecordEntry, open = true) {
    clearTimeout(record.saveTimer);
    try { this.persist(record, open); }
    catch (error) { console.warn("Unable to save document window position", error); }
  }

  private setTop(record: RecordEntry, enabled: boolean) {
    if (process.platform === "darwin") record.window.setAlwaysOnTop(enabled, "floating");
    else if (process.platform === "win32") record.window.setAlwaysOnTop(enabled, "normal");
    else record.window.setAlwaysOnTop(enabled);
    record.preference.alwaysOnTop = enabled;
  }

  private async open(app: App, item: WebappEntry, gateway: string, id: string, focus: boolean) {
    const entry = item.desktopBridge?.documentWindows?.entry;
    if (!entry) throw new Error("This app does not declare document windows.");
    const key = `${item.id}:${id}`;
    const existing = this.records.get(key);
    if (existing && !existing.window.isDestroyed()) {
      if (focus) { existing.window.restore(); existing.window.show(); existing.window.focus(); }
      return;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generations.get(item.id) ?? 0;
    const task = (async () => {
      const areas = screen.getAllDisplays().map(display => display.workArea);
      const primary = screen.getPrimaryDisplay().workArea;
      const offset = (this.records.size % 10) * 26;
      const preferences = readDocumentWindows(app, item.id);
      const saved = Object.hasOwn(preferences, id) ? preferences[id] : undefined;
      const preference: DocumentWindowPreference = saved ?? {
        bounds: { x: primary.x + 70 + offset, y: primary.y + 70 + offset, width: 320, height: 330 },
        open: true, alwaysOnTop: false, color: "#fff1ad"
      };
      preference.bounds = fitDocumentBounds(preference.bounds, areas);
      const url = new URL(entry.split("/").map(encodeURIComponent).join("/"), gateway);
      url.hash = id;
      const window = new BrowserWindow({ ...documentWindowOptions(process.platform, preference.bounds, preference.color),
        title: item.label, webPreferences: { partition: DESKTOP_BROWSER_WEBVIEW_PARTITION,
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      const record: RecordEntry = { window, app, webappId: item.id, id, forced: false, preference };
      this.records.set(key, record);
      this.setTop(record, preference.alwaysOnTop);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, target) => {
        if (target !== url.href) event.preventDefault();
      });
      window.webContents.on("context-menu", (_event, params) => {
        Menu.buildFromTemplate([
          ...(params.isEditable ? [{ role: "undo" as const }, { role: "redo" as const }, { type: "separator" as const },
            { role: "cut" as const }, { role: "copy" as const }, { role: "paste" as const }, { role: "selectAll" as const }] : [{ role: "copy" as const }]),
          { type: "separator" },
          { label: t("webapp.window.alwaysOnTop"), type: "checkbox", checked: window.isAlwaysOnTop(),
            click: () => { this.setTop(record, !window.isAlwaysOnTop()); this.remember(record); } }
        ]).popup({ window });
      });
      window.webContents.on("will-prevent-unload", event => {
        if (record.forced || dialog.showMessageBoxSync(window, { type: "warning",
          message: t("webapp.window.unsavedChanges"), buttons: [t("webapp.window.keepEditing"), t("webapp.window.discardChanges")],
          defaultId: 0, cancelId: 0, noLink: true }) === 1) event.preventDefault();
      });
      const rememberGeometry = () => {
        record.preference.bounds = window.getNormalBounds();
        clearTimeout(record.saveTimer);
        record.saveTimer = setTimeout(() => this.remember(record), 150);
        record.saveTimer.unref();
      };
      window.on("move", rememberGeometry);
      window.on("resize", rememberGeometry);
      window.on("closed", () => {
        this.remember(record, record.forced);
        if (this.records.get(key) === record) this.records.delete(key);
      });
      try {
        await window.loadURL(url.href);
        if (window.isDestroyed() || generation !== (this.generations.get(item.id) ?? 0)) return;
        this.remember(record);
        if (focus) { window.show(); window.focus(); } else window.showInactive();
      } catch (error) {
        record.forced = true;
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    })();
    this.pending.set(key, task);
    try { await task; } finally { this.pending.delete(key); }
  }

  async handle(app: App, item: WebappEntry, gateway: string, input: unknown): Promise<DocumentWindowResult> {
    if (!item.desktopBridge?.documentWindows) throw new Error("This app does not declare document windows.");
    const request = documentWindowRequestSchema.parse(input);
    if (request.operation === "library") await this.openLibrary?.(app, item.id);
    if (request.operation === "open") await this.open(app, item, gateway, request.id, true);
    if (request.operation === "restore") {
      const saved = readDocumentWindows(app, item.id);
      const generation = this.generations.get(item.id) ?? 0;
      for (const id of new Set(request.ids)) {
        if (generation !== (this.generations.get(item.id) ?? 0)) break;
        if (!Object.hasOwn(saved, id) || saved[id]?.open !== false) await this.open(app, item, gateway, id, false);
      }
    }
    if ("id" in request) {
      const record = this.records.get(`${item.id}:${request.id}`);
      if (record && !record.window.isDestroyed()) {
        if (request.operation === "close") record.window.close();
        if (request.operation === "minimize") record.window.minimize();
        if (request.operation === "update") {
          if (request.title !== undefined) record.window.setTitle(request.title || item.label);
          if (request.color) { record.preference.color = request.color; record.window.setBackgroundColor(request.color); }
          if (request.alwaysOnTop !== undefined) this.setTop(record, request.alwaysOnTop);
          this.persist(record);
        }
      }
    }
    return { platform: process.platform, windows: [...this.records.values()]
      .filter(record => record.webappId === item.id && !record.window.isDestroyed())
      .map(record => ({ id: record.id, open: true, alwaysOnTop: record.window.isAlwaysOnTop() })) };
  }

  closeAll(webappId?: string) {
    const ids = new Set([...this.records.values()].filter(record => !webappId || record.webappId === webappId).map(record => record.webappId));
    if (webappId) ids.add(webappId);
    for (const id of ids) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const record of [...this.records.values()]) {
      if (webappId && record.webappId !== webappId) continue;
      record.forced = true;
      this.remember(record);
      record.window.destroy();
    }
  }

  getWindow(webappId: string, id: string) { return this.records.get(`${webappId}:${id}`)?.window ?? null; }
}
