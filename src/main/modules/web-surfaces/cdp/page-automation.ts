import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMain, Session, WebContents } from "electron";
import type { BrowserObservedDialog, BrowserObservedDownload, BrowserObservedFileChooser } from "../../../../shared/browser-use";
import {
  BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_DOWNLOAD_MAX_FILES, BROWSER_FILE_MAX_BYTES, decodeBrowserUploadFiles, mimeTypeForName, safeDownloadName, transferError,
} from "../../../support/browser-files/transfer";
import { WorkPanelPageDialogs } from "./page-dialogs";
import type { SiteControlScope } from "./site-scope";

const PROTOCOL_VERSION = "1.3";
/** File choosers keep the existing bounded agent interaction window. */
const AGENT_WINDOW_MS = 30_000;
const DOWNLOAD_WINDOW_MS = 10_000;

type Dialog = BrowserObservedDialog;
type Chooser = BrowserObservedFileChooser & { backendNodeId: number };
type Download = { info: BrowserObservedDownload; filePath: string; mimeType: string; reservedBytes: number; signal?: AbortSignal; dispose(): void };
type DownloadWindow = { until: number; signal?: AbortSignal; dispose(): void };
type PageState = {
  contents: WebContents;
  attached: boolean;
  attaching?: Promise<void>;
  intercepting: boolean;
  agentUntil: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  dialogs: Map<string, Dialog>;
  choosers: Map<string, Chooser>;
  downloads: Map<string, Download>;
  downloadWindow?: DownloadWindow;
  downloadNotice?: BrowserObservedDownload;
  listeners: Set<() => void>;
  directory?: string;
  focusLeases: number;
  restoreFocus?: () => Promise<unknown>;
  restoringFocus?: Promise<void>;
  dispose: () => void;
};

export type PageModalState = { dialogs: BrowserObservedDialog[]; fileChoosers: BrowserObservedFileChooser[]; downloads: BrowserObservedDownload[] };

function automationError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Keeps one debugger session per agent-operated WorkPanel guest so native dialogs, file choosers and
 * downloads reach the Run that caused them. Authorized main-frame input uses the fixed synchronous
 * dialog bridge; other native dialogs remain user-owned. No model-supplied path or script is accepted.
 */
export class WorkPanelPageAutomation {
  private readonly pages = new Map<number, PageState>();
  private readonly sessions = new WeakSet<Session>();
  private readonly pageDialogs?: WorkPanelPageDialogs;

  constructor(private readonly logger: Pick<Console, "debug" | "warn"> = console, ipc?: Pick<IpcMain, "on">) {
    if (ipc) this.pageDialogs = new WorkPanelPageDialogs(ipc, {
      opened: (contents, dialogId, type, message) => {
        const state = this.state(contents);
        state.dialogs.set(dialogId, { dialogId, type, message });
        this.logger.debug("[desktop-cdp] dialog-opening", { webContentsId: contents.id, dialogId, type, hasBrowserHandler: false });
        for (const listener of [...state.listeners]) listener();
      },
      closed: (contents, dialogId, result, reason) => {
        const state = this.pages.get(contents.id), dialog = state?.dialogs.get(dialogId);
        state?.dialogs.delete(dialogId);
        this.logger.debug("[desktop-cdp] dialog-closed", { webContentsId: contents.id, dialogId, type: dialog?.type,
          result, handledByAgent: reason === "agent" });
        if (state) void this.restoreFocus(state);
      },
    });
  }

  beginInput(contents: WebContents, scope: SiteControlScope, tab: { tabId: string; webContentsId: number }, signal?: AbortSignal, ownsScope = false) {
    return this.pageDialogs?.begin(contents, scope, tab, signal, ownsScope);
  }

  retainsScope(scope: SiteControlScope) { return this.pageDialogs?.retains(scope) === true; }

  dispose() {
    this.pageDialogs?.dispose();
    for (const state of [...this.pages.values()]) state.dispose();
  }

  /** Called before every agent command on a WorkPanel guest. */
  async prepare(contents: WebContents): Promise<void> {
    const state = this.state(contents);
    state.agentUntil = Date.now() + AGENT_WINDOW_MS;
    this.scheduleIdle(state);
    this.watchDownloads(contents);
    if (!state.attached) {
      state.attaching ??= this.attach(state).finally(() => { state.attaching = undefined; });
      await state.attaching;
    }
    await this.restoreFocus(state);
    if (!state.intercepting && state.attached && !this.pendingModal(contents)) {
      await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
      state.intercepting = true;
    }
  }

