import type { CDPSession, Page } from "playwright-core";
import type { ChromeWorkerTab } from "./chrome-worker-contract";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CAPTURE_WINDOW_MS = 10_000;
type Header = { name: string; value: string };
type PausedResponse = { requestId: string; resourceType: string; request: { url: string };
  responseStatusCode?: number; responseHeaders?: Header[] };
export type ResponseDownloadInfo = { pageId: string; fileName: string; mimeType: string };
export type ResponseDownloadTicket = {
  reserve(bytes: number): void;
  complete(buffer: Buffer): void;
  fail(code: "file_transfer_limit" | "download_failed"): void;
};
type State = { tab: ChromeWorkerTab; session?: Pick<CDPSession, "send" | "on" | "off" | "detach">;
  ready: Promise<void>; accepting: boolean; claimed: boolean; reading: boolean; timer?: ReturnType<typeof setTimeout>;
  tasks: Set<Promise<void>>; tickets: Set<ResponseDownloadTicket>;
  listener: (event: PausedResponse) => void; onClose: () => void; releasing?: Promise<void> };

function captureError(code: string): Error & { code: string } {
  return Object.assign(new Error("The HTTP attachment could not be imported safely; its browser download is preserved."), { code });
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

/** One explicit download action may copy one bounded response. It never owns the original body. */
export class ChromeDownloadResponseCapture {
  private readonly states = new Map<Page, State>();
  private readonly pageGenerations = new WeakMap<Page, number>();
  private generation = 0;
  private closed = false;
  private stopping?: Promise<void>;
  constructor(private readonly begin: (info: ResponseDownloadInfo) => ResponseDownloadTicket | undefined) {}

  async prepare(tab: ChromeWorkerTab): Promise<void> {
    if (this.closed) throw captureError("browser_disconnected");
    const generation = this.generation;
    const pageGeneration = this.pageGenerations.get(tab.page) ?? 0;
    const existing = this.states.get(tab.page);
    if (existing) {
      if (existing.reading || !existing.claimed && existing.accepting) throw captureError("download_capture_busy");
      await this.release(existing);
    }
    if (this.closed) throw captureError("browser_disconnected");
    if (generation !== this.generation || pageGeneration !== (this.pageGenerations.get(tab.page) ?? 0)) throw captureError("cancelled");
    if (tab.page.isClosed?.()) throw captureError("surface_not_found");
    const state: State = { tab, accepting: true, claimed: false, reading: false, tasks: new Set(), tickets: new Set(),
      ready: Promise.resolve(), listener: () => undefined, onClose: () => undefined };
    state.onClose = () => { void this.release(state); };
    state.listener = event => {
      const task = this.paused(state, event);
      state.tasks.add(task);
      void task.finally(() => {
        state.tasks.delete(task);
        if (state.claimed || !state.accepting) void this.release(state);
      });
    };
    this.states.set(tab.page, state);
    tab.page.once("close", state.onClose); tab.page.once("crash", state.onClose);
    state.ready = (async () => {
      if (!tab.createDownloadSession) throw captureError("capability_unavailable");
      const session = await tab.createDownloadSession();
      if (!state.accepting || this.closed || generation !== this.generation) {
        await session.detach().catch(() => undefined); throw captureError("cancelled");
      }
      state.session = session;
      session.on("Fetch.requestPaused", state.listener);
      await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
      if (!state.accepting || this.closed || generation !== this.generation) throw captureError("cancelled");
      state.timer = setTimeout(() => { void this.release(state); }, CAPTURE_WINDOW_MS);
      state.timer.unref?.();
    })();
    try { await state.ready; }
    catch (error) { await this.release(state); throw error; }
  }

  private async paused(state: State, event: PausedResponse): Promise<void> {
    let ticket: ResponseDownloadTicket | undefined, buffer: Buffer | undefined;
    try {
      if (!state.accepting || state.claimed || this.closed) return;
      let url: URL;
      try { url = new URL(event.request.url); } catch { return; }
      const headers = event.responseHeaders ?? [];
      const header = (name: string) => headers.filter(entry => entry.name.toLowerCase() === name);
      const disposition = header("content-disposition")[0]?.value ?? "";
      if (event.resourceType !== "Document" || !["http:", "https:"].includes(url.protocol)
        || !/^\s*attachment(?:\s*;|\s*$)/iu.test(disposition)
        || !event.responseStatusCode || event.responseStatusCode < 200 || event.responseStatusCode >= 300) return;
      state.claimed = true; clearTimeout(state.timer);
      const mime = (header("content-type")[0]?.value ?? "application/octet-stream").split(";", 1)[0].trim();
      ticket = this.begin({ pageId: state.tab.desktopPageId, fileName: attachmentName(disposition),
        mimeType: /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mime) ? mime : "application/octet-stream" });
      if (!ticket) return; // Import capacity cannot stop a browser download.
      state.tickets.add(ticket);
      if (event.responseStatusCode === 206 || header("content-range").length) throw captureError("download_failed");
      const lengths = header("content-length"), declared = lengths[0]?.value.trim();
      if (lengths.length !== 1 || !declared || !/^\d+$/u.test(declared)
        || header("content-encoding").length || header("transfer-encoding").length) throw captureError("download_failed");
      const size = Number(declared);
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw captureError("file_transfer_limit");
      ticket.reserve(size); // Reserve before receiving a copy, never after consuming an original stream.
      state.reading = true;
      const result = await state.session!.send("Fetch.getResponseBody", { requestId: event.requestId });
      state.reading = false;
      if (!state.accepting || this.closed) return;
      if (typeof result.body !== "string" || (result.base64Encoded
        ? result.body.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)
        : Buffer.byteLength(result.body, "utf8") > MAX_FILE_BYTES)) throw captureError("file_transfer_limit");
      buffer = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
      if (buffer.length !== size || result.base64Encoded && buffer.toString("base64") !== result.body) throw captureError("download_failed");
    } catch (error) {
      ticket?.fail((error as { code?: string } | undefined)?.code === "file_transfer_limit" ? "file_transfer_limit" : "download_failed");
      buffer = undefined;
    } finally {
      state.reading = false;
      // getResponseBody leaves the original response intact. Do not continue or disable Fetch
      // until that real command has settled, even when the Run has already been cancelled.
      let continued = false;
      try {
        if (state.session) { await state.session.send("Fetch.continueResponse", { requestId: event.requestId }); continued = true; }
      }
      catch { ticket?.fail("download_failed"); }
      if (buffer && continued && state.accepting && !this.closed) ticket?.complete(buffer);
      else if (ticket && (!state.accepting || this.closed)) ticket.fail("download_failed");
      if (ticket) state.tickets.delete(ticket);
    }
  }

  private release(state: State): Promise<void> {
    if (state.releasing) return state.releasing;
    state.accepting = false; clearTimeout(state.timer);
    for (const ticket of state.tickets) ticket.fail("download_failed");
    state.releasing = (async () => {
      await state.ready.catch(() => undefined);
      while (state.tasks.size) await Promise.allSettled([...state.tasks]);
      if (state.session) {
        await state.session.send("Fetch.disable").catch(() => undefined);
        while (state.tasks.size) await Promise.allSettled([...state.tasks]);
        state.session.off("Fetch.requestPaused", state.listener);
        await state.session.detach().catch(() => undefined);
      }
      state.tab.page.off("close", state.onClose); state.tab.page.off("crash", state.onClose);
      if (this.states.get(state.tab.page) === state) this.states.delete(state.tab.page);
    })();
    return state.releasing;
  }

  releasePage(pageId: string): Promise<void> {
    const states = [...this.states.values()].filter(state => state.tab.desktopPageId === pageId);
    for (const state of states) this.pageGenerations.set(state.tab.page, (this.pageGenerations.get(state.tab.page) ?? 0) + 1);
    return Promise.all(states.map(state => this.release(state))).then(() => undefined);
  }

  endRun(): Promise<void> {
    this.generation++;
    return Promise.all([...this.states.values()].map(state => this.release(state))).then(() => undefined);
  }

  shutdown(): Promise<void> {
    this.closed = true;
    this.stopping ??= this.endRun();
    return this.stopping;
  }
}
