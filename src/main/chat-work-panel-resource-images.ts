import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { nativeImage, shell, type App, type BrowserWindow, type WebContents } from "electron";
import type { AssistantAttachment } from "../shared/contracts";
import type {
  AgentPlatformAssistantBridge,
  AgentPlatformImageCompletionResult,
} from "./assistant/core/agent-platform-bridge";
import {
  WORK_PANEL_RESOURCE_IMAGE_CHANGED_CHANNEL,
  type WorkPanelResourceImageActionResult,
  type WorkPanelResourceImageAiCancelRequest,
  type WorkPanelResourceImageAiRequest,
  type WorkPanelResourceImageAiResult,
  type WorkPanelResourceImageClaimRequest,
  type WorkPanelResourceImageClaimResult,
  type WorkPanelResourceImageCommitRequest,
  type WorkPanelResourceImageCommitResult,
  type WorkPanelResourceImageExternalOpenRequest,
  type WorkPanelResourceImageHandleRequest,
  type WorkPanelResourceImageMimeType,
  type WorkPanelResourceImageProfile,
  type WorkPanelResourceImageReadResult,
  type WorkPanelResourceImageReleaseRequest,
  type WorkPanelResourceImageSelection,
} from "../shared/work-panel-resource-image";
import {
  resolveChatWorkPanelResourceFile,
  type OpenChatResourceDependencies,
} from "./chat-work-panel-resource-open";
import { t } from "./i18n/main-i18n";

const CLAIM_TTL_MS = 30_000;
const IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_COMMIT_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_EDGE_MAX = 8_192;
const IMAGE_PIXEL_MAX = 40_000_000;

type ImageHandle = WorkPanelResourceImageSelection & {
  rendererGeneration: string;
  rendererWebContentsId: number;
  filePath: string;
  temporary: boolean;
};

type PendingImageClaim = {
  claimId: string;
  ownerChatId: string;
  rendererWebContentsId: number;
  profile: WorkPanelResourceImageProfile;
  agentKey: string;
  chatId: string;
  resourceId: string;
  relativePath: string;
  title: string;
  filePath: string;
  temporary: boolean;
  revision: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type ResourceCommitPayload = {
  profile: WorkPanelResourceImageProfile;
  agentKey: string;
  chatId: string;
  resourceId: string;
  relativePath: string;
  mode: "overwrite" | "new-artifact";
  expectedRevision: string;
  mimeType: WorkPanelResourceImageMimeType;
  dataBase64: string;
};

type ResourceCommitResponse = {
  artifactId?: string;
  resourceId?: string;
  relativePath?: string;
  revision?: string;
};

type RegistryRuntime = {
  app: App;
  assistantBridge: AgentPlatformAssistantBridge;
  showFileDialog: (
    options: Electron.OpenDialogOptions,
    owner?: BrowserWindow | null,
  ) => Promise<Electron.OpenDialogReturnValue>;
  showSaveDialog: (
    options: Electron.SaveDialogOptions,
    owner?: BrowserWindow | null,
  ) => Promise<Electron.SaveDialogReturnValue>;
  getMainWindow: () => BrowserWindow | null;
  fetchRemoteResource?: (input: {
    chatId: string;
    relativePath: string;
  }) => Promise<{ bytes: Buffer; mimeType: string; revision?: string } | null>;
  commitResource?: (payload: ResourceCommitPayload) => Promise<ResourceCommitResponse>;
};

export type PrepareWorkPanelResourceImageInput = {
  ownerChatId: string;
  rendererWebContentsId: number;
  profile: WorkPanelResourceImageProfile;
  agentKey: string;
  chatId: string;
  resourceId: string;
  relativePath: string;
  title?: string;
  workspaceFilePath?: string;
};

export type PrepareWorkPanelResourceImageResult =
  | { ok: true; claimId: string }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "capability_denied"
        | "target_unavailable"
        | "unsupported_native_type";
      message: string;
    };

function cleanText(value: unknown, max = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
}