  /** Only a validated click may opt into the first attachment; observing never arms this window. */
  armDownload(contents: WebContents, signal?: AbortSignal): void {
    const state = this.state(contents);
    state.downloadWindow?.dispose();
    state.downloadWindow = undefined;
    if (signal?.aborted) return;
    state.downloadNotice = undefined;
    let timer: ReturnType<typeof setTimeout>;
    const window: DownloadWindow = { until: Date.now() + DOWNLOAD_WINDOW_MS, signal, dispose: () => {
      clearTimeout(timer); signal?.removeEventListener("abort", window.dispose);
      if (state.downloadWindow === window) state.downloadWindow = undefined;
    } };
    state.downloadWindow = window;
    signal?.addEventListener("abort", window.dispose, { once: true });
    timer = setTimeout(window.dispose, DOWNLOAD_WINDOW_MS); timer.unref?.();
    this.watchDownloads(contents);
  }

  /** Focus belongs to an input transaction. Native dialogs defer cleanup until Chromium can answer it. */
  async acquireFocus(contents: WebContents, setFocus: (enabled: boolean) => Promise<unknown>): Promise<() => Promise<void>> {
    const state = this.state(contents);
    await this.restoreFocus(state);
    const pending = this.pendingModal(contents);
    if (pending) throw pending;
    let released = false;
    state.focusLeases++;
    const release = async () => {
      if (released) return;
      released = true;
      state.focusLeases = Math.max(0, state.focusLeases - 1);
      await this.restoreFocus(state);
    };
    // An interrupted enable can still take effect when the dialog closes, so retain its cleanup first.
    if (state.focusLeases === 1) {
      state.restoreFocus = () => setFocus(false);
      try { await this.raceModal(contents, setFocus(true)); }
      catch (error) { await release(); throw error; }
    }
    return release;
  }

  private async restoreFocus(state: PageState): Promise<void> {
    if (state.restoringFocus) return state.restoringFocus;
    if (!state.restoreFocus || state.focusLeases || state.dialogs.size || state.choosers.size || state.contents.isDestroyed()) return;
    const restore = state.restoreFocus;
    const restoring = Promise.resolve().then(() => this.raceModal(state.contents, restore())).then(() => {
      if (state.restoreFocus === restore) state.restoreFocus = undefined;
    }, () => {
      // Cleanup cannot erase a completed/unknown input result. Keep it pending for the next host command or idle cleanup.
      this.logger.warn("[desktop-cdp] focus-cleanup-pending", { webContentsId: state.contents.id, reason: "command_failed" });
    });
    state.restoringFocus = restoring;
    try { await restoring; }
    finally { if (state.restoringFocus === restoring) state.restoringFocus = undefined; }
  }

  modalState(contents: WebContents): PageModalState | undefined {
    const state = this.pages.get(contents.id);
    if (!state || state.contents !== contents) return undefined;
    return {
      dialogs: [...state.dialogs.values()].map((dialog) => ({ ...dialog })),
      fileChoosers: [...state.choosers.values()].map(({ backendNodeId: _node, ...chooser }) => chooser),
      downloads: [...state.downloads.values()].filter(download => !download.signal?.aborted).map((download) => ({ ...download.info }))
        .concat(state.downloadNotice ? [{ ...state.downloadNotice }] : []),
    };
  }

  pendingModal(contents: WebContents): (Error & { code: string }) | undefined {
    const state = this.pages.get(contents.id);
    if (!state || state.contents !== contents) return undefined;
    if (state.dialogs.size) return automationError("dialog_pending", "Observe and handle the pending dialog before another page action.");
    if (state.choosers.size) return automationError("file_chooser_pending", "Observe and complete the pending file chooser before another page action.");
    return undefined;
  }

