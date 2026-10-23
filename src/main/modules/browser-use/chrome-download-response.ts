import type { CDPSession, Page } from "playwright-core";
import type { ChromeWorkerTab } from "./chrome-worker-contract";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 20_000;
type Header = { name: string; value: string };
type PausedResponse = { requestId: string; resourceType: string; request: { url: string };
  responseStatusCode?: number; responseStatusText?: string; responseHeaders?: Header[] };
export type ResponseDownloadInfo = { pageId: string; fileName: string; mimeType: string };
export type ResponseDownloadTicket = {
  reserve(bytes: number): void;
  complete(buffer: Buffer): void;
  fail(code: "file_transfer_limit" | "download_failed"): void;
};
type Pending = { id: string; settled: boolean; handle?: string; ticket?: ResponseDownloadTicket; settling?: Promise<void> };
type State = { tab: ChromeWorkerTab; session?: Pick<CDPSession, "send" | "on" | "off" | "detach">; ready: Promise<void>; closed: boolean;
  pending: Set<Pending>; listener: (event: PausedResponse) => void; onClose: () => void; releasing?: Promise<void> };

function captureError(code: string): Error & { code: string } {
  return Object.assign(new Error("The HTTP attachment could not be imported safely."), { code });
}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(captureError("download_failed")), Math.max(1, timeoutMs));
  })]); } finally { clearTimeout(timer); }
}
function attachmentName(disposition: string): string {
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/iu.exec(disposition);
  const value = extended?.[1] ?? extended?.[2];
  if (value) {
    const encoded = /^UTF-8'[^']*'(.*)$/iu.exec(value.trim());
    if (encoded) { try { return decodeURIComponent(encoded[1]).slice(0, 1000); } catch { /* Fall through to filename. */ } }
  }
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/iu.exec(disposition);
  return (ordinary?.[1]?.replace(/\\(.)/gu, "$1") ?? ordinary?.[2]?.trim() ?? "download.bin").slice(0, 1000);
}

/** Official-extension-only capture. The relay cannot provide Browser.download*.
 * Fetch/IO operate on the original authorized Page response, never a second URL request. */
export class ChromeDownloadResponseCapture {
  private readonly states = new Map<Page, State>();
  private closed = false;
  private stopping?: Promise<void>;
  constructor(private readonly begin: (info: ResponseDownloadInfo) => ResponseDownloadTicket | undefined) {}

