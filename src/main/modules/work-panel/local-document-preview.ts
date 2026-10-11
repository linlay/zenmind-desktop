import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { net, session, type Session, type WebContents } from "electron";
import { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from "../../../shared/chat-work-panel";
import { type LocalDocumentItem } from "../../../shared/local-document";
import { resolveLocalFileProtocolPath } from "./local-files";
import { renderLocalMarkdownAsync } from "./local-document-render";
import { LOCAL_MARKDOWN_MAX_BYTES } from "./local-document-worker-contract";
import { t } from "../../support/i18n/main-i18n";
import { createLocalDocumentNetworkGuard, type LocalDocumentNetworkGuard } from "./local-document-network-guard";

export type LocalDocumentPreviewDependencies = {
  createSession?: (partition: string) => Session;
  fetchFile?: (url: string, method: string) => Promise<Response>;
  renderMarkdown?: typeof renderLocalMarkdownAsync;
  guardGuest?: typeof createLocalDocumentNetworkGuard;
};

/** A user-selected document owns an offline, temporary session without a host bridge. */
export class LocalDocumentPreview {
  readonly partition: string;
  readonly url: string;
  readonly session: Session;
  private closed = false;
  private renderAbort?: AbortController;
  private guard?: LocalDocumentNetworkGuard;
  private guest?: WebContents;
  private guardReady = this.createGuardBarrier();
  private readonly guardGuest: typeof createLocalDocumentNetworkGuard;
  private readonly isHtml: boolean;

  private createGuardBarrier() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
  }

  constructor(
    document: { filePath: string; fileName: string; kind: LocalDocumentItem["kind"] },
    dependencies: LocalDocumentPreviewDependencies = {},
  ) {
    const handleId = randomUUID();
    this.partition = `local-document-${handleId}`;
    // The real filename keeps symlink selections and their relative assets
    // within the canonical directory. Only this opaque URL reaches renderer.
    this.url = `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${handleId}/${encodeURIComponent(path.basename(document.filePath))}`;
    this.session = (dependencies.createSession ?? ((partition) => session.fromPartition(partition, { cache: false })))(this.partition);
    const fileRoot = { handleId, rootRealPath: path.dirname(document.filePath) };
    const renderMarkdown = dependencies.renderMarkdown ?? renderLocalMarkdownAsync;
    const fetchFile = dependencies.fetchFile ?? ((url, method) => net.fetch(url, { method }));
    this.guardGuest = dependencies.guardGuest ?? createLocalDocumentNetworkGuard;
    this.isHtml = document.kind === "html";

    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.setDevicePermissionHandler(() => false);
    this.session.on("will-download", (event) => event.preventDefault());
    this.session.webRequest.onBeforeRequest((details, callback) => {
      try {
        const protocol = new URL(details.url).protocol;
        // A document that can read adjacent local assets must not send them
        // to a remote host. This preserves the selected-file offline boundary.
        const allowed = ["data:", "blob:", `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:`].includes(protocol);
        callback({ cancel: this.closed || !allowed || (details.resourceType === "mainFrame" && !this.isDocumentUrl(details.url)) });
      } catch { callback({ cancel: true }); }
    });

    try {
      this.session.protocol.handle(CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL, async (request) => {
        if (this.closed || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 403 });
        try {
          const parsed = new URL(request.url);
          if (parsed.username || parsed.password || parsed.port) return new Response(null, { status: 403 });
        } catch { return new Response(null, { status: 403 }); }
        const resolvedPath = resolveLocalFileProtocolPath(fileRoot, request.url);
        if (!resolvedPath) return new Response(null, { status: 404 });
        let renderAbort: AbortController | undefined;
        try {
          // Never deliver active document bytes until protection is installed.
          // A destroyed guest gets a new barrier before a replacement can load.
          if (document.kind === "html") {
            const barrier = this.guardReady;
            await barrier.promise;
            if (this.closed || this.guardReady !== barrier) return new Response(null, { status: 410 });
          }
          if (resolvedPath === document.filePath && document.kind === "markdown") {
            // Reload replaces the current render, including any queued Worker.
            this.cancelRender();
            renderAbort = new AbortController();
            this.renderAbort = renderAbort;
            const file = await fs.promises.open(resolvedPath, "r");
            let bytes: Buffer;
            try {
              const size = (await file.stat()).size;
              if (size > LOCAL_MARKDOWN_MAX_BYTES) throw new Error(t("dialog.localDocument.tooLarge"));
              const buffer = Buffer.alloc(size + 1);
              let offset = 0;
              while (offset < buffer.length && !renderAbort.signal.aborted) {
                const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
                if (!bytesRead) break;
                offset += bytesRead;
              }
              if (offset > size) throw new Error(t("dialog.localDocument.readFailed"));
              bytes = buffer.subarray(0, offset);
            } finally { await file.close(); }
            if (this.closed || renderAbort.signal.aborted) return new Response(null, { status: 410 });
            const html = await renderMarkdown(bytes, document.fileName, renderAbort.signal);
            if (this.closed || renderAbort.signal.aborted) return new Response(null, { status: 410 });
            return new Response(request.method === "HEAD" ? null : html, { headers: {
              "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
              "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src ${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}: data:; base-uri 'none'; form-action 'none'`,
              "X-Content-Type-Options": "nosniff",
            } });
          }
          const response = await fetchFile(pathToFileURL(resolvedPath).toString(), request.method);
          if (this.closed) return new Response(null, { status: 410 });
          const headers = new Headers(response.headers);
          // Preserve the document's own policies; this additional policy only
          // narrows network connections and DNS hints for the local preview.
          headers.append("Content-Security-Policy", `connect-src ${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}: data: blob:`);
          headers.set("X-DNS-Prefetch-Control", "off");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        } catch {
          return this.closed || renderAbort?.signal.aborted ? new Response(null, { status: 410 }) : new Response(t("dialog.localDocument.readFailed"), {
            status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        } finally {
          if (this.renderAbort === renderAbort) this.renderAbort = undefined;
        }
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  isDocumentUrl(value: string) {
    if (this.closed) return false;
    try {
      const candidate = new URL(value);
      candidate.hash = "";
      return candidate.href === this.url;
    } catch { return false; }
  }

  cancelRender() {
    this.renderAbort?.abort();
    this.renderAbort = undefined;
  }

  configureGuest(contents: WebContents) {
    if (this.closed || !this.isHtml || this.guest === contents) return;
    this.guest = contents;
    const barrier = this.guardReady;
    try {
      const guard = this.guardGuest(contents);
      this.guard = guard;
      void guard.ready.then(() => {
        if (!this.closed && this.guest === contents && this.guard === guard) barrier.resolve();
      }, () => barrier.reject(new Error(t("dialog.localDocument.readFailed"))));
    } catch {
      barrier.reject(new Error(t("dialog.localDocument.readFailed")));
      contents.close({ waitForBeforeUnload: false });
    }
    contents.once("destroyed", () => {
      if (this.guest !== contents) return;
      barrier.reject(new Error(t("dialog.localDocument.readFailed")));
      this.guard?.dispose();
      this.guard = undefined;
      this.guest = undefined;
      this.guardReady = this.createGuardBarrier();
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.guardReady.reject(new Error(t("dialog.localDocument.readFailed")));
    this.guard?.dispose();
    this.cancelRender();
    this.session.protocol.unhandle(CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL);
    void this.session.clearStorageData().catch(() => undefined);
    void this.session.clearCache().catch(() => undefined);
    void this.session.closeAllConnections().catch(() => undefined);
  }
}
