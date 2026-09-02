import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App, BrowserWindow, WebContents } from "electron";
import {
  type WorkPanelDocumentHtmlClaimRequest,
  type WorkPanelDocumentHtmlClaimResult,
  type WorkPanelDocumentHtmlCommitRequest,
  type WorkPanelDocumentHtmlCommitResult,
  type WorkPanelDocumentHtmlHandleRequest,
  type WorkPanelDocumentHtmlPreviewRequest,
  type WorkPanelDocumentHtmlPreviewResult,
  type WorkPanelDocumentHtmlReadResult,
  type WorkPanelDocumentHtmlReleaseRequest,
  type WorkPanelDocumentHtmlSelection,
  type WorkPanelDocumentSource,
} from "../shared/work-panel-document-html";
import { resolveChatWorkPanelResourceFile } from "./chat-work-panel-resource-open";

const CLAIM_TTL_MS = 30_000;
const HTML_MAX_BYTES = 8 * 1024 * 1024;
const HTML_PREVIEW_ASSET_MAX_BYTES = 12 * 1024 * 1024;
const HTML_PREVIEW_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

type DocumentHandle = WorkPanelDocumentHtmlSelection & {
  source: WorkPanelDocumentSource;
  ownerChatId: string;
  rendererGeneration: string;
  rendererWebContentsId: number;
  filePath: string;
  temporary: boolean;
  semanticPath: string;
  authorityRoot: string;
};

type PendingClaim = {
  claimId: string;
  ownerChatId: string;
  rendererWebContentsId: number;
  source: WorkPanelDocumentSource;
  title: string;
  filePath: string;
  temporary: boolean;
  revision: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type DocumentCommitPayload = {
  operation: "document.commit";
  source: WorkPanelDocumentSource;
  mode: "overwrite" | "new-artifact";
  expectedRevision: string;
  payload: {
    kind: "document-html";
    mimeType: "text/html" | "application/xhtml+xml";
    encoding: "utf-8";
    text: string;
  };
};

type DocumentCommitResponse = {
  artifactId?: string;
  resourceId?: string;
  relativePath?: string;
  revision?: string;
};

type RegistryRuntime = {
  app: App;
  getMainWindow: () => BrowserWindow | null;
  fetchRemoteResource?: (input: {
    chatId: string;
    relativePath: string;
  }) => Promise<{ bytes: Buffer; mimeType: string; revision?: string } | null>;
  commitDocument?: (payload: DocumentCommitPayload) => Promise<DocumentCommitResponse>;
};

export type PrepareWorkPanelDocumentHtmlInput = {
  ownerChatId: string;
  rendererWebContentsId: number;
  source: WorkPanelDocumentSource;
  title?: string;
  workspaceFilePath?: string;
};

export type PrepareWorkPanelDocumentHtmlResult =
  | { ok: true; claimId: string }
  | {
      ok: false;
      code: "invalid_request" | "capability_denied" | "target_unavailable" | "unsupported_native_type";
      message: string;
    };

function cleanText(value: unknown, max = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
}

function revisionForFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.size}:${Math.trunc(stat.mtimeMs)}` : "";
  } catch {
    return "";
  }
}

function htmlMime(fileName: string): "text/html" | "application/xhtml+xml" | "" {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".xhtml") return "application/xhtml+xml";
  return "";
}

function sniffHtmlMime(fileName: string, text: string): "text/html" | "application/xhtml+xml" | "" {
  const extensionMime = htmlMime(fileName);
  // Platform classifies a valid UTF-8 .html/.xhtml file as HTML even when it is
  // an embeddable fragment rather than a complete document.
  if (extensionMime) return extensionMime;
  const sample = text.slice(0, 4_096).replace(/^\uFEFF/u, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/iu.test(sample)) {
    return "text/html";
  }
  return /^(?:<!doctype\s+html|<head[\s>]|<body[\s>])/iu.test(sample) ? "text/html" : "";
}

function inspectHtml(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > HTML_MAX_BYTES) return null;
    const bytes = fs.readFileSync(filePath);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) return null;
    const mimeType = sniffHtmlMime(filePath, text);
    if (!mimeType) return null;
    return {
      text,
      fileName: path.basename(filePath),
      mimeType,
      sizeBytes: stat.size,
      revision: `${stat.size}:${Math.trunc(stat.mtimeMs)}`,
    };
  } catch {
    return null;
  }
}

function removeTemporary(filePath: string) {
  fs.rm(path.dirname(filePath), { recursive: true, force: true }, () => undefined);
}

function authorityRootFor(filePath: string, semanticPath: string) {
  try {
    let root = filePath;
    const segments = semanticPath.replace(/\\/gu, "/").split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) root = path.dirname(root);
    return fs.realpathSync(root);
  } catch {
    return "";
  }
}

function filepathFromSemanticPath(value: string) {
  return value.split("/").filter(Boolean).join(path.sep);
}

function safePreviewResourcePath(baseSemanticPath: string, rawValue: string) {
  const value = rawValue.trim();
  if (!value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(value)) return "";
  try {
    const baseDirectory = path.posix.dirname(`/${baseSemanticPath.replace(/\\/gu, "/").replace(/^\/+/, "")}`);
    const url = new URL(value, `https://workpanel.invalid${baseDirectory}/`);
    if (url.origin !== "https://workpanel.invalid") return "";
    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const normalized = path.posix.normalize(decoded);
    return normalized && normalized !== "." && normalized !== ".." && !normalized.startsWith("../")
      ? normalized
      : "";
  } catch {
    return "";
  }
}