  prepare(tab: ChromeWorkerTab): Promise<void> {
    if (this.closed) return Promise.reject(captureError("browser_disconnected"));
    const existing = this.states.get(tab.page);
    if (existing) return existing.ready;
    const state: State = { tab, closed: false, pending: new Set(), ready: Promise.resolve(),
      listener: event => { void this.paused(state, event); },
      onClose: () => { void this.release(state); } };
    this.states.set(tab.page, state);
    state.ready = (async () => {
      if (!tab.createDownloadSession) throw captureError("capability_unavailable");
      const session = await bounded(tab.createDownloadSession(), 3000);
      if (this.closed || state.closed) { await session.detach().catch(() => {}); throw captureError("browser_disconnected"); }
      state.session = session;
      session.on("Fetch.requestPaused", state.listener);
      tab.page.once("close", state.onClose);
      await bounded(session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] }), 3000);
      if (this.closed || state.closed) throw captureError("browser_disconnected");
    })().catch(async error => { await this.release(state); throw error; });
    return state.ready;
  }

  private async settle(state: State, pending: Pending, kind: "continue" | "fail" | "fulfill", response?: {
    code: number; phrase?: string; headers: Header[]; body: Buffer;
  }): Promise<void> {
    if (pending.settled || !state.session) return;
    if (pending.settling) { await pending.settling.catch(() => {}); if (pending.settled) return; }
    const session = state.session;
    const operation = (async () => {
      if (kind === "continue") await bounded(session.send("Fetch.continueResponse", { requestId: pending.id }), 1000);
      else if (kind === "fail") await bounded(session.send("Fetch.failRequest", { requestId: pending.id, errorReason: "Aborted" }), 1000);
      else if (response) await bounded(session.send("Fetch.fulfillRequest", {
        requestId: pending.id, responseCode: response.code, responsePhrase: response.phrase,
        responseHeaders: response.headers, body: response.body.toString("base64"),
      }), 5000);
      pending.settled = true;
    })();
    pending.settling = operation;
    try { await operation; } finally { if (pending.settling === operation) pending.settling = undefined; }
  }

  private async paused(state: State, event: PausedResponse): Promise<void> {
    const pending: Pending = { id: event.requestId, settled: false };
    state.pending.add(pending);
    let consumed = false;
    try {
      if (this.closed || state.closed) { await this.settle(state, pending, "fail"); return; }
      let url: URL;
      try { url = new URL(event.request.url); } catch { await this.settle(state, pending, "continue"); return; }
      const headers = event.responseHeaders ?? [];
      const disposition = headers.find(header => header.name.toLowerCase() === "content-disposition")?.value ?? "";
      if (event.resourceType !== "Document" || !["http:", "https:"].includes(url.protocol)
        || !/^\s*attachment(?:\s*;|\s*$)/iu.test(disposition)
        || !event.responseStatusCode || event.responseStatusCode < 200 || event.responseStatusCode >= 300) {
        await this.settle(state, pending, "continue"); return;
      }
      const mime = (headers.find(header => header.name.toLowerCase() === "content-type")?.value ?? "application/octet-stream").split(";", 1)[0].trim();
      pending.ticket = this.begin({ pageId: state.tab.desktopPageId, fileName: attachmentName(disposition),
        mimeType: /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mime) ? mime : "application/octet-stream" });
      if (!pending.ticket) { await this.settle(state, pending, "fail"); return; }
      const declared = headers.find(header => header.name.toLowerCase() === "content-length")?.value;
      if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_FILE_BYTES) throw captureError("file_transfer_limit");
      const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
      const session = state.session!;
      const result = await bounded(session.send("Fetch.takeResponseBodyAsStream", { requestId: pending.id }), CAPTURE_TIMEOUT_MS);
      pending.handle = result.stream; consumed = true;
      const chunks: Buffer[] = []; let size = 0;
      for (;;) {
        if (this.closed || state.closed) throw captureError("browser_disconnected");
        const chunk = await bounded(session.send("IO.read", { handle: pending.handle, size: READ_BYTES }), deadline - Date.now());
        if (this.closed || state.closed) throw captureError("browser_disconnected");
        const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (size + buffer.length > MAX_FILE_BYTES) throw captureError("file_transfer_limit");
        pending.ticket.reserve(buffer.length);
        size += buffer.length; chunks.push(buffer);
        if (chunk.eof) break;
      }
      await bounded(session.send("IO.close", { handle: pending.handle }), 1000).catch(() => {});
      pending.handle = undefined;
      const buffer = Buffer.concat(chunks, size);
      if (this.closed || state.closed) throw captureError("browser_disconnected");
      // Fetch exposes decoded entity bytes. Rebuild framing headers for those
      // same bytes; preserving a gzip/transfer encoding would corrupt the replay.
      const replayHeaders = headers.filter(header => !["content-length", "content-encoding", "transfer-encoding"].includes(header.name.toLowerCase()));
      replayHeaders.push({ name: "Content-Length", value: String(size) });
      await this.settle(state, pending, "fulfill", { code: event.responseStatusCode,
        phrase: event.responseStatusText, headers: replayHeaders, body: buffer });
      if (this.closed || state.closed) throw captureError("browser_disconnected");
      pending.ticket.complete(buffer);
    } catch (error) {
      pending.ticket?.fail((error as { code?: string }).code === "file_transfer_limit" ? "file_transfer_limit" : "download_failed");
      // Once the stream was taken, continueResponse is invalid. Fail the
      // original request; never replay it or issue a second authenticated fetch.
      await this.settle(state, pending, pending.ticket || consumed ? "fail" : "continue").catch(() => {});
    } finally {
      if (pending.handle && state.session) await bounded(state.session.send("IO.close", { handle: pending.handle }), 1000).catch(() => {});
      state.pending.delete(pending);
    }
  }

  private release(state: State): Promise<void> {
    if (state.releasing) return state.releasing;
    state.closed = true;
    state.tab.page.off("close", state.onClose);
    state.session?.off("Fetch.requestPaused", state.listener);
    const pending = [...state.pending];
    for (const entry of pending) entry.ticket?.fail("download_failed");
    state.releasing = (async () => {
      await Promise.allSettled(pending.map(async entry => {
        await bounded(this.settle(state, entry, "fail"), 1000).catch(() => {});
        if (entry.handle && state.session) await bounded(state.session.send("IO.close", { handle: entry.handle }), 500).catch(() => {});
      }));
      if (state.session) {
        await bounded(state.session.send("Fetch.disable"), 500).catch(() => {});
        await bounded(state.session.detach(), 500).catch(() => {});
      }
      this.states.delete(state.tab.page);
    })();
    return state.releasing;
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = Promise.allSettled([...this.states.values()].map(state => this.release(state))).then(() => {});
    return this.stopping;
  }
}