function fileRevision(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.size}:${Math.trunc(stat.mtimeMs)}` : "";
  } catch {
    return "";
  }
}

function cleanRevision(value: unknown) {
  return cleanText(value, 512);
}

function detectImageMime(bytes: Uint8Array): WorkPanelResourceImageMimeType | "" {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))) {
    return "image/gif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))
  ) return "image/tiff";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp") {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString("ascii").toLowerCase();
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512))).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/iu.test(text)) return "image/svg+xml";
  return "";
}

function expectedMimeForPath(filePath: string): WorkPanelResourceImageMimeType | "" {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".apng") return "image/apng";
  if (extension === ".avif") return "image/avif";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".heic") return "image/heic";
  if (extension === ".heif") return "image/heif";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  if (extension === ".svg") return "image/svg+xml";
  return "";
}

function inspectImageFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const descriptor = fs.openSync(filePath, "r");
    const header = Buffer.alloc(512);
    try {
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const mimeType = detectImageMime(header);
    const expectedMime = expectedMimeForPath(filePath);
    if (!mimeType) return null;
    const resolvedMime = expectedMime === "image/apng" && mimeType === "image/png"
      ? expectedMime
      : mimeType;
    return {
      fileName: path.basename(filePath),
      mimeType: resolvedMime,
      sizeBytes: stat.size,
      revision: `${stat.size}:${Math.trunc(stat.mtimeMs)}`,
      editable: ["image/png", "image/jpeg", "image/webp"].includes(resolvedMime),
    };
  } catch {
    return null;
  }
}

function decodeBase64(value: unknown, maxBytes = IMAGE_INPUT_MAX_BYTES) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > Math.ceil(maxBytes / 3) * 4 + 8) return null;
  try {
    const bytes = Buffer.from(text, "base64");
    return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function imageAttachment(
  id: string,
  name: string,
  mimeType: WorkPanelResourceImageMimeType,
  bytes: Buffer,
): AssistantAttachment {
  return {
    id,
    name,
    mimeType,
    sizeBytes: bytes.length,
    text: "",
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    kind: "input",
    document: {
      format: "image",
      readStatus: "readable",
      extractedChars: 0,
      truncated: false,
      imageMode: "vision",
    },
  };
}

function imageSelection(handle: ImageHandle): WorkPanelResourceImageSelection {
  const {
    rendererGeneration: _rendererGeneration,
    rendererWebContentsId: _rendererWebContentsId,
    filePath: _filePath,
    temporary: _temporary,
    ...selection
  } = handle;
  return selection;
}

function removeTemporaryImage(filePath: string) {
  fs.rm(path.dirname(filePath), { recursive: true, force: true }, () => undefined);
}

export class WorkPanelResourceImageRegistry {
  private runtime: RegistryRuntime | null = null;
  private readonly claims = new Map<string, PendingImageClaim>();
  private readonly handles = new Map<string, ImageHandle>();
  private readonly observedSenders = new Set<number>();
  private readonly activeAiRuns = new Map<string, string>();

  configure(runtime: RegistryRuntime) {
    this.runtime = runtime;
  }

  private discardClaim(claim: PendingImageClaim) {
    if (this.claims.get(claim.claimId) !== claim) return;
    this.claims.delete(claim.claimId);
    clearTimeout(claim.timeout);
    if (claim.temporary) removeTemporaryImage(claim.filePath);
  }

  discardPreparedClaim(claimIdValue: string) {
    const claim = this.claims.get(cleanText(claimIdValue, 256));
    if (!claim) return false;
    this.discardClaim(claim);
    return true;
  }

  private ownedHandle(request: WorkPanelResourceImageHandleRequest, sender: WebContents) {
    const handle = this.handles.get(cleanText(request?.handleId, 256));
    return handle &&
      handle.chatId === cleanText(request?.ownerChatId) &&
      handle.rendererGeneration === cleanText(request?.rendererGeneration) &&
      handle.rendererWebContentsId === sender.id
      ? handle
      : null;
  }

  private releaseHandle(handle: ImageHandle) {
    this.handles.delete(handle.handleId);
    fs.unwatchFile(handle.filePath);
    if (handle.temporary) removeTemporaryImage(handle.filePath);
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

  private async resolveSource(input: PrepareWorkPanelResourceImageInput) {
    if (!this.runtime) return null;
    if (input.profile === "workspace-file") {
      const filePath = cleanText(input.workspaceFilePath, 4_096);
      return filePath ? { filePath, temporary: false, revision: fileRevision(filePath) } : null;
    }
    const dependencies: OpenChatResourceDependencies = { app: this.runtime.app };
    const resolved = resolveChatWorkPanelResourceFile({
      ownerChatId: input.chatId,
      profile: input.profile,
      relativePath: input.relativePath,
    }, dependencies, "openDefault");
    if (resolved.ok) return { filePath: resolved.path, temporary: false, revision: "" };
    if (resolved.code !== "not_found" || !this.runtime.fetchRemoteResource) return null;
    const remote = await this.runtime.fetchRemoteResource({
      chatId: input.chatId,
      relativePath: input.relativePath,
    });
    if (!remote) return null;
    const detectedMime = detectImageMime(remote.bytes);
    const extension = path.extname(input.relativePath).toLowerCase() || (
      detectedMime === "image/jpeg" ? ".jpg" : detectedMime === "image/svg+xml" ? ".svg" :
        detectedMime ? `.${detectedMime.split("/")[1]}` : ".bin"
    );
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-image-"));
    const filePath = path.join(cacheRoot, `resource${extension}`);
    fs.writeFileSync(filePath, remote.bytes, { mode: 0o600 });
    return { filePath, temporary: true, revision: cleanRevision(remote.revision) };
  }

  async prepareClaim(input: PrepareWorkPanelResourceImageInput): Promise<PrepareWorkPanelResourceImageResult> {
    const ownerChatId = cleanText(input.ownerChatId);
    const agentKey = cleanText(input.agentKey);
    const chatId = cleanText(input.chatId);
    const resourceId = cleanText(input.resourceId, 1_024);
    const relativePath = cleanText(input.relativePath, 2_048);
    const title = cleanText(input.title, 160);
    const rendererWebContentsId = Number.isSafeInteger(input.rendererWebContentsId) && input.rendererWebContentsId > 0
      ? input.rendererWebContentsId
      : 0;
    if (
      !ownerChatId || !agentKey || !chatId || !resourceId || !relativePath || !rendererWebContentsId ||
      !["workspace-file", "artifact", "reference"].includes(input.profile)
    ) {
      return { ok: false, code: "invalid_request", message: "Invalid native image resource request." };
    }
    if (ownerChatId !== chatId) {
      return { ok: false, code: "capability_denied", message: "Resource chat does not match the trusted owner Chat." };
    }
    const source = await this.resolveSource(input);
    if (!source) {
      return { ok: false, code: "target_unavailable", message: "The image resource is unavailable." };
    }
    const inspection = inspectImageFile(source.filePath);
    if (!inspection) {
      if (source.temporary) removeTemporaryImage(source.filePath);
      return {
        ok: false,
        code: "unsupported_native_type",
        message: "This document is not a supported image.",
      };
    }
    const claimId = crypto.randomUUID();
    const claim: PendingImageClaim = {
      claimId,
      ownerChatId,
      rendererWebContentsId,
      profile: input.profile,
      agentKey,
      chatId,
      resourceId,
      relativePath,
      title,
      filePath: source.filePath,
      temporary: source.temporary,
      revision: cleanRevision(source.revision) || inspection.revision,
      expiresAt: Date.now() + CLAIM_TTL_MS,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    claim.timeout = setTimeout(() => this.discardClaim(claim), CLAIM_TTL_MS);
    claim.timeout.unref?.();
    this.claims.set(claimId, claim);
    return { ok: true, claimId };
  }

  private watchHandle(handle: ImageHandle, sender: WebContents) {
    if (handle.temporary) return;
    fs.watchFile(handle.filePath, { interval: 750, persistent: false }, () => {
      const revision = fileRevision(handle.filePath);
      if (!revision || revision === handle.revision || sender.isDestroyed()) return;
      sender.send(WORK_PANEL_RESOURCE_IMAGE_CHANGED_CHANNEL, {
        handleId: handle.handleId,
        revision,
      });
    });
  }

  async claim(
    request: WorkPanelResourceImageClaimRequest,
    sender: WebContents,
  ): Promise<WorkPanelResourceImageClaimResult> {
    const claim = this.claims.get(cleanText(request?.claimId, 256));
    const ownerChatId = cleanText(request?.ownerChatId);
    const rendererGeneration = cleanText(request?.rendererGeneration);
    if (
      !claim || claim.expiresAt <= Date.now() || !ownerChatId || !rendererGeneration ||
      claim.ownerChatId !== ownerChatId || claim.rendererWebContentsId !== sender.id
    ) {
      if (claim && claim.expiresAt <= Date.now()) this.discardClaim(claim);
      return { ok: false, message: "Native image claim is unavailable." };
    }
    this.claims.delete(claim.claimId);
    clearTimeout(claim.timeout);
    const inspection = inspectImageFile(claim.filePath);
    if (!inspection) {
      if (claim.temporary) removeTemporaryImage(claim.filePath);
      return { ok: false, message: "Native image resource is unavailable." };
    }
    this.observeSender(sender);
    const existing = [...this.handles.values()].find((handle) =>
      handle.chatId === claim.chatId &&
      handle.agentKey === claim.agentKey &&
      handle.profile === claim.profile &&
      handle.resourceId === claim.resourceId &&
      handle.relativePath === claim.relativePath &&
      handle.rendererGeneration === rendererGeneration &&
      handle.rendererWebContentsId === sender.id,
    );
    if (existing) {
      const sourceChanged = existing.filePath !== claim.filePath;
      if (sourceChanged) {
        fs.unwatchFile(existing.filePath);
        if (existing.temporary) removeTemporaryImage(existing.filePath);
      }
      existing.filePath = claim.filePath;
      existing.temporary = claim.temporary;
      existing.localOriginal = !claim.temporary;
      existing.relativePath = claim.relativePath;
      existing.fileName = inspection.fileName;
      existing.mimeType = inspection.mimeType;
      existing.sizeBytes = inspection.sizeBytes;
      existing.revision = claim.revision;
      existing.editable = inspection.editable;
      if (sourceChanged) this.watchHandle(existing, sender);
      return { ok: true, resource: imageSelection(existing), reused: true };
    }
    const handle: ImageHandle = {
      handleId: crypto.randomUUID(),
      profile: claim.profile,
      agentKey: claim.agentKey,
      chatId: claim.chatId,
      resourceId: claim.resourceId,
      relativePath: claim.relativePath,
      fileName: inspection.fileName,
      mimeType: inspection.mimeType,
      sizeBytes: inspection.sizeBytes,
      revision: claim.revision,
      localOriginal: !claim.temporary,
      editable: inspection.editable,
      rendererGeneration,
      rendererWebContentsId: sender.id,
      filePath: claim.filePath,
      temporary: claim.temporary,
    };
    this.handles.set(handle.handleId, handle);
    this.watchHandle(handle, sender);
    return { ok: true, resource: imageSelection(handle), reused: false };
  }

  async read(request: WorkPanelResourceImageHandleRequest, sender: WebContents): Promise<WorkPanelResourceImageReadResult> {
    const handle = this.ownedHandle(request, sender);
    if (!handle) return { ok: false, message: "Native image handle is unavailable." };
    const inspection = inspectImageFile(handle.filePath);
    if (!inspection) return { ok: false, message: "Native image resource is unavailable." };
    try {
      const data = fs.readFileSync(handle.filePath);
      if (inspection.mimeType !== handle.mimeType) return { ok: false, message: "Image signature changed." };
      handle.fileName = inspection.fileName;
      handle.mimeType = inspection.mimeType;
      handle.sizeBytes = inspection.sizeBytes;
      if (!handle.temporary) handle.revision = inspection.revision;
      if (!handle.editable && ["image/heic", "image/heif", "image/tiff"].includes(handle.mimeType)) {
        const preview = await this.createSystemReadonlyPreview(handle.filePath);
        if (preview) return { ok: true, data: preview, displayMimeType: "image/png", revision: handle.revision };
      }
      return { ok: true, data, displayMimeType: handle.mimeType, revision: handle.revision };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async createSystemReadonlyPreview(filePath: string) {
    // Electron delegates this operation to Quick Look on macOS and the Shell
    // thumbnail provider on Windows. Keep the platform branches explicit:
    // their codec availability and failure modes are intentionally different.
    if (process.platform === "darwin") {
      try {
        const image = await nativeImage.createThumbnailFromPath(filePath, { width: 4_096, height: 4_096 });
        return image.isEmpty() ? null : image.toPNG();
      } catch {
        return null;
      }
    }
    if (process.platform === "win32") {
      try {
        const image = await nativeImage.createThumbnailFromPath(filePath, { width: 4_096, height: 4_096 });
        return image.isEmpty() ? null : image.toPNG();
      } catch {
        return null;
      }
    }
    return null;
  }

  release(request: WorkPanelResourceImageReleaseRequest, sender: WebContents) {
    const handleIds = new Set(Array.isArray(request?.handleIds)
      ? request.handleIds.map((value) => cleanText(value, 256))
      : []);
    for (const handle of this.handles.values()) {
      if (handleIds.has(handle.handleId) && this.ownedHandle({ ...request, handleId: handle.handleId }, sender)) {
        this.releaseHandle(handle);
      }
    }
    return { ok: true };
  }

  async openExternal(
    request: WorkPanelResourceImageExternalOpenRequest,
    sender: WebContents,
  ): Promise<WorkPanelResourceImageActionResult> {
    const handle = this.ownedHandle(request, sender);
    if (!handle) return { ok: false, message: "Native image handle is unavailable." };
    let targetPath = handle.filePath;
    if (!handle.localOriginal) {
      const runtime = this.runtime;
      if (!runtime) return { ok: false, message: "Native image runtime is unavailable." };
      const result = await runtime.showSaveDialog({
        title: t("chatWorkPanel.image.downloadCopy"),
        defaultPath: handle.fileName,
      }, runtime.getMainWindow());
      if (result.canceled || !result.filePath) return { ok: false };
      try {
        fs.copyFileSync(handle.filePath, result.filePath);
        targetPath = result.filePath;
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (request.mode === "default") {
      const message = await shell.openPath(targetPath);
      return message ? { ok: false, message } : { ok: true };
    }
    const runtime = this.runtime;
    if (!runtime) return { ok: false, message: "Native image runtime is unavailable." };
    if (process.platform === "darwin") {
      const result = await runtime.showFileDialog({
        title: t("chatWorkPanel.image.chooseApplication"),
        properties: ["openFile"],
        filters: [{ name: "Applications", extensions: ["app"] }],
      }, runtime.getMainWindow());
      const appPath = result.filePaths[0] || "";
      if (result.canceled || !appPath.toLowerCase().endsWith(".app")) return { ok: false };
      spawn("/usr/bin/open", ["-a", appPath, targetPath], { detached: true, stdio: "ignore" }).unref();
      return { ok: true };
    }
    if (process.platform === "win32") {
      const result = await runtime.showFileDialog({
        title: t("chatWorkPanel.image.chooseApplication"),
        properties: ["openFile"],
        filters: [{ name: "Applications", extensions: ["exe"] }],
      }, runtime.getMainWindow());
      const appPath = result.filePaths[0] || "";
      if (result.canceled || !appPath.toLowerCase().endsWith(".exe")) return { ok: false };
      spawn(appPath, [targetPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return { ok: true };
    }
    return { ok: false, message: "Choosing another application is supported on macOS and Windows." };
  }

  async runAi(
    request: WorkPanelResourceImageAiRequest,
    sender: WebContents,
  ): Promise<WorkPanelResourceImageAiResult> {
    const requestId = cleanText(request?.requestId, 128);
    const handle = this.ownedHandle(request, sender);
    const runtime = this.runtime;
    if (!requestId || !handle || !runtime || !handle.editable) {
      return { ok: false, requestId, message: "Native image AI request is unavailable." };
    }
    if (
      request.expectedRevision !== handle.revision ||
      (!handle.temporary && fileRevision(handle.filePath) !== handle.revision)
    ) {
      return { ok: false, requestId, message: "The source image changed. Reload it before running an AI edit." };
    }
    if (
      !Number.isInteger(request.width) || !Number.isInteger(request.height) ||
      request.width < 1 || request.height < 1 ||
      request.width > IMAGE_EDGE_MAX || request.height > IMAGE_EDGE_MAX ||
      request.width * request.height > IMAGE_PIXEL_MAX
    ) return { ok: false, requestId, message: "The requested image dimensions are outside the editable limit." };
    const source = decodeBase64(request.sourceDataBase64);
    if (!source || detectImageMime(source.subarray(0, 16)) !== request.sourceMimeType) {
      return { ok: false, requestId, message: "The flattened source image is invalid." };
    }
    const mask = request.maskDataBase64 ? decodeBase64(request.maskDataBase64) : null;
    if (
      (request.operation === "inpaint" || request.operation === "removeObject") &&
      (!mask || detectImageMime(mask.subarray(0, 16)) !== "image/png")
    ) {
      return { ok: false, requestId, message: "This regional AI edit requires a PNG white edit mask." };
    }
    const prompt = cleanText(request.prompt, 4_000);
    if (
      (request.operation === "inpaint" || request.operation === "replaceBackground" || request.operation === "outpaint") &&
      !prompt
    ) {
      return { ok: false, requestId, message: "This operation requires a description." };
    }
    const runKey = `${handle.handleId}:${requestId}`;
    if (this.activeAiRuns.has(runKey)) {
      return { ok: false, requestId, message: "This image AI request is already running." };
    }
    const runId = `run_nativeimg_${crypto.randomUUID().replace(/-/gu, "")}`;
    this.activeAiRuns.set(runKey, runId);
    const attachments = [imageAttachment("image-studio-source", `image-studio-source.${request.sourceMimeType.split("/")[1]}`, request.sourceMimeType, source)];
    if (mask) attachments.push(imageAttachment("image-studio-mask", "image-studio-mask.png", "image/png", mask));
    let completion: AgentPlatformImageCompletionResult;
    try {
      completion = await runtime.assistantBridge.completeImage({
        runId,
        requestId,
        agentKey: "zenmi",
        source: "copilot",
        action: "image_studio",
        operation: request.operation,
        prompt,
        width: Math.ceil(request.width / 16) * 16,
        height: Math.ceil(request.height / 16) * 16,
        count: 1,
        strength: 0.85,
        seed: -1,
        preserveComposition: request.preserveComposition,
        edgeMode: request.edgeMode,
        attachments,
      });
    } catch (error) {
      return {
        ok: false,
        requestId,
        runId,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeAiRuns.delete(runKey);
    }
    if (!completion.ok || !completion.images[0]) {
      return {
        ok: false,
        requestId,
        runId: completion.runId,
        chatId: completion.chatId,
        message: completion.message,
      };
    }
    return {
      ok: true,
      requestId,
      runId: completion.runId,
      chatId: completion.chatId,
      image: completion.images[0],
    };
  }

  async cancelAi(
    request: WorkPanelResourceImageAiCancelRequest,
    sender: WebContents,
  ): Promise<WorkPanelResourceImageActionResult> {
    const handle = this.ownedHandle(request, sender);
    const runtime = this.runtime;
    if (!handle || !runtime) return { ok: false, message: "Native image AI request is unavailable." };
    const runId = this.activeAiRuns.get(`${handle.handleId}:${cleanText(request.requestId, 128)}`);
    if (!runId) return { ok: true };
    const result = await runtime.assistantBridge.stopRun(runId);
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async commit(
    request: WorkPanelResourceImageCommitRequest,
    sender: WebContents,
  ): Promise<WorkPanelResourceImageCommitResult> {
    const handle = this.ownedHandle(request, sender);
    const runtime = this.runtime;
    if (!handle || !runtime?.commitResource || !handle.editable) return { ok: false, message: "This image format is read-only." };
    if (handle.profile === "workspace-file" && request.mode !== "overwrite") {
      return { ok: false, message: "Workspace images can only be overwritten." };
    }
    if (request.mode === "overwrite" && handle.profile === "reference") {
      return { ok: false, message: "References can only create a new Artifact." };
    }
    if (
      request.mode === "overwrite" &&
      (
        request.expectedRevision !== handle.revision ||
        (!handle.temporary && fileRevision(handle.filePath) !== handle.revision)
      )
    ) {
      return { ok: false, conflict: true, message: "The source image changed. Reload it or save as a new Artifact." };
    }
    if (request.mode === "overwrite" && handle.mimeType === "image/jpeg" && request.hasTransparency) {
      return { ok: false, message: "A transparent result cannot overwrite a JPEG. Save it as a new PNG Artifact." };
    }
    const bytes = decodeBase64(request.dataBase64, IMAGE_COMMIT_MAX_BYTES);
    if (!bytes || detectImageMime(bytes.subarray(0, 16)) !== request.mimeType) {
      return { ok: false, message: "The edited image payload is invalid." };
    }
    let response: ResourceCommitResponse;
    try {
      response = await runtime.commitResource({
        profile: handle.profile,
        agentKey: handle.agentKey,
        chatId: handle.chatId,
        resourceId: handle.resourceId,
        relativePath: handle.relativePath,
        mode: request.mode,
        expectedRevision: request.expectedRevision,
        mimeType: request.mimeType,
        dataBase64: bytes.toString("base64"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        ...(/revision conflict|source image changed/iu.test(message) ? { conflict: true } : {}),
        message,
      };
    }
    const nextProfile: WorkPanelResourceImageProfile = "artifact";
    const nextResourceId = cleanText(response.resourceId || response.artifactId, 1_024) || handle.resourceId;
    const nextRelativePath = cleanText(response.relativePath, 2_048) || handle.relativePath;
    const resolved = handle.profile === "workspace-file"
      ? null
      : resolveChatWorkPanelResourceFile({
          ownerChatId: handle.chatId,
          profile: request.mode === "overwrite" ? handle.profile : nextProfile,
          relativePath: nextRelativePath,
        }, { app: runtime.app }, "openDefault");
    const reopened = handle.profile === "workspace-file" && request.mode === "overwrite"
      ? { filePath: handle.filePath, temporary: false, revision: response.revision || "" }
      : resolved?.ok && resolved.path
        ? { filePath: resolved.path, temporary: false, revision: "" }
        : await this.resolveSource({
          ownerChatId: handle.chatId,
          rendererWebContentsId: sender.id,
          profile: request.mode === "overwrite" ? handle.profile : nextProfile,
          agentKey: handle.agentKey,
          chatId: handle.chatId,
          resourceId: nextResourceId,
          relativePath: nextRelativePath,
          ...(handle.profile === "workspace-file" ? { workspaceFilePath: handle.filePath } : {}),
        });
    if (!reopened) {
      return { ok: false, message: "Platform committed the image, but Desktop could not reopen the committed resource." };
    }
    const inspection = inspectImageFile(reopened.filePath);
    if (!inspection) return { ok: false, message: "The committed resource is not a supported image." };
    if (request.mode === "overwrite") {
      fs.unwatchFile(handle.filePath);
      if (handle.temporary && handle.filePath !== reopened.filePath) removeTemporaryImage(handle.filePath);
      handle.filePath = reopened.filePath;
      handle.fileName = inspection.fileName;
      handle.mimeType = inspection.mimeType;
      handle.sizeBytes = inspection.sizeBytes;
      handle.revision = cleanRevision(response.revision) || cleanRevision(reopened.revision) || inspection.revision;
      handle.relativePath = nextRelativePath;
      handle.temporary = reopened.temporary;
      handle.localOriginal = !reopened.temporary;
      this.watchHandle(handle, sender);
      return { ok: true, resource: imageSelection(handle), created: false };
    }
    const created: ImageHandle = {
      ...handle,
      handleId: crypto.randomUUID(),
      profile: nextProfile,
      resourceId: nextResourceId,
      relativePath: nextRelativePath,
      filePath: reopened.filePath,
      fileName: inspection.fileName,
      mimeType: inspection.mimeType,
      sizeBytes: inspection.sizeBytes,
      revision: cleanRevision(response.revision) || cleanRevision(reopened.revision) || inspection.revision,
      localOriginal: !reopened.temporary,
      temporary: reopened.temporary,
    };
    this.handles.set(created.handleId, created);
    this.watchHandle(created, sender);
    return { ok: true, resource: imageSelection(created), created: true };
  }

  dispose() {
    for (const claim of [...this.claims.values()]) this.discardClaim(claim);
    for (const handle of [...this.handles.values()]) this.releaseHandle(handle);
    this.activeAiRuns.clear();
  }
}

export const workPanelResourceImageRegistry = new WorkPanelResourceImageRegistry();

export function registerChatWorkPanelResourceImageIpcHandlers(
  ipcMain: Electron.IpcMain,
  runtime: RegistryRuntime,
) {
  workPanelResourceImageRegistry.configure(runtime);
  const isMainRenderer = (sender: WebContents) => {
    const mainWindow = runtime.getMainWindow();
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === sender.id);
  };
  ipcMain.handle("chatWorkPanel.resourceImages.claim", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.claim(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.read", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.read(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.release", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.release(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.openExternal", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.openExternal(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.ai", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.runAi(request, event.sender)
      : { ok: false, requestId: "", message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.cancelAi", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.cancelAi(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  ipcMain.handle("chatWorkPanel.resourceImages.commit", (event, request) =>
    isMainRenderer(event.sender)
      ? workPanelResourceImageRegistry.commit(request, event.sender)
      : { ok: false, message: "Unauthorized renderer." },
  );
  runtime.app.once("before-quit", () => workPanelResourceImageRegistry.dispose());
}