function previewAssetMime(fileName: string, declaredMime = "") {
  const normalized = declaredMime.split(";", 1)[0].trim().toLowerCase();
  if (/^(?:image|audio|video|font)\/[a-z\d.+-]+$/u.test(normalized) ||
    /^(?:text\/(?:css|javascript)|application\/(?:javascript|json|wasm))$/u.test(normalized)) return normalized;
  const extension = path.extname(fileName).toLowerCase();
  const known: Record<string, string> = {
    ".avif": "image/avif", ".bmp": "image/bmp", ".css": "text/css", ".gif": "image/gif",
    ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript",
    ".mjs": "text/javascript", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ogg": "audio/ogg",
    ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".wav": "audio/wav",
    ".webm": "video/webm", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  };
  return known[extension] || "application/octet-stream";
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
) {
  let output = "";
  let offset = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    output += input.slice(offset, match.index) + await replacer(match);
    offset = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return output + input.slice(offset);
}

function selection(handle: DocumentHandle): WorkPanelDocumentHtmlSelection {
  return {
    handleId: handle.handleId,
    sourceKind: handle.source.kind,
    stableIdentity: handle.stableIdentity,
    fileName: handle.fileName,
    mimeType: handle.mimeType,
    sizeBytes: handle.sizeBytes,
    revision: handle.revision,
    localOriginal: handle.localOriginal,
  };
}

export class WorkPanelDocumentHtmlRegistry {
  private runtime: RegistryRuntime | null = null;
  private readonly claims = new Map<string, PendingClaim>();
  private readonly handles = new Map<string, DocumentHandle>();
  private readonly observedSenders = new Set<number>();

  configure(runtime: RegistryRuntime) {
    this.runtime = runtime;
  }

  private discardClaim(claim: PendingClaim) {
    if (this.claims.get(claim.claimId) !== claim) return;
    this.claims.delete(claim.claimId);
    clearTimeout(claim.timeout);
    if (claim.temporary) removeTemporary(claim.filePath);
  }

  discardPreparedClaim(claimIdValue: string) {
    const claim = this.claims.get(cleanText(claimIdValue, 256));
    if (!claim) return false;
    this.discardClaim(claim);
    return true;
  }

  private releaseHandle(handle: DocumentHandle) {
    this.handles.delete(handle.handleId);
    if (handle.temporary) removeTemporary(handle.filePath);
  }

  private observeSender(sender: WebContents) {
    if (this.observedSenders.has(sender.id)) return;
    this.observedSenders.add(sender.id);
    sender.once("destroyed", () => {
      for (const handle of this.handles.values()) {
        if (handle.rendererWebContentsId === sender.id) this.releaseHandle(handle);
      }
      for (const claim of this.claims.values()) {
        if (claim.rendererWebContentsId === sender.id) this.discardClaim(claim);
      }
      this.observedSenders.delete(sender.id);
    });
  }

  private ownedHandle(request: WorkPanelDocumentHtmlHandleRequest, sender: WebContents) {
    const handle = this.handles.get(cleanText(request?.handleId, 256));
    return handle &&
      handle.ownerChatId === cleanText(request?.ownerChatId) &&
      handle.rendererGeneration === cleanText(request?.rendererGeneration) &&
      handle.rendererWebContentsId === sender.id
      ? handle
      : null;
  }

