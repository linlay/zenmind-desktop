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

type Entry = {
  pageId: string;
  download?: Download;
  info: BrowserObservedDownload;
  mimeType: string;
  buffer?: Buffer;
  sha256?: string;
};

/**
 * Owns only downloads emitted by authorized pages watched by this worker.
 * A completed transfer remains repeatable until disconnect; Platform reports
 * success only after copying it into the current Chat's persistent file store.
 */
export class ChromeTransferStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<ChromeWorkerTab["page"], (download: Download) => void>();
  private readonly capacityFailures = new Map<string, BrowserObservedDownload>();
  private readonly seen = new WeakSet<Download>();
  private retainedBytes = 0;
  private closed = false;
  private readonly responsePages = new WeakSet<ChromeWorkerTab["page"]>();
  private readonly responses = new ChromeDownloadResponseCapture(info => this.beginResponse(info));

  /** Called only by the official-extension adapter before a scoped operation. */
  async prepare(tab: ChromeWorkerTab): Promise<void> {
    this.watch(tab);
    this.responsePages.add(tab.page);
    await this.responses.prepare(tab);
  }

  private beginResponse(info: ResponseDownloadInfo): ResponseDownloadTicket | undefined {
    if (this.closed) return;
    const fileName = safeDownloadName(info.fileName);
    if (this.entries.size >= BROWSER_DOWNLOAD_MAX_FILES) {
      this.capacityFailures.set(info.pageId, { downloadId: randomUUID(), fileName, status: "failed", error: "file_transfer_limit" });
      if (this.capacityFailures.size > 100) this.capacityFailures.delete(this.capacityFailures.keys().next().value!);
      return;
    }
    const downloadId = randomUUID();
    const entry: Entry = { pageId: info.pageId, mimeType: info.mimeType, info: { downloadId, fileName, status: "pending" } };
    this.entries.set(downloadId, entry);
    let reserved = 0, finished = false;
    return {
      reserve: bytes => {
        if (this.closed || finished) throw transferError("browser_disconnected", "Browser control was released.");
        if (reserved + bytes > BROWSER_FILE_MAX_BYTES || this.retainedBytes + bytes > BROWSER_DOWNLOAD_MAX_BYTES)
          throw transferError("file_transfer_limit", "The download exceeds the available file transfer budget.");
        reserved += bytes; this.retainedBytes += bytes;
      },
      complete: buffer => {
        if (this.closed || finished) return;
        finished = true; entry.buffer = buffer;
        entry.sha256 = createHash("sha256").update(buffer).digest("hex");
        entry.info = { ...entry.info, status: "complete", sizeBytes: buffer.length };
      },
      fail: code => {
        if (finished) return;
        finished = true; this.retainedBytes = Math.max(0, this.retainedBytes - reserved);
        entry.buffer = undefined; entry.info = { ...entry.info, status: "failed", error: code };
      },
    };
  }

  watch(tab: ChromeWorkerTab): void {
    if (this.closed || this.listeners.has(tab.page)) return;
    const onDownload = (download: Download) => this.captureDownload(tab, download);
    this.listeners.set(tab.page, onDownload);
    tab.page.on("download", onDownload);
  }

  captureDownload(tab: ChromeWorkerTab, download: Download): void {
    if (this.closed || this.seen.has(download)) return;
    this.seen.add(download);
    // Extension response mode owns one bounded copy. A future upstream native
    // event for that same browser download must not create a second entry.
    if (this.responsePages.has(tab.page)) return;
    if (this.entries.size >= BROWSER_DOWNLOAD_MAX_FILES) {
      this.capacityFailures.set(tab.desktopPageId, {
        downloadId: randomUUID(), fileName: safeDownloadName(download.suggestedFilename()),
        status: "failed", error: "file_transfer_limit",
      });
      if (this.capacityFailures.size > 100) this.capacityFailures.delete(this.capacityFailures.keys().next().value!);
      void download.cancel().catch(() => undefined);
      return;
    }
    const fileName = safeDownloadName(download.suggestedFilename());
    const downloadId = randomUUID();
    const entry: Entry = {
      pageId: tab.desktopPageId, download, mimeType: mimeTypeForName(fileName),
      info: { downloadId, fileName, status: "pending" },
    };
    this.entries.set(downloadId, entry);
    void this.capture(entry);
  }

  private async capture(entry: Entry): Promise<void> {
    let reserved = 0;
    try {
      const stream = await entry.download!.createReadStream();
      if (!stream) throw transferError("download_failed", "The browser did not provide a download stream.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        if (this.closed) {
          stream.destroy();
          throw transferError("browser_disconnected", "The browser connection was released.");
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size + bytes.length > BROWSER_FILE_MAX_BYTES
          || this.retainedBytes + bytes.length > BROWSER_DOWNLOAD_MAX_BYTES) {
          stream.destroy();
          void entry.download?.cancel().catch(() => undefined);
          throw transferError("file_transfer_limit", "The download exceeds the available file transfer budget.");
        }
        chunks.push(bytes);
        size += bytes.length;
        reserved += bytes.length;
        this.retainedBytes += bytes.length;
      }
      if (this.closed) throw transferError("browser_disconnected", "The browser connection was released.");
      const failure = await entry.download!.failure();
      if (failure) throw transferError("download_failed", "The browser did not finish the download.");
      if (this.closed) throw transferError("browser_disconnected", "The browser connection was released.");
      entry.buffer = Buffer.concat(chunks, size);
      entry.sha256 = createHash("sha256").update(entry.buffer).digest("hex");
      entry.info = { ...entry.info, status: "complete", sizeBytes: size };
    } catch (error) {
      this.retainedBytes = Math.max(0, this.retainedBytes - reserved);
      entry.buffer = undefined;
      entry.sha256 = undefined;
      entry.info = { ...entry.info, status: "failed",
        error: (error as { code?: string }).code === "file_transfer_limit" ? "file_transfer_limit" : "download_failed" };
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
    if (this.closed) throw transferError("browser_disconnected", "The browser connection was released.");
    if (this.capacityFailures.get(pageId)?.downloadId === downloadId) {
      throw transferError("file_transfer_limit", "This connection has reached its download transfer limit.");
    }
    const entry = this.entries.get(downloadId);
    if (!entry || entry.pageId !== pageId) throw transferError("download_not_found", "This page does not own that download.");
    if (entry.info.status === "pending") throw transferError("download_not_ready", "The download is still in progress. Check its status before saving.");
    if (!entry.buffer || !entry.sha256) throw transferError("download_failed", "This download could not be imported into the Chat.");
    return { downloadId, fileName: entry.info.fileName, mimeType: entry.mimeType, data: entry.buffer.toString("base64"),
      sizeBytes: entry.buffer.length, sha256: entry.sha256 };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [page, listener] of this.listeners) {
      try { page.off("download", listener); } catch { /* Closed pages already released their native listeners. */ }
    }
    for (const entry of this.entries.values()) {
      if (entry.info.status === "pending") void entry.download?.cancel().catch(() => undefined);
      entry.buffer = undefined;
    }
    this.listeners.clear();
    this.entries.clear();
    this.capacityFailures.clear();
    this.retainedBytes = 0;
    void this.responses.shutdown();
  }

  async shutdown(): Promise<void> {
    this.dispose();
    await this.responses.shutdown();
  }
}