  /**
   * A native dialog blocks the command that opened it until it is answered. The command keeps running
   * in Chromium, but the caller is released so the dialog can be observed and handled.
   */
  raceModal<T>(contents: WebContents, work: Promise<T>): Promise<T> {
    const state = this.pages.get(contents.id);
    if (!state || state.contents !== contents) return work;
    const pending = state.dialogs.size ? this.pendingModal(contents) : undefined;
    if (pending) { work.catch(() => undefined); return Promise.reject(pending); }
    work.catch(() => undefined);
    let listener: () => void = () => undefined;
    const opened = new Promise<never>((_resolve, reject) => {
      listener = () => { const pending = this.pendingModal(contents); if (pending) reject(pending); };
      state.listeners.add(listener);
    });
    opened.catch(() => undefined);
    return Promise.race([work, opened]).finally(() => state.listeners.delete(listener));
  }

  async handleDialog(contents: WebContents, dialogId: string, accept: boolean, promptText: string | undefined) {
    const state = this.pages.get(contents.id);
    const dialog = state?.contents === contents ? state.dialogs.get(dialogId) : undefined;
    if (!state || !dialog) throw automationError("stale_observation", "This dialog is no longer pending on the observed page.");
    if (promptText !== undefined && (!accept || dialog.type !== "prompt")) throw automationError("invalid_params", "promptText is only valid when accepting a prompt.");
    if (!this.pageDialogs?.handle(contents, dialogId, accept, promptText)) {
      throw automationError("capability_unavailable", "This native dialog must be handled by the user. WorkPanel can answer main-frame dialogs intercepted during an authorized input transaction; child-frame and beforeunload dialogs keep their native user flow.");
    }
    state.dialogs.delete(dialogId);
    await this.restoreFocus(state);
    return { status: "handled", action: accept ? "accept" : "dismiss", dialogId };
  }

  chooser(contents: WebContents, chooserId: string): Chooser {
    const state = this.pages.get(contents.id);
    const chooser = state?.contents === contents ? state.choosers.get(chooserId) : undefined;
    if (!chooser) throw automationError("stale_observation", "This file chooser is no longer pending on the observed page.");
    return chooser;
  }

  completeChooser(contents: WebContents, chooserId: string) {
    const state = this.pages.get(contents.id);
    if (state) { state.choosers.delete(chooserId); void this.restoreFocus(state); }
  }