  private async resolveSource(input: PrepareWorkPanelDocumentHtmlInput) {
    if (!this.runtime) return null;
    if (input.source.kind === "workspace-file") {
      const filePath = cleanText(input.workspaceFilePath, 4_096);
      return filePath ? {
        filePath,
        temporary: false,
        revision: revisionForFile(filePath),
        semanticPath: input.source.path,
        authorityRoot: authorityRootFor(filePath, input.source.path),
      } : null;
    }
    const resolved = resolveChatWorkPanelResourceFile({
      ownerChatId: input.source.chatId,
      profile: input.source.kind,
      relativePath: input.source.relativePath,
    }, { app: this.runtime.app }, "openDefault");
    if (resolved.ok) {
      return {
        filePath: resolved.path,
        temporary: false,
        revision: revisionForFile(resolved.path),
        semanticPath: input.source.relativePath,
        authorityRoot: authorityRootFor(resolved.path, input.source.relativePath),
      };
    }
    if (resolved.code !== "not_found" || !this.runtime.fetchRemoteResource) return null;
    const remote = await this.runtime.fetchRemoteResource({
      chatId: input.source.chatId,
      relativePath: input.source.relativePath,
    });
    if (!remote) return null;
    const remoteMime = String(remote.mimeType || "").split(";", 1)[0].trim().toLowerCase();
    const extension = path.extname(input.source.relativePath).toLowerCase() ||
      (remoteMime === "application/xhtml+xml" ? ".xhtml" : remoteMime === "text/html" ? ".html" : ".bin");
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-document-html-"));
    const filePath = path.join(cacheRoot, `document${extension}`);
    fs.writeFileSync(filePath, remote.bytes, { mode: 0o600 });
    return {
      filePath,
      temporary: true,
      revision: cleanText(remote.revision, 512),
      semanticPath: input.source.relativePath,
      authorityRoot: "",
    };
  }

