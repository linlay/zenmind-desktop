import fs from "node:fs";
import path from "node:path";
import { session, type Session, type WebContents } from "electron";
import { WORK_PANEL_DOCUMENT_HTML_PROTOCOL, type WorkPanelDocumentSource } from "../../../shared/work-panel-document-html";

export type HtmlPreviewDocument = {
  handleId: string;
  source: WorkPanelDocumentSource;
  semanticPath: string;
  authorityRoot: string;
  filePath: string;
  temporary: boolean;
  mimeType?: string;
  rendererWebContentsId: number;
};
export type FetchHtmlResource = (input: { chatId: string; relativePath: string }) => Promise<{
  bytes: Buffer; mimeType: string; revision?: string;
} | null>;

const ASSET_MAX_BYTES = 12 * 1024 * 1024;
const TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".gif": "image/gif", ".avif": "image/avif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "audio/ogg",
  ".wav": "audio/wav", ".wasm": "application/wasm", ".txt": "text/plain", ".csv": "text/csv",
};

function normalizedPath(value: string) {
  if (!value || /[\\\u0000-\u001f\u007f:]/u.test(value) || value.startsWith("/")) return "";
  const parts = value.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? "" : parts.join("/");
}

function resourcePrefix(document: HtmlPreviewDocument) {
  if (document.source.kind === "workspace-file") return "";
  // resourceId is an opaque Platform identity, NOT the on-disk directory.
  // Published artifacts live under artifacts/<runId>/..., while references
  // may use a separate storage key. Derive scope from the validated source path.
  const parts = document.semanticPath.split("/");
  // A root upload may read itself, never neighbouring Chat files or assets.
  if (document.source.kind === "reference" && parts.length === 1) return "";
  const expected = document.source.kind === "artifact" ? "artifacts" : "references";
  if (parts[0] !== expected) return null;
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
}

