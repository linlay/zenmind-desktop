import { createHash, randomUUID } from "node:crypto";
import type { Download } from "playwright-core";
import type { BrowserObservedDownload } from "../../../shared/browser-use";
import type { ChromeWorkerTab } from "./chrome-worker-contract";
import { ChromeDownloadResponseCapture, type ResponseDownloadInfo, type ResponseDownloadTicket } from "./chrome-download-response";

export {
  BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_DOWNLOAD_MAX_FILES, BROWSER_FILE_MAX_BYTES, BROWSER_UPLOAD_MAX_BYTES, BROWSER_UPLOAD_MAX_FILES,
  decodeBrowserUploadFiles,
} from "../../support/browser-files/transfer";
import {
  BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_DOWNLOAD_MAX_FILES, BROWSER_FILE_MAX_BYTES, mimeTypeForName, safeDownloadName, transferError,
} from "../../support/browser-files/transfer";

type Entry = { pageId: string; info: BrowserObservedDownload; mimeType: string; reserved: number; buffer?: Buffer; sha256?: string };
type WatchedPage = { tab: ChromeWorkerTab; onDownload: (download: Download) => void; onClose: () => void };
type Window = { timer: ReturnType<typeof setTimeout> };

/** A Run owns bounded copies, not browser downloads. Persistence acknowledgement frees their capacity. */
export class ChromeTransferStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<ChromeWorkerTab["page"], WatchedPage>();
  private readonly capacityFailures = new Map<string, BrowserObservedDownload>();
  private readonly seen = new WeakSet<Download>();
  private readonly windows = new Map<ChromeWorkerTab["page"], Window>();
  private readonly nativeTasks = new Set<Promise<void>>();
  private readonly responsePages = new WeakSet<ChromeWorkerTab["page"]>();
  private readonly responses = new ChromeDownloadResponseCapture(info => this.beginResponse(info));
  private retainedBytes = 0;
  private generation = 0;
  private closed = false;

  /** Arm one attachment for an explicit download action; observation and ordinary clicks never call this. */
  async prepare(tab: ChromeWorkerTab): Promise<void> {
    if (this.closed) throw transferError("browser_disconnected", "Browser control was released.");
    const generation = this.generation;
    this.watch(tab);
    if (tab.createDownloadSession) {
      this.responsePages.add(tab.page);
      await this.responses.prepare(tab);
      if (this.closed || generation !== this.generation || !this.listeners.has(tab.page))
        throw transferError("cancelled", "The download capture ended before it was prepared.");
    } else {
      if (this.windows.has(tab.page)) throw transferError("download_capture_busy", "An earlier download action is still awaiting its attachment.");
      const timer = setTimeout(() => this.clearWindow(tab.page), 10_000);
      timer.unref?.(); this.windows.set(tab.page, { timer });
    }
  }

  private clearWindow(page: ChromeWorkerTab["page"]) {
    const window = this.windows.get(page);
    if (window) clearTimeout(window.timer);
    this.windows.delete(page);
  }

  private removeEntry(entry: Entry) {
    if (this.entries.get(entry.info.downloadId) !== entry) return;
    this.entries.delete(entry.info.downloadId);
    this.retainedBytes -= entry.reserved; entry.reserved = 0;
    entry.buffer = undefined; entry.sha256 = undefined;
  }

  private failure(info: ResponseDownloadInfo, code: string, downloadId = randomUUID()) {
    this.capacityFailures.set(info.pageId, { downloadId, fileName: safeDownloadName(info.fileName), status: "failed", error: code });
    if (this.capacityFailures.size > 100) this.capacityFailures.delete(this.capacityFailures.keys().next().value!);
  }

  private beginResponse(info: ResponseDownloadInfo): ResponseDownloadTicket | undefined {
    if (this.closed) return;
    if (this.entries.size >= BROWSER_DOWNLOAD_MAX_FILES) { this.failure(info, "file_transfer_limit"); return; }
    const downloadId = randomUUID();
    const entry: Entry = { pageId: info.pageId, mimeType: info.mimeType, reserved: 0,
      info: { downloadId, fileName: safeDownloadName(info.fileName), status: "pending" } };
    this.entries.set(downloadId, entry);
    let finished = false;
    const live = () => !this.closed && this.entries.get(downloadId) === entry;
    return {
      reserve: bytes => {
        if (!live() || finished) throw transferError("browser_disconnected", "The download capture was released.");
        if (!Number.isSafeInteger(bytes) || bytes < 0 || entry.reserved + bytes > BROWSER_FILE_MAX_BYTES
          || this.retainedBytes + bytes > BROWSER_DOWNLOAD_MAX_BYTES)
          throw transferError("file_transfer_limit", "The download exceeds the available import budget; its browser download continues.");
        entry.reserved += bytes; this.retainedBytes += bytes;
      },
      complete: buffer => {
        if (!live() || finished) return;
        if (buffer.length !== entry.reserved) {
          finished = true; this.removeEntry(entry); this.failure(info, "download_failed", downloadId); return;
        }
        finished = true; entry.buffer = buffer;
        entry.sha256 = createHash("sha256").update(buffer).digest("hex");
        entry.info = { ...entry.info, status: "complete", sizeBytes: buffer.length };
      },
      fail: code => {
        if (!live() || finished) return;
        finished = true; this.removeEntry(entry); this.failure(info, code, downloadId);
      },
    };
  }

  watch(tab: ChromeWorkerTab): void {
    if (this.closed || this.listeners.has(tab.page)) return;
    const onDownload = (download: Download) => this.captureDownload(tab, download);
    const onClose = () => { void this.releasePage(tab.desktopPageId); };
    this.listeners.set(tab.page, { tab, onDownload, onClose });
    tab.page.on("download", onDownload); tab.page.once("close", onClose); tab.page.once("crash", onClose);
  }

  captureDownload(tab: ChromeWorkerTab, download: Download): void {
    if (this.closed || this.seen.has(download) || this.responsePages.has(tab.page) || !this.windows.has(tab.page)) return;
    this.seen.add(download); this.clearWindow(tab.page);
    const fileName = safeDownloadName(download.suggestedFilename());
    const ticket = this.beginResponse({ pageId: tab.desktopPageId, fileName, mimeType: mimeTypeForName(fileName) });
    if (!ticket) return;
    const task = this.capture(download, ticket);
    this.nativeTasks.add(task);
    void task.finally(() => this.nativeTasks.delete(task));
  }

  private async capture(download: Download, ticket: ResponseDownloadTicket): Promise<void> {
    try {
      const stream = await download.createReadStream();
      if (!stream) throw transferError("download_failed", "The browser did not provide a download stream.");
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          ticket.reserve(bytes.length); size += bytes.length; chunks.push(bytes);
        }
      } finally {
        // This is only our copy stream. Never cancel the user's original browser download.
        stream.destroy();
      }
      if (await download.failure()) throw transferError("download_failed", "The browser did not finish the download.");
      ticket.complete(Buffer.concat(chunks, size));
    } catch (error) {
      ticket.fail((error as { code?: string } | undefined)?.code === "file_transfer_limit" ? "file_transfer_limit" : "download_failed");
    }
  }

  list(pageId: string): BrowserObservedDownload[] {
    const result = [...this.entries.values()].filter(entry => entry.pageId === pageId).map(entry => ({ ...entry.info }));
    const failure = this.capacityFailures.get(pageId);
    if (failure) result.push({ ...failure });
    return result;
  }

  async read(pageId: string, downloadId: string): Promise<{
    downloadId: string; fileName: string; mimeType: string; data: string; sizeBytes: number; sha256: string;
  }> {
    if (this.closed) throw transferError("browser_disconnected", "Browser control was released.");
    const failure = this.capacityFailures.get(pageId);
    if (failure?.downloadId === downloadId) throw transferError(failure.error ?? "download_failed", "This download could not be imported; the browser download was preserved.");
    const entry = this.entries.get(downloadId);
    if (!entry || entry.pageId !== pageId) throw transferError("download_not_found", "This page does not own that download.");
    if (entry.info.status === "pending") throw transferError("download_not_ready", "The download is still in progress. Check its status before saving.");
    if (!entry.buffer || !entry.sha256) throw transferError("download_failed", "This download could not be imported into the Chat.");
    return { downloadId, fileName: entry.info.fileName, mimeType: entry.mimeType, data: entry.buffer.toString("base64"),
      sizeBytes: entry.buffer.length, sha256: entry.sha256 };
  }

  releaseDownload(pageId: string, downloadId: string, sha256: string): { released: true; downloadId: string; sha256: string } {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw transferError("invalid_params", "A verified download digest is required.");
    const entry = this.entries.get(downloadId);
    if (entry) {
      if (entry.pageId !== pageId) throw transferError("download_not_found", "This page does not own that download.");
      if (entry.info.status !== "complete" || entry.sha256 !== sha256)
        throw transferError("download_not_ready", "Only a complete download with its verified digest may be acknowledged.");
      this.removeEntry(entry);
    }
    return { released: true, downloadId, sha256 };
  }

  cancelCapture(pageId: string): Promise<void> {
    for (const [page, state] of this.listeners) if (state.tab.desktopPageId === pageId) this.clearWindow(page);
    return this.responses.releasePage(pageId);
  }

  releasePage(pageId: string): Promise<void> {
    for (const [page, state] of this.listeners) if (state.tab.desktopPageId === pageId) {
      this.clearWindow(page);
      page.off("download", state.onDownload); page.off("close", state.onClose); page.off("crash", state.onClose);
      this.listeners.delete(page);
    }
    for (const entry of this.entries.values()) if (entry.pageId === pageId) this.removeEntry(entry);
    this.capacityFailures.delete(pageId);
    return this.responses.releasePage(pageId);
  }

  endRun(): Promise<void> {
    this.generation++;
    for (const page of this.windows.keys()) this.clearWindow(page);
    for (const entry of [...this.entries.values()]) this.removeEntry(entry);
    this.capacityFailures.clear();
    return Promise.all([this.responses.endRun(), ...this.nativeTasks]).then(() => undefined);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { tab } of [...this.listeners.values()]) void this.releasePage(tab.desktopPageId);
    void this.endRun();
    void this.responses.shutdown();
  }

  async shutdown(): Promise<void> {
    this.dispose();
    await this.endRun();
    await this.responses.shutdown();
  }
}