  async prepareClaim(input: PrepareWorkPanelDocumentHtmlInput): Promise<PrepareWorkPanelDocumentHtmlResult> {
    const ownerChatId = cleanText(input.ownerChatId);
    const rendererWebContentsId = Number.isSafeInteger(input.rendererWebContentsId) && input.rendererWebContentsId > 0
      ? input.rendererWebContentsId
      : 0;
    const agentKey = cleanText(input.source?.agentKey);
    if (!ownerChatId || !rendererWebContentsId || !agentKey) {
      return { ok: false, code: "invalid_request", message: "Invalid native HTML document request." };
    }
    if (input.source.kind !== "workspace-file" && input.source.chatId !== ownerChatId) {
      return { ok: false, code: "capability_denied", message: "Document does not match the trusted owner Chat." };
    }
    const source = await this.resolveSource(input);
    if (!source) return { ok: false, code: "target_unavailable", message: "The HTML document is unavailable." };
    const inspection = inspectHtml(source.filePath);
    if (!inspection) {
      if (source.temporary) removeTemporary(source.filePath);
      return { ok: false, code: "unsupported_native_type", message: "This document is not valid UTF-8 HTML." };
    }
    const claimId = crypto.randomUUID();
    const claim: PendingClaim = {
      claimId,
      ownerChatId,
      rendererWebContentsId,
      source: input.source,
      title: cleanText(input.title, 160),
      filePath: source.filePath,
      temporary: source.temporary,
      revision: source.revision || inspection.revision,
      expiresAt: Date.now() + CLAIM_TTL_MS,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    claim.timeout = setTimeout(() => this.discardClaim(claim), CLAIM_TTL_MS);
    claim.timeout.unref?.();
    this.claims.set(claimId, claim);
    return { ok: true, claimId };
  }

  async claim(
    request: WorkPanelDocumentHtmlClaimRequest,
    sender: WebContents,
  ): Promise<WorkPanelDocumentHtmlClaimResult> {
    const claim = this.claims.get(cleanText(request?.claimId, 256));
    const ownerChatId = cleanText(request?.ownerChatId);
    const rendererGeneration = cleanText(request?.rendererGeneration);
    if (
      !claim || claim.expiresAt <= Date.now() || !ownerChatId || !rendererGeneration ||
      claim.ownerChatId !== ownerChatId || claim.rendererWebContentsId !== sender.id
    ) {
      if (claim && claim.expiresAt <= Date.now()) this.discardClaim(claim);
      return { ok: false, message: "Native HTML claim is unavailable." };
    }
    this.claims.delete(claim.claimId);
    clearTimeout(claim.timeout);
    const inspection = inspectHtml(claim.filePath);
    if (!inspection) return { ok: false, message: "Native HTML document is unavailable." };
    this.observeSender(sender);
    const sourceKey = JSON.stringify(claim.source);
    const existing = [...this.handles.values()].find((handle) =>
      JSON.stringify(handle.source) === sourceKey &&
      handle.rendererGeneration === rendererGeneration &&
      handle.rendererWebContentsId === sender.id,
    );
    if (existing) {
      if (existing.temporary && existing.filePath !== claim.filePath) removeTemporary(existing.filePath);
      Object.assign(existing, {
        filePath: claim.filePath,
        temporary: claim.temporary,
        semanticPath: claim.source.kind === "workspace-file" ? claim.source.path : claim.source.relativePath,
        authorityRoot: claim.temporary
          ? ""
          : authorityRootFor(
              claim.filePath,
              claim.source.kind === "workspace-file" ? claim.source.path : claim.source.relativePath,
            ),
        localOriginal: !claim.temporary,
        fileName: inspection.fileName,
        mimeType: inspection.mimeType,
        sizeBytes: inspection.sizeBytes,
        revision: claim.revision,
      });
      return { ok: true, document: selection(existing), reused: true };
    }
    const handle: DocumentHandle = {
      handleId: crypto.randomUUID(),
      source: claim.source,
      sourceKind: claim.source.kind,
      stableIdentity: claim.source.kind === "workspace-file"
        ? `file:${claim.source.agentKey}:${claim.source.path}`
        : `${claim.source.kind}:${claim.source.agentKey}:${claim.source.chatId}:${claim.source.resourceId}:${claim.source.relativePath}`,
      ownerChatId,
      rendererGeneration,
      rendererWebContentsId: sender.id,
      filePath: claim.filePath,
      temporary: claim.temporary,
      semanticPath: claim.source.kind === "workspace-file" ? claim.source.path : claim.source.relativePath,
      authorityRoot: claim.temporary
        ? ""
        : authorityRootFor(
            claim.filePath,
            claim.source.kind === "workspace-file" ? claim.source.path : claim.source.relativePath,
          ),
      fileName: inspection.fileName,
      mimeType: inspection.mimeType,
      sizeBytes: inspection.sizeBytes,
      revision: claim.revision,
      localOriginal: !claim.temporary,
    };
    this.handles.set(handle.handleId, handle);
    return { ok: true, document: selection(handle), reused: false };
  }

  read(request: WorkPanelDocumentHtmlHandleRequest, sender: WebContents): WorkPanelDocumentHtmlReadResult {
    const handle = this.ownedHandle(request, sender);
    if (!handle) return { ok: false, message: "Native HTML handle is unavailable." };
    const inspection = inspectHtml(handle.filePath);
    if (inspection && !handle.temporary) handle.revision = inspection.revision;
    return inspection
      ? { ok: true, text: inspection.text, revision: handle.temporary ? handle.revision : inspection.revision }
      : { ok: false, message: "Native HTML document is unavailable." };
  }

  private async previewAssetDataUrl(
    handle: DocumentHandle,
    semanticPath: string,
    budget: { bytes: number },
    cache: Map<string, string | null>,
    depth = 0,
  ): Promise<string | null> {
    if (depth > 2) return null;
    if (cache.has(semanticPath)) return cache.get(semanticPath) ?? null;
    cache.set(semanticPath, null);
    let bytes: Buffer;
    let declaredMime = "";
    if (handle.authorityRoot) {
      try {
        const candidate = path.join(handle.authorityRoot, filepathFromSemanticPath(semanticPath));
        const canonical = fs.realpathSync(candidate);
        const relative = path.relative(handle.authorityRoot, canonical);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
        const info = fs.statSync(canonical);
        if (!info.isFile() || info.size <= 0 || info.size > HTML_PREVIEW_ASSET_MAX_BYTES) return null;
        bytes = fs.readFileSync(canonical);
      } catch {
        return null;
      }
    } else if (handle.source.kind !== "workspace-file" && this.runtime?.fetchRemoteResource) {
      const remote = await this.runtime.fetchRemoteResource({
        chatId: handle.source.chatId,
        relativePath: semanticPath,
      });
      if (!remote || remote.bytes.length <= 0 || remote.bytes.length > HTML_PREVIEW_ASSET_MAX_BYTES) return null;
      bytes = remote.bytes;
      declaredMime = remote.mimeType;
    } else {
      return null;
    }
    if (budget.bytes + bytes.length > HTML_PREVIEW_TOTAL_MAX_BYTES) return null;
    budget.bytes += bytes.length;
    const mimeType = previewAssetMime(semanticPath, declaredMime);
    if (mimeType === "text/css") {
      const css = bytes.toString("utf8");
      if (Buffer.from(css, "utf8").equals(bytes) && !css.includes("\0")) {
        const rewritten = await replaceAsync(css, /url\(\s*(["']?)([^"')]+)\1\s*\)/giu, async (match) => {
          const nestedPath = safePreviewResourcePath(semanticPath, match[2] || "");
          const nested = nestedPath
            ? await this.previewAssetDataUrl(handle, nestedPath, budget, cache, depth + 1)
            : null;
          return nested ? `url("${nested}")` : match[0];
        });
        const result = `data:text/css;charset=utf-8;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`;
        cache.set(semanticPath, result);
        return result;
      }
    }
    const result = `data:${mimeType};base64,${bytes.toString("base64")}`;
    cache.set(semanticPath, result);
    return result;
  }

  async preview(
    request: WorkPanelDocumentHtmlPreviewRequest,
    sender: WebContents,
  ): Promise<WorkPanelDocumentHtmlPreviewResult> {
    const handle = this.ownedHandle(request, sender);
    if (!handle || typeof request.text !== "string" || request.text.includes("\0") || Buffer.byteLength(request.text, "utf8") > HTML_MAX_BYTES) {
      return { ok: false, message: "Native HTML preview request is invalid." };
    }
    const budget = { bytes: 0 };
    const cache = new Map<string, string | null>();
    let text = request.text;
    const rewriteAttribute = async (match: RegExpExecArray) => {
      const semanticPath = safePreviewResourcePath(handle.semanticPath, match[3] || "");
      const dataUrl = semanticPath
        ? await this.previewAssetDataUrl(handle, semanticPath, budget, cache)
        : null;
      return dataUrl ? `${match[1]}${match[2]}${dataUrl}${match[2]}` : match[0];
    };
    text = await replaceAsync(
      text,
      /(<(?:img|script|iframe|source|video|audio|input)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])([^"']+)\2/giu,
      rewriteAttribute,
    );
    text = await replaceAsync(
      text,
      /(<link\b[^>]*?\shref\s*=\s*)(["'])([^"']+)\2/giu,
      rewriteAttribute,
    );
    return { ok: true, text };
  }

  release(request: WorkPanelDocumentHtmlReleaseRequest, sender: WebContents) {
    const ids = new Set(Array.isArray(request?.handleIds) ? request.handleIds.map((id) => cleanText(id, 256)) : []);
    for (const handle of this.handles.values()) {
      if (ids.has(handle.handleId) && this.ownedHandle({ ...request, handleId: handle.handleId }, sender)) {
        this.releaseHandle(handle);
      }
    }
    return { ok: true };
  }

  async commit(
    request: WorkPanelDocumentHtmlCommitRequest,
    sender: WebContents,
  ): Promise<WorkPanelDocumentHtmlCommitResult> {
    const handle = this.ownedHandle(request, sender);
    const runtime = this.runtime;
    if (!handle || !runtime?.commitDocument) return { ok: false, message: "Platform document commit is unavailable." };
    if (handle.source.kind === "workspace-file" && request.mode !== "overwrite") {
      return { ok: false, message: "Workspace files can only be overwritten." };
    }
    if (handle.source.kind === "reference" && request.mode !== "new-artifact") {
      return { ok: false, message: "References can only create a new Artifact." };
    }
    if (request.expectedRevision !== handle.revision || request.text.includes("\0") || Buffer.byteLength(request.text, "utf8") > HTML_MAX_BYTES) {
      return { ok: false, conflict: request.expectedRevision !== handle.revision, message: "The document changed or the edited payload is invalid." };
    }
    let response: DocumentCommitResponse;
    try {
      response = await runtime.commitDocument({
        operation: "document.commit",
        source: handle.source,
        mode: request.mode,
        expectedRevision: request.expectedRevision,
        payload: {
          kind: "document-html",
          mimeType: handle.mimeType,
          encoding: "utf-8",
          text: request.text,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, conflict: /revision[_ ]conflict/iu.test(message), message };
    }
    if (request.mode === "overwrite") {
      if (!handle.temporary) {
        const inspection = inspectHtml(handle.filePath);
        if (inspection) {
          handle.sizeBytes = inspection.sizeBytes;
          handle.revision = cleanText(response.revision, 512) || inspection.revision;
          return { ok: true, document: selection(handle), created: false };
        }
      } else {
        try {
          fs.writeFileSync(handle.filePath, request.text, "utf8");
          const inspection = inspectHtml(handle.filePath);
          if (inspection) handle.sizeBytes = inspection.sizeBytes;
        } catch {
          return { ok: false, message: "The saved HTML could not be refreshed in the local preview cache." };
        }
      }
      handle.revision = cleanText(response.revision, 512) || handle.revision;
      return { ok: true, document: selection(handle), created: false };
    }
    const nextResourceId = cleanText(response.resourceId || response.artifactId, 1_024);
    const nextRelativePath = cleanText(response.relativePath, 2_048);
    if (!nextResourceId || !nextRelativePath || handle.source.kind === "workspace-file") {
      return { ok: false, message: "Platform created the Artifact, but returned an invalid document identity." };
    }
    const nextSource: WorkPanelDocumentSource = {
      kind: "artifact",
      agentKey: handle.source.agentKey,
      chatId: handle.source.chatId,
      resourceId: nextResourceId,
      relativePath: nextRelativePath,
    };
    const reopened = await this.resolveSource({
      ownerChatId: handle.ownerChatId,
      rendererWebContentsId: sender.id,
      source: nextSource,
    });
    if (!reopened) {
      return { ok: false, message: "Platform created the Artifact, but Desktop could not reopen it." };
    }
    const inspection = inspectHtml(reopened.filePath);
    if (!inspection) {
      if (reopened.temporary) removeTemporary(reopened.filePath);
      return { ok: false, message: "The created Artifact is not valid UTF-8 HTML." };
    }
    const created: DocumentHandle = {
      ...handle,
      handleId: crypto.randomUUID(),
      source: nextSource,
      sourceKind: "artifact",
      stableIdentity: `artifact:${nextSource.agentKey}:${nextSource.chatId}:${nextSource.resourceId}:${nextSource.relativePath}`,
      filePath: reopened.filePath,
      temporary: reopened.temporary,
      semanticPath: reopened.semanticPath,
      authorityRoot: reopened.authorityRoot,
      fileName: inspection.fileName,
      mimeType: inspection.mimeType,
      sizeBytes: inspection.sizeBytes,
      revision: cleanText(response.revision, 512) || reopened.revision || inspection.revision,
      localOriginal: !reopened.temporary,
    };
    this.handles.set(created.handleId, created);
    return { ok: true, document: selection(created), created: true };
  }

  dispose() {
    for (const claim of this.claims.values()) this.discardClaim(claim);
    for (const handle of this.handles.values()) this.releaseHandle(handle);
  }
}

export const workPanelDocumentHtmlRegistry = new WorkPanelDocumentHtmlRegistry();

export function registerChatWorkPanelDocumentHtmlIpcHandlers(
  ipcMain: Electron.IpcMain,
  runtime: RegistryRuntime,
) {
  workPanelDocumentHtmlRegistry.configure(runtime);
  const authorized = (sender: WebContents) => {
    const window = runtime.getMainWindow();
    return Boolean(window && !window.isDestroyed() && window.webContents.id === sender.id);
  };
  ipcMain.handle("chatWorkPanel.documentHtml.claim", (event, request) =>
    authorized(event.sender) ? workPanelDocumentHtmlRegistry.claim(request, event.sender) : { ok: false, message: "Unauthorized renderer." });
  ipcMain.handle("chatWorkPanel.documentHtml.read", (event, request) =>
    authorized(event.sender) ? workPanelDocumentHtmlRegistry.read(request, event.sender) : { ok: false, message: "Unauthorized renderer." });
  ipcMain.handle("chatWorkPanel.documentHtml.preview", (event, request) =>
    authorized(event.sender) ? workPanelDocumentHtmlRegistry.preview(request, event.sender) : { ok: false, message: "Unauthorized renderer." });
  ipcMain.handle("chatWorkPanel.documentHtml.release", (event, request) =>
    authorized(event.sender) ? workPanelDocumentHtmlRegistry.release(request, event.sender) : { ok: false, message: "Unauthorized renderer." });
  ipcMain.handle("chatWorkPanel.documentHtml.commit", (event, request) =>
    authorized(event.sender) ? workPanelDocumentHtmlRegistry.commit(request, event.sender) : { ok: false, message: "Unauthorized renderer." });
  runtime.app.once("before-quit", () => workPanelDocumentHtmlRegistry.dispose());
}
