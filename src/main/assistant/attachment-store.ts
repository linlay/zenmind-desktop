import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type {
  AssistantAttachment,
  AssistantAttachmentPickResult,
  AssistantPastedImageInput
} from "../../shared/contracts";
import { ensureAssistantChat, getAssistantChatDir } from "./chat-store";
import {
  createImageDocumentMetadata,
  extractDocumentTextFromFile,
  renderPdfPagesForVision
} from "./document-extract";

const MAX_ATTACHMENT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_LENGTH = 20000;
const TEXT_PREVIEW_BYTES = 512 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const REFRESHABLE_DOCUMENT_FORMATS = new Set(["text", "pdf", "docx", "xlsx", "pptx", "zip"]);

function createAttachmentId() {
  return `att_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function safeFilename(name: string) {
  const baseName = path.basename(name).trim();
  if (!baseName || baseName === "." || baseName === path.sep) {
    return "attachment.bin";
  }
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_");
}

function guessMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".csv":
      return "text/csv";
    case ".htm":
    case ".html":
      return "text/html";
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip":
      return "application/zip";
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return TEXT_EXTENSIONS.has(extension) ? "text/plain" : "application/octet-stream";
  }
}

function getImageExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  switch (normalized) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

function isSupportedImage(mimeType: string, filePathOrName = "") {
  const normalizedMime = mimeType.toLowerCase();
  if (["image/gif", "image/jpeg", "image/jpg", "image/png", "image/webp"].includes(normalizedMime)) {
    return true;
  }
  return IMAGE_EXTENSIONS.has(path.extname(filePathOrName).toLowerCase());
}

function createImageDataUrl(buffer: Buffer, mimeType: string) {
  if (buffer.length > MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES) {
    return {
      dataUrl: "",
      error: "图片已保存，但超过 5MB，未发送给模型视觉接口。"
    };
  }

  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    error: ""
  };
}

function createPdfPageImageName(sourceName: string, pageNumber: number) {
  const parsed = path.parse(sourceName);
  return safeFilename(`${parsed.name || "pdf"}-page-${pageNumber}.png`);
}

type StoredAttachmentMetadata = Omit<AssistantAttachment, "dataUrl"> & {
  storedName?: string;
  sha256?: string;
};

export type AssistantArtifactPublishInput = {
  artifactId?: string;
  path: string;
  name?: string;
  mimeType?: string;
  description?: string;
  type?: string;
};

export type PublishedAssistantArtifact = {
  artifactId: string;
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  type: string;
  description?: string;
};

export type AssistantArtifactPublishResult = {
  ok: boolean;
  chatId: string;
  message: string;
  attachments: AssistantAttachment[];
  artifacts: PublishedAssistantArtifact[];
  errors: string[];
};

function getAttachmentMetadataPath(attachmentsDir: string, attachmentId: string) {
  return path.join(attachmentsDir, `${path.basename(attachmentId)}.json`);
}

function createAssistantAttachmentUrl(chatId: string, attachmentId: string) {
  return `assistant://attachment/${chatId}/${attachmentId}`;
}