export function isDocumentResourcePath(document: HtmlPreviewDocument, semanticPath: string) {
  const prefix = resourcePrefix(document);
  if (prefix === null || !normalizedPath(semanticPath) || !semanticPath.startsWith(prefix)) return false;
  // A legacy flat resource has no private asset directory; do not grant access
  // to all other flat resources just to open this one file.
  return document.source.kind === "workspace-file" || document.semanticPath.split("/").length >= 3 || semanticPath === document.semanticPath;
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// authorityRoot is captured by Main, never supplied by the guest. Compare against
// the lexical resource directory too: a symlink must not escape into a sibling artifact.
export function resolveDocumentLocalPath(document: HtmlPreviewDocument, semanticPath = document.semanticPath) {
  if (!isDocumentResourcePath(document, semanticPath)) return "";
  try {
    if (document.temporary) {
      return semanticPath === document.semanticPath && fs.statSync(document.filePath).isFile()
        ? document.filePath : "";
    }
    if (!document.authorityRoot) return "";
    const root = path.join(document.authorityRoot, resourcePrefix(document) || "");
    const canonical = fs.realpathSync(path.join(document.authorityRoot, semanticPath));
    return inside(root, canonical) && fs.statSync(canonical).isFile() ? canonical : "";
  } catch { return ""; }
}

type PreviewSession = {
  document: HtmlPreviewDocument;
  partition: string;
  session: Session;
  url: string;
  bytes: number;
  sizes: Map<string, number>;
  guest?: WebContents;
};

export class DocumentHtmlPreviewSessions {
  private readonly entries = new Map<string, PreviewSession>();

  constructor(private readonly createSession = (partition: string) => session.fromPartition(partition, { cache: false })) {}

  open(document: HtmlPreviewDocument, fetchRemote?: FetchHtmlResource) {
    let entry = this.entries.get(document.handleId);
    if (entry) {
      entry.document = document;
      entry.bytes = 0;
      entry.sizes.clear();
      return { url: entry.url, partition: entry.partition };
    }
    const partition = `work-panel-document-html:${document.handleId}`;
    const previewSession = this.createSession(partition);
    const url = `${WORK_PANEL_DOCUMENT_HTML_PROTOCOL}://${document.handleId}/${document.semanticPath.split("/").map(encodeURIComponent).join("/")}`;
    entry = { document, partition, session: previewSession, url, bytes: 0, sizes: new Map() };
    this.entries.set(document.handleId, entry);
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    previewSession.setPermissionCheckHandler(() => false);
    previewSession.setDevicePermissionHandler(() => false);
    previewSession.on("will-download", (event) => event.preventDefault());
    // Public resources keep Chromium's normal CORS/TLS/mixed-content checks.
    // File and Desktop private schemes must never become alternate file/IPC bridges.
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const scheme = new URL(details.url).protocol;
        const allowed = ["http:", "https:", "ws:", "wss:", "data:", "blob:", `${WORK_PANEL_DOCUMENT_HTML_PROTOCOL}:`].includes(scheme);
        callback({ cancel: !this.entries.has(document.handleId) || !allowed ||
          (details.resourceType === "mainFrame" && !this.isDocumentUrl(document.handleId, details.url)) });
      } catch { callback({ cancel: true }); }
    });
    const current = entry;
    previewSession.protocol.handle(WORK_PANEL_DOCUMENT_HTML_PROTOCOL, async (request) => {
      try {
        const parsed = new URL(request.url);
        const semanticPath = decodeURIComponent(parsed.pathname.slice(1));
        if (this.entries.get(document.handleId) !== current || parsed.hostname !== document.handleId ||
          parsed.username || parsed.password || parsed.port || !["GET", "HEAD"].includes(request.method) ||
          !isDocumentResourcePath(current.document, semanticPath)) return new Response(null, { status: 403 });
        let bytes: Buffer;
        let mimeType = semanticPath === current.document.semanticPath ? current.document.mimeType || "text/html" :
          mimeTypes[path.posix.extname(semanticPath).toLowerCase()] || "application/octet-stream";
        const local = resolveDocumentLocalPath(current.document, semanticPath);
        if (local) {
          if (fs.statSync(local).size > ASSET_MAX_BYTES) return new Response(null, { status: 413 });
          bytes = await fs.promises.readFile(local);
        } else if (current.document.temporary && current.document.source.kind !== "workspace-file" && fetchRemote && semanticPath !== current.document.semanticPath) {
          const remote = await fetchRemote({ chatId: current.document.source.chatId, relativePath: semanticPath });
          if (!remote) return new Response(null, { status: 404 });
          bytes = remote.bytes;
          const declared = remote.mimeType.split(";", 1)[0].trim();
          if (/^[\w.+-]+\/[\w.+-]+$/u.test(declared) && declared !== "application/octet-stream") mimeType = declared;
        } else return new Response(null, { status: 404 });
        if (this.entries.get(document.handleId) !== current) return new Response(null, { status: 410 });
        const nextSize = current.bytes - (current.sizes.get(semanticPath) || 0) + bytes.length;
        if (bytes.length > ASSET_MAX_BYTES || nextSize > TOTAL_MAX_BYTES) return new Response(null, { status: 413 });
        current.bytes = nextSize;
        current.sizes.set(semanticPath, bytes.length);
        // No inherited Desktop CSP, injected bootstrap or CORS wildcard. The
        // document's own CSP is left intact, just as in an external browser.
        return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
          headers: { "Content-Type": mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      } catch { return new Response(null, { status: 404 }); }
    });
    return { url, partition };
  }

  private isDocumentUrl(handleId: string, value: string) {
    const entry = this.entries.get(handleId);
    try {
      const url = new URL(value);
      url.hash = "";
      return Boolean(entry && url.href === entry.url);
    } catch { return false; }
  }

  canAttach(url: string, partition: string, ownerId: number) {
    return [...this.entries.values()].some((entry) => entry.partition === partition &&
      entry.document.rendererWebContentsId === ownerId && this.isDocumentUrl(entry.document.handleId, url));
  }

  configureGuest(guest: WebContents, ownerId: number) {
    const entry = [...this.entries.values()].find((item) => item.session === guest.session && item.document.rendererWebContentsId === ownerId);
    if (!entry) return false;
    if (entry.guest && !entry.guest.isDestroyed() && entry.guest !== guest) { guest.close(); return true; }
    entry.guest = guest;
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    const blockNavigation = (event: { preventDefault(): void }, url: string) => {
      if (!this.isDocumentUrl(entry.document.handleId, url)) event.preventDefault();
    };
    guest.on("will-navigate", blockNavigation);
    guest.on("will-redirect", blockNavigation);
    guest.on("will-attach-webview", (event) => event.preventDefault());
    return true;
  }

  hasGuest(guest: WebContents) {
    return [...this.entries.values()].some((entry) => entry.guest === guest);
  }

  release(handleId: string) {
    const entry = this.entries.get(handleId);
    if (!entry) return;
    this.entries.delete(handleId);
    if (entry.guest && !entry.guest.isDestroyed()) entry.guest.close();
    entry.session.protocol.unhandle(WORK_PANEL_DOCUMENT_HTML_PROTOCOL);
    void entry.session.closeAllConnections().catch(() => undefined);
    void entry.session.clearStorageData().catch(() => undefined);
  }
}
