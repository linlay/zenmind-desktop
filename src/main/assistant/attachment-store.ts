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

const BINARY_DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".pdf", ".ppt", ".pptx", ".xls", ".xlsx"]);
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

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

type StoredAttachmentMetadata = Omit<AssistantAttachment, "dataUrl"> & {
  storedName?: string;
  sha256?: string;
};

function getAttachmentMetadataPath(attachmentsDir: string, attachmentId: string) {
  return path.join(attachmentsDir, `${path.basename(attachmentId)}.json`);
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
      ...(parsed.truncated ? { truncated: true } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
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
            ...(metadata.truncated ? { truncated: true } : {}),
            ...(metadata.error ? { error: metadata.error } : {})
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

function looksLikeText(buffer: Buffer) {
  if (buffer.includes(0)) {
    return false;
  }
  if (buffer.length === 0) {
    return true;
  }
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / buffer.length < 0.02;
}

function extractText(filePath: string, sizeBytes: number) {
  const extension = path.extname(filePath).toLowerCase();
  if (BINARY_DOCUMENT_EXTENSIONS.has(extension)) {
    return {
      text: "",
      truncated: false,
      error: "该附件已保存，但当前版本暂不支持直接解析 PDF、Word、Excel 或 PPT。请先转成 txt、md、csv 或复制正文后再问。"
    };
  }

  const bytesToRead = Math.min(sizeBytes, TEXT_PREVIEW_BYTES);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (!TEXT_EXTENSIONS.has(extension) && !looksLikeText(slice)) {
      return {
        text: "",
        truncated: false,
        error: "该附件已保存，但看起来不是可直接读取的文本文件。"
      };
    }

    const decoded = slice.toString("utf8").replace(/\u0000/gu, "").trim();
    const text = decoded.length > MAX_ATTACHMENT_TEXT_LENGTH
      ? decoded.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)
      : decoded;
    return {
      text,
      truncated: decoded.length > MAX_ATTACHMENT_TEXT_LENGTH || sizeBytes > TEXT_PREVIEW_BYTES
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function createAssistantAttachmentsFromFiles(
  app: App,
  chatId: string | null | undefined,
  filePaths: string[]
): AssistantAttachmentPickResult {
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
        error: "只能添加文件，暂不支持文件夹。"
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
        error: "附件超过 32MB，未保存。"
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
      ? { text: "", truncated: false, error: imageContext.error }
      : extractText(storedPath, stat.size);
    const attachment: AssistantAttachment = {
      id,
      name,
      mimeType,
      sizeBytes: stat.size,
      text: extracted.text,
      ...(imageContext.dataUrl ? { dataUrl: imageContext.dataUrl } : {}),
      ...(extracted.truncated ? { truncated: true } : {}),
      ...(extracted.error ? { error: extracted.error } : {})
    };
    attachments.push(attachment);
    writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);
  }

  const readableCount = attachments.filter((attachment) => attachment.text.trim()).length;
  const imageCount = attachments.filter((attachment) => attachment.dataUrl).length;
  return {
    ok: attachments.length > 0,
    chatId: chat.summary.id,
    message: readableCount > 0 || imageCount > 0
      ? `已添加 ${attachments.length} 个附件，其中 ${readableCount} 个可作为文本读取，${imageCount} 张图片可发送给模型识别。`
      : `已添加 ${attachments.length} 个附件，但没有可直接读取的文本或图片内容。`,
    attachments
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
  const attachment: AssistantAttachment = {
    id,
    name,
    mimeType,
    sizeBytes: buffer.length,
    text: "",
    ...(imageContext.dataUrl ? { dataUrl: imageContext.dataUrl } : {}),
    ...(imageContext.error ? { error: imageContext.error } : {})
  };
  writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);

  return {
    ok: true,
    chatId: chat.summary.id,
    message: imageContext.dataUrl
      ? "已粘贴 1 张图片，可随问题发送给模型识别。"
      : "图片已保存，但过大，未发送给模型视觉接口。",
    attachments: [attachment]
  };
}