  /** Writes Platform-authorized bytes to a private directory; the page keeps reading them until it closes. */
  writeUploads(contents: WebContents, files: unknown): string[] {
    const decoded = decodeBrowserUploadFiles(files);
    const state = this.state(contents);
    const directory = path.join(this.directory(state), "uploads", randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return decoded.map((file) => {
      const target = path.join(directory, file.name);
      fs.writeFileSync(target, file.buffer, { mode: 0o600 });
      return target;
    });
  }

  listDownloads(contents: WebContents): BrowserObservedDownload[] {
    return this.modalState(contents)?.downloads ?? [];
  }

  async readDownload(contents: WebContents, downloadId: string) {
    const state = this.pages.get(contents.id);
    const download = state?.contents === contents ? state.downloads.get(downloadId) : undefined;
    if (!state || !download || download.signal?.aborted) throw transferError("download_not_found", "This page does not own that download.");
    if (download.info.status === "pending") throw transferError("download_not_ready", "The download is still in progress. Check its status before saving.");
    if (download.info.status !== "complete") throw transferError("download_failed", "This download could not be imported into the Chat.");
    const buffer = await fs.promises.readFile(download.filePath);
    if (buffer.length > BROWSER_FILE_MAX_BYTES) throw transferError("file_transfer_limit", "The download exceeds the transfer limit.");
    if (this.pages.get(contents.id) !== state || state.downloads.get(downloadId) !== download || download.signal?.aborted)
      throw transferError("download_not_found", "This page no longer owns that download.");
    return { downloadId, fileName: download.info.fileName, mimeType: download.mimeType, data: buffer.toString("base64"),
      sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
  }

  /** Platform acknowledges only bytes it has validated and persisted as a Chat file. */
  async releaseDownload(contents: WebContents, downloadId: string, sha256: string): Promise<{ released: true }> {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw transferError("invalid_params", "A lowercase SHA-256 digest is required.");
    const state = this.pages.get(contents.id), download = state?.contents === contents ? state.downloads.get(downloadId) : undefined;
    if (!download) return { released: true };
    const file = await this.readDownload(contents, downloadId);
    if (file.sha256 !== sha256) throw transferError("download_digest_mismatch", "The persisted file digest does not match this download.");
    fs.rmSync(path.dirname(download.filePath), { recursive: true, force: true });
    download.dispose();
    return { released: true };
  }

  private state(contents: WebContents): PageState {
    const existing = this.pages.get(contents.id);
    if (existing?.contents === contents) return existing;
    existing?.dispose();
    const debuggerRef = contents.debugger;
    let disposed = false;
    const state: PageState = {
      contents, attached: false, intercepting: false, agentUntil: 0, focusLeases: 0,
      dialogs: new Map(), choosers: new Map(), downloads: new Map(), listeners: new Set(),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.pageDialogs?.cancel(contents, true);
        clearTimeout(state.idleTimer);
        // A queued cleanup is safe even while a modal is open: never await it during teardown.
        if (state.restoreFocus && !contents.isDestroyed() && debuggerRef.isAttached()) {
          const restore = state.restoreFocus; state.restoreFocus = undefined;
          void Promise.resolve().then(restore).catch(() => undefined);
        }
        if (this.pages.get(contents.id) === state) this.pages.delete(contents.id);
        state.downloadWindow?.dispose();
        for (const download of [...state.downloads.values()]) download.dispose();
        for (const remove of [
          () => debuggerRef.off("message", onMessage),
          () => debuggerRef.off("detach", onDetach),
          () => contents.off("destroyed", state.dispose),
        ]) { try { remove(); } catch { /* Native teardown can finish first. */ } }
        if (state.directory) fs.rmSync(state.directory, { recursive: true, force: true });
      },
    };
    const notify = () => { for (const listener of [...state.listeners]) listener(); };
    const onMessage = (_event: unknown, method: string, params: Record<string, any> = {}) => {
      if (method === "Page.javascriptDialogOpening") {
        if (!["alert", "confirm", "prompt", "beforeunload"].includes(params.type)) return;
        const dialogId = randomUUID();
        state.dialogs.set(dialogId, { dialogId, type: params.type, message: String(params.message ?? "").slice(0, 1000) });
        this.logger.debug("[desktop-cdp] dialog-opening", {
          webContentsId: contents.id, dialogId, type: params.type, hasBrowserHandler: params.hasBrowserHandler === true,
        });
        notify();
      } else if (method === "Page.javascriptDialogClosed") {
        for (const dialog of state.dialogs.values()) this.logger.debug("[desktop-cdp] dialog-closed", {
          webContentsId: contents.id, dialogId: dialog.dialogId, type: dialog.type,
          result: params.result === true, handledByAgent: false,
        });
        state.dialogs.clear();
        void this.restoreFocus(state);
      } else if (method === "Page.fileChooserOpened" && Number.isInteger(params.backendNodeId)) {
        const chooserId = randomUUID();
        state.choosers.set(chooserId, { chooserId, multiple: params.mode === "selectMultiple", backendNodeId: params.backendNodeId });
        notify();
      } else if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
        state.choosers.clear();
      }
    };
    // Another owner detaching the debugger ends this session; the next agent command attaches again.
    const onDetach = (_event: unknown, reason: unknown) => {
      this.logger.debug("[desktop-cdp] page-automation-detached", {
        webContentsId: contents.id, reason: typeof reason === "string" ? reason.slice(0, 80) : "unknown",
        dialogIds: [...state.dialogs.keys()],
      });
      this.pageDialogs?.cancel(contents);
      state.restoreFocus = undefined; state.focusLeases = 0; state.attached = false; state.intercepting = false;
      state.dialogs.clear(); state.choosers.clear();
    };
    debuggerRef.on("message", onMessage);
    debuggerRef.on("detach", onDetach);
    contents.once("destroyed", state.dispose);
    this.pages.set(contents.id, state);
    return state;
  }

  private async attach(state: PageState) {
    const debuggerRef = state.contents.debugger;
    if (!debuggerRef.isAttached()) debuggerRef.attach(PROTOCOL_VERSION);
    await debuggerRef.sendCommand("Page.enable");
    state.attached = true;
  }