function readAttachmentMetadata(attachmentsDir: string, attachmentId: string): StoredAttachmentMetadata | null {
  try {
    const raw = fs.readFileSync(getAttachmentMetadataPath(attachmentsDir, attachmentId), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAttachmentMetadata>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.text !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      text: parsed.text,
      ...(parsed.kind === "artifact" ? { kind: "artifact" as const } : parsed.kind === "input" ? { kind: "input" as const } : {}),
      ...(typeof parsed.artifactId === "string" ? { artifactId: parsed.artifactId } : {}),
      ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
      ...(parsed.truncated ? { truncated: true } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
	      ...(parsed.document ? { document: parsed.document } : {}),
	      ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
	      ...(parsed.hidden ? { hidden: true } : {}),
	      ...(typeof parsed.sourceAttachmentId === "string" ? { sourceAttachmentId: parsed.sourceAttachmentId } : {}),
	      ...(typeof parsed.pageNumber === "number" ? { pageNumber: parsed.pageNumber } : {}),
	      ...(typeof parsed.storedName === "string" ? { storedName: parsed.storedName } : {}),
	      ...(typeof parsed.sha256 === "string" ? { sha256: parsed.sha256 } : {})
	    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function hydrateAssistantAttachmentsForChat(
  app: App,
  chatId: string | null | undefined,
  attachments: AssistantAttachment[] | null | undefined
) {
  if (!chatId || !Array.isArray(attachments) || attachments.length === 0) {
    return attachments ?? [];
  }

  const attachmentsDir = path.join(getAssistantChatDir(app, chatId), "attachments");
  return attachments.map((attachment) => {
    if (attachment.dataUrl) {
      return attachment;
    }

    const metadata = readAttachmentMetadata(attachmentsDir, attachment.id);
    const merged: AssistantAttachment = {
      ...attachment,
      ...(metadata
        ? {
            name: metadata.name,
            mimeType: metadata.mimeType,
            sizeBytes: metadata.sizeBytes,
            text: metadata.text,
            ...(metadata.kind ? { kind: metadata.kind } : {}),
            ...(metadata.artifactId ? { artifactId: metadata.artifactId } : {}),
            ...(metadata.description ? { description: metadata.description } : {}),
            ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
            ...(metadata.url ? { url: metadata.url } : {}),
            ...(metadata.truncated ? { truncated: true } : {}),
            ...(metadata.error ? { error: metadata.error } : {}),
            ...(metadata.document ? { document: metadata.document } : {})
          }
        : {})
    };

    if (!metadata?.storedName || !isSupportedImage(merged.mimeType, merged.name)) {
      return merged;
    }

    try {
      const storedBuffer = fs.readFileSync(path.join(attachmentsDir, path.basename(metadata.storedName)));
      const imageContext = createImageDataUrl(storedBuffer, merged.mimeType);
      return {
        ...merged,
        ...(imageContext.dataUrl ? { dataUrl: imageContext.dataUrl } : {}),
        ...(imageContext.error && !merged.error ? { error: imageContext.error } : {})
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return merged;
      }
      throw error;
    }
  });
}

function shouldRefreshStoredAttachment(attachment: AssistantAttachment, metadata: StoredAttachmentMetadata | null) {
  if (!metadata?.storedName || attachment.kind === "artifact" || attachment.hidden) {
    return false;
  }
  const document = attachment.document ?? metadata.document;
  if (!document || document.readStatus !== "unreadable") {
    return false;
  }
  if (!REFRESHABLE_DOCUMENT_FORMATS.has(document.format)) {
    return false;
  }
  return !(attachment.text || metadata.text || "").trim();
}

function mergeRefreshedAttachment(
  attachment: AssistantAttachment,
  metadata: StoredAttachmentMetadata,
  extracted: Awaited<ReturnType<typeof extractDocumentTextFromFile>>
): AssistantAttachment {
  const { error: _error, truncated: _truncated, dataUrl: _dataUrl, ...base } = {
    ...attachment,
    ...metadata
  };
  return {
    ...base,
    text: extracted.text,
    ...(extracted.truncated ? { truncated: true } : {}),
    ...(extracted.error ? { error: extracted.error } : {}),
    document: extracted.document
  };
}

export async function refreshAssistantAttachmentsForRun(
  app: App,
  chatId: string | null | undefined,
  attachments: AssistantAttachment[] | null | undefined
): Promise<{ attachments: AssistantAttachment[]; changed: boolean }> {
  if (!chatId || !Array.isArray(attachments) || attachments.length === 0) {
    return {
      attachments: attachments ?? [],
      changed: false
    };
  }

  const attachmentsDir = path.join(getAssistantChatDir(app, chatId), "attachments");
  const refreshed: AssistantAttachment[] = [];
  let changed = false;
  for (const attachment of attachments) {
    const metadata = readAttachmentMetadata(attachmentsDir, attachment.id);
    if (!shouldRefreshStoredAttachment(attachment, metadata)) {
      refreshed.push(attachment);
      continue;
    }

    const storedPath = path.resolve(path.join(attachmentsDir, path.basename(metadata!.storedName!)));
    if (!isInsideOrSame(attachmentsDir, storedPath)) {
      refreshed.push(attachment);
      continue;
    }

    try {
      const extracted = await extractDocumentTextFromFile(storedPath, {
        maxChars: MAX_ATTACHMENT_TEXT_LENGTH,
        mimeType: metadata!.mimeType || attachment.mimeType
      });
      const next = mergeRefreshedAttachment(attachment, metadata!, extracted);
      writeAttachmentMetadata(attachmentsDir, next, metadata!.storedName!, metadata!.sha256 ?? "");
      refreshed.push(next);
      changed = true;
    } catch {
      refreshed.push(attachment);
    }
  }

  return {
    attachments: refreshed,
    changed
  };
}

function writeAttachmentMetadata(
  attachmentsDir: string,
  attachment: AssistantAttachment,
  storedName: string,
  hash: string
) {
  const { dataUrl: _dataUrl, ...metadata } = attachment;
  fs.writeFileSync(
    path.join(attachmentsDir, `${attachment.id}.json`),
    `${JSON.stringify({ ...metadata, storedName, sha256: hash }, null, 2)}\n`,
    "utf8"
  );
}

function isWindowsPlatform() {
  return process.platform === "win32";
}

function normalizeForCompare(value: string) {
  const resolved = path.resolve(value);
  return isWindowsPlatform() ? resolved.toLowerCase() : resolved;
}

function isInsideOrSame(parent: string, candidate: string) {
  const normalizedParent = normalizeForCompare(parent);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedParent === normalizedCandidate) {
    return true;
  }
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assistantRoot(app: App) {
  return path.resolve(path.join(app.getPath("userData"), "assistant"));
}

function chatWorkspaceRoot(app: App, chatId: string) {
  return path.resolve(path.join(getAssistantChatDir(app, chatId), "workspace"));
}

function resolveArtifactSourcePath(app: App, chatId: string, inputPath: string) {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error("产物路径不能为空。");
  }

  const workspaceMatch = /^[/\\]workspace(?:[/\\](.*))?$/iu.exec(trimmed);
  const workspace = chatWorkspaceRoot(app, chatId);
  const desktop = path.resolve(app.getPath("desktop"));
  const assistant = assistantRoot(app);
  const allowedRoots = [desktop, assistant, workspace];
  const candidate = workspaceMatch
    ? path.join(workspace, workspaceMatch[1] ?? "")
    : path.isAbsolute(trimmed)
      ? trimmed
      : path.join(desktop, trimmed);
  const resolved = path.resolve(candidate);
  if (!allowedRoots.some((root) => isInsideOrSame(root, resolved))) {
    throw new Error(`产物路径不在允许范围内：${resolved}`);
  }
  return resolved;
}

export function resolveAssistantAttachmentPath(app: App, chatId: string, attachmentId: string) {
  const attachmentsDir = path.join(getAssistantChatDir(app, chatId), "attachments");
  const metadata = readAttachmentMetadata(attachmentsDir, path.basename(attachmentId));
  if (!metadata?.storedName) {
    throw new Error("没有找到该附件的本地文件。");
  }
  const resolved = path.resolve(path.join(attachmentsDir, path.basename(metadata.storedName)));
  if (!isInsideOrSame(attachmentsDir, resolved)) {
    throw new Error("附件路径不在允许范围内。");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error("该附件不是可打开的文件。");
  }
  return resolved;
}

export async function createAssistantAttachmentsFromFiles(
  app: App,
  chatId: string | null | undefined,
  filePaths: string[]
): Promise<AssistantAttachmentPickResult> {
  if (filePaths.length === 0) {
    return {
      ok: false,
      chatId: chatId ?? "",
      message: "未选择附件。",
      attachments: []
    };
  }

  const chat = ensureAssistantChat(app, chatId, "新的对话");
  const chatDir = getAssistantChatDir(app, chat.summary.id);
  const attachmentsDir = path.join(chatDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const attachments: AssistantAttachment[] = [];
  for (const filePath of filePaths) {
    const id = createAttachmentId();
    const name = safeFilename(filePath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      attachments.push({
        id,
        name,
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        text: "",
        error: "只能添加文件，暂不支持文件夹。",
        document: {
          format: "binary",
          readStatus: "unreadable",
          extractedChars: 0,
          truncated: false,
          errorCode: "not_file"
        }
      });
      continue;
    }

    if (stat.size > MAX_ATTACHMENT_FILE_BYTES) {
      attachments.push({
        id,
        name,
        mimeType: guessMimeType(filePath),
        sizeBytes: stat.size,
        text: "",
        error: "附件超过 32MB，未保存。",
        document: {
          format: "binary",
          readStatus: "unreadable",
          extractedChars: 0,
          truncated: false,
          errorCode: "file_too_large"
        }
      });
      continue;
    }

    const storedName = `${id}_${name}`;
    const storedPath = path.join(attachmentsDir, storedName);
    fs.copyFileSync(filePath, storedPath);
    const storedBuffer = fs.readFileSync(storedPath);
    const hash = createHash("sha256").update(storedBuffer).digest("hex");
    const mimeType = guessMimeType(filePath);
    const imageContext = isSupportedImage(mimeType, filePath)
      ? createImageDataUrl(storedBuffer, mimeType)
      : { dataUrl: "", error: "" };
    const extracted = imageContext.dataUrl || imageContext.error
      ? createImageDocumentMetadata({
          readable: Boolean(imageContext.dataUrl),
          error: imageContext.error,
          errorCode: imageContext.error ? "image_too_large_for_vision" : undefined
        })
      : await extractDocumentTextFromFile(storedPath, {
          maxChars: MAX_ATTACHMENT_TEXT_LENGTH,
          mimeType
        });
	    const attachment: AssistantAttachment = {
	      id,
	      name,
	      mimeType,
	      sizeBytes: stat.size,
	      text: extracted.text,
      ...(imageContext.dataUrl ? { dataUrl: imageContext.dataUrl } : {}),
      ...(extracted.truncated ? { truncated: true } : {}),
	      ...(extracted.error ? { error: extracted.error } : {}),
	      document: extracted.document
	    };
	    attachments.push(attachment);

	    if (extracted.errorCode === "scanned_pdf_no_text") {
	      try {
	        const pageImages = await renderPdfPagesForVision(storedPath);
	        if (pageImages.length > 0) {
	          attachment.text = `该 PDF 没有可复制文字，已渲染前 ${pageImages.length} 页为视觉页图。`;
	          attachment.error = "该 PDF 是扫描件或图片型 PDF，已转为页图等待 MiniMax 图片理解接口识别。";
	          for (const pageImage of pageImages) {
	            const pageId = createAttachmentId();
	            const pageName = createPdfPageImageName(name, pageImage.pageNumber);
	            const pageStoredName = `${pageId}_${pageName}`;
	            const pageStoredPath = path.join(attachmentsDir, pageStoredName);
	            fs.writeFileSync(pageStoredPath, pageImage.buffer);
	            const pageHash = createHash("sha256").update(pageImage.buffer).digest("hex");
	            const pageImageContext = createImageDataUrl(pageImage.buffer, pageImage.mimeType);
	            const pageDocument = createImageDocumentMetadata({
	              readable: Boolean(pageImageContext.dataUrl),
	              error: pageImageContext.error,
	              errorCode: pageImageContext.error ? "image_too_large_for_vision" : undefined
	            });
	            const pageAttachment: AssistantAttachment = {
	              id: pageId,
	              name: pageName,
	              mimeType: pageImage.mimeType,
	              sizeBytes: pageImage.buffer.length,
	              text: "",
	              hidden: true,
	              sourceAttachmentId: id,
	              pageNumber: pageImage.pageNumber,
	              ...(pageImageContext.dataUrl ? { dataUrl: pageImageContext.dataUrl } : {}),
	              ...(pageImageContext.error ? { error: pageImageContext.error } : {}),
	              document: pageDocument.document
	            };
	            attachments.push(pageAttachment);
	            writeAttachmentMetadata(attachmentsDir, pageAttachment, pageStoredName, pageHash);
	          }
	        }
	      } catch (error) {
	        const message = error instanceof Error ? error.message : String(error);
	        attachment.error = `${attachment.error || "扫描 PDF 页图渲染失败。"} ${message}`;
	        attachment.document = {
	          ...extracted.document,
	          ...attachment.document,
	          errorCode: "scanned_pdf_render_failed"
	        };
	      }
	    }

	    writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);
	  }

	  const visibleAttachments = attachments.filter((attachment) => !attachment.hidden);
	  const readableCount = visibleAttachments.filter((attachment) => attachment.document?.readStatus === "readable" || attachment.document?.readStatus === "truncated").length;
	  const truncatedCount = visibleAttachments.filter((attachment) => attachment.document?.truncated).length;
	  const imageCount = visibleAttachments.filter((attachment) => attachment.dataUrl).length;
	  const hiddenScanPageCount = attachments.filter((attachment) => attachment.hidden && attachment.dataUrl).length;
	  const unreadableCount = visibleAttachments.filter((attachment) => attachment.document?.readStatus === "unreadable").length;
	  return {
	    ok: attachments.length > 0,
	    chatId: chat.summary.id,
	    message: [
	      `已添加 ${visibleAttachments.length} 个附件，已解析 ${readableCount} 个`,
	      truncatedCount > 0 ? `${truncatedCount} 个已截断` : "",
	      imageCount > 0 ? `${imageCount} 张图片已进入视觉上下文` : "",
	      hiddenScanPageCount > 0 ? `${hiddenScanPageCount} 页扫描页图已进入视觉上下文` : "",
	      unreadableCount > 0 ? `${unreadableCount} 个无可读文本或暂不支持解析` : ""
	    ].filter(Boolean).join("，") + "。",
    attachments
  };
}

export function createAssistantArtifactAttachmentsFromFiles(
  app: App,
  chatId: string,
  inputs: AssistantArtifactPublishInput[],
  options: { fallbackArtifactId?: string } = {}
): AssistantArtifactPublishResult {
  const chat = ensureAssistantChat(app, chatId, "新的对话");
  const chatDir = getAssistantChatDir(app, chat.summary.id);
  const attachmentsDir = path.join(chatDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const attachments: AssistantAttachment[] = [];
  const artifacts: PublishedAssistantArtifact[] = [];
  const errors: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const id = createAttachmentId();
    const artifactId = input.artifactId || (inputs.length === 1 ? options.fallbackArtifactId : "") || `artifact_${Date.now().toString(36)}_${index}`;
    try {
      const sourcePath = resolveArtifactSourcePath(app, chat.summary.id, input.path);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) {
        errors.push(`${input.path} 不是文件。`);
        continue;
      }
      if (stat.size > MAX_ATTACHMENT_FILE_BYTES) {
        errors.push(`${input.path} 超过 32MB，未发布为聊天产物。`);
        continue;
      }

      const name = safeFilename(input.name || sourcePath);
      const mimeType = input.mimeType || guessMimeType(sourcePath);
      const storedName = `${id}_${name}`;
      const storedPath = path.join(attachmentsDir, storedName);
      fs.copyFileSync(sourcePath, storedPath);
      const storedBuffer = fs.readFileSync(storedPath);
      const hash = createHash("sha256").update(storedBuffer).digest("hex");
      const url = createAssistantAttachmentUrl(chat.summary.id, id);
      const attachment: AssistantAttachment = {
        id,
        name,
        mimeType,
        sizeBytes: stat.size,
        text: "",
        kind: "artifact",
        artifactId,
        ...(input.description ? { description: input.description } : {}),
        sha256: hash,
        url
      };
      attachments.push(attachment);
      artifacts.push({
        artifactId,
        attachmentId: id,
        name,
        mimeType,
        sizeBytes: stat.size,
        sha256: hash,
        url,
        type: input.type || "file",
        ...(input.description ? { description: input.description } : {})
      });
      writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const names = artifacts.map((artifact) => artifact.name).join("、");
  return {
    ok: attachments.length > 0,
    chatId: chat.summary.id,
    message: attachments.length > 0
      ? `已发布 ${attachments.length} 个产物${names ? `：${names}` : ""}。`
      : errors[0] || "没有发布任何产物。",
    attachments,
    artifacts,
    errors
  };
}

function pastedImageDataToBuffer(data: AssistantPastedImageInput["data"]) {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

export function createAssistantAttachmentFromPastedImage(
  app: App,
  chatId: string | null | undefined,
  input: AssistantPastedImageInput
): AssistantAttachmentPickResult {
  const chat = ensureAssistantChat(app, chatId, "新的对话");
  const chatDir = getAssistantChatDir(app, chat.summary.id);
  const attachmentsDir = path.join(chatDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const id = createAttachmentId();
  const mimeType = input.mimeType || "image/png";
  const fallbackName = `pasted-image${getImageExtensionFromMimeType(mimeType)}`;
  const name = safeFilename(input.name || fallbackName);
  const buffer = pastedImageDataToBuffer(input.data);
  if (!isSupportedImage(mimeType, name)) {
    return {
      ok: false,
      chatId: chat.summary.id,
      message: "剪贴板里不是当前支持的图片格式。",
      attachments: []
    };
  }

  if (buffer.length > MAX_ATTACHMENT_FILE_BYTES) {
    return {
      ok: false,
      chatId: chat.summary.id,
      message: "图片超过 32MB，未保存。",
      attachments: []
    };
  }

  const storedName = `${id}_${name}`;
  const storedPath = path.join(attachmentsDir, storedName);
  fs.writeFileSync(storedPath, buffer);
  const hash = createHash("sha256").update(buffer).digest("hex");
  const imageContext = createImageDataUrl(buffer, mimeType);
  const imageDocument = createImageDocumentMetadata({
    readable: Boolean(imageContext.dataUrl),
    error: imageContext.error,
    errorCode: imageContext.error ? "image_too_large_for_vision" : undefined
  });
  const attachment: AssistantAttachment = {
    id,
    name,
    mimeType,
    sizeBytes: buffer.length,
    text: "",
    ...(imageContext.dataUrl ? { dataUrl: imageContext.dataUrl } : {}),
    ...(imageContext.error ? { error: imageContext.error } : {}),
    document: imageDocument.document
  };
  writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);

  return {
    ok: true,
    chatId: chat.summary.id,
    message: imageContext.dataUrl
      ? "已粘贴 1 张图片，图片已进入视觉上下文。"
      : "图片已保存，但过大，未发送给模型视觉接口。",
    attachments: [attachment]
  };
}