  /** Users get their own native file picker back once the agent stops operating the page. */
  private scheduleIdle(state: PageState) {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      void this.restoreFocus(state);
      if (state.dialogs.size || state.choosers.size || !state.intercepting || state.contents.isDestroyed()) return;
      state.intercepting = false;
      void state.contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
    }, AGENT_WINDOW_MS);
    state.idleTimer.unref?.();
  }

  private directory(state: PageState) {
    state.directory ??= fs.mkdtempSync(path.join(os.tmpdir(), "desktop-workpanel-browser-"));
    return state.directory;
  }

  private watchDownloads(contents: WebContents) {
    const guestSession = contents.session;
    if (!guestSession || this.sessions.has(guestSession)) return;
    this.sessions.add(guestSession);
    guestSession.on("will-download", (_event, item, source) => {
      const state = source ? this.pages.get(source.id) : undefined;
      const capture = state?.downloadWindow;
      // Ordinary preparation, observation and user downloads never opt in.
      if (!state || state.contents !== source || !capture) return;
      capture.dispose();
      if (capture.signal?.aborted || Date.now() > capture.until) return;
      const downloadId = randomUUID();
      const fileName = safeDownloadName(item.getFilename());
      const notice = (error: string) => {
        if (this.pages.get(source.id) === state && !capture.signal?.aborted)
          state.downloadNotice = { downloadId, fileName, status: "failed", error };
      };
      const declaredBytes = item.getTotalBytes();
      if (state.downloads.size >= BROWSER_DOWNLOAD_MAX_FILES) { notice("file_transfer_limit"); return; }
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) { notice("download_failed"); return; }
      if (declaredBytes > BROWSER_FILE_MAX_BYTES) { notice("file_transfer_limit"); return; }
      const retained = () => [...state.downloads.values()].reduce((total, entry) => total + entry.reservedBytes, 0);
      if (retained() + declaredBytes > BROWSER_DOWNLOAD_MAX_BYTES) {
        notice("file_transfer_limit"); return;
      }
      let directory: string;
      try { directory = path.join(this.directory(state), "downloads", downloadId); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
      catch { notice("download_failed"); return; }
      const filePath = path.join(directory, fileName);
      try { item.setSavePath(filePath); }
      catch { fs.rmSync(directory, { recursive: true, force: true }); notice("download_failed"); return; }
      let finished = false, discarded = false;
      const cleanup = () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Native teardown may still be closing the file. */ } };
      const discard = () => {
        discarded = true;
        if (state.downloads.get(downloadId) === download) state.downloads.delete(downloadId);
        capture.signal?.removeEventListener("abort", discard);
        if (finished) cleanup();
      };
      const download: Download = { info: { downloadId, fileName, status: "pending" }, filePath,
        mimeType: item.getMimeType() || mimeTypeForName(fileName), reservedBytes: declaredBytes, signal: capture.signal, dispose: discard };
      state.downloads.set(downloadId, download);
      const fail = (error: string) => { notice(error); discard(); };
      const updated = () => {
        if (discarded || capture.signal?.aborted || this.pages.get(source.id) !== state) { discard(); return; }
        const received = item.getReceivedBytes(), total = item.getTotalBytes();
        if (!Number.isSafeInteger(received) || received < 0 || received > BROWSER_FILE_MAX_BYTES || total > BROWSER_FILE_MAX_BYTES) { fail("file_transfer_limit"); return; }
        download.reservedBytes = Math.max(download.reservedBytes, received);
        if (retained() > BROWSER_DOWNLOAD_MAX_BYTES) fail("file_transfer_limit");
      };
      capture.signal?.addEventListener("abort", discard, { once: true });
      item.on("updated", updated);
      item.once("done", (_doneEvent, outcome) => {
        finished = true; item.off("updated", updated);
        if (discarded || capture.signal?.aborted || this.pages.get(source.id) !== state) { discard(); return; }
        if (outcome !== "completed") { fail("download_failed"); return; }
        let sizeBytes: number;
        try { sizeBytes = fs.statSync(filePath).size; } catch { fail("download_failed"); return; }
        if (sizeBytes > BROWSER_FILE_MAX_BYTES) { fail("file_transfer_limit"); return; }
        download.reservedBytes = sizeBytes;
        if (retained() > BROWSER_DOWNLOAD_MAX_BYTES) { fail("file_transfer_limit"); return; }
        download.info = { ...download.info, status: "complete", sizeBytes };
      });
      if (capture.signal?.aborted) discard();
    });
  }
}
