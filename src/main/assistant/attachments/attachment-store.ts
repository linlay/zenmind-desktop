import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isMainThread, Worker } from "node:worker_threads";
import type { App } from "electron";
import type {
  AssistantAttachment,
  AssistantAttachmentTaskProgress,
  AssistantAttachmentPickResult,
  AssistantPastedImageInput
} from "../../../shared/contracts";
import {
  createImageDocumentMetadata,
  extractDocumentTextFromFile,
  renderPdfPagesForVision
} from "./document-extract";
import { getAssistantTempRoot } from "../../user-paths";
import { getMainLocale, t } from "../../i18n/main-i18n";

const MAX_ATTACHMENT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_LENGTH = 20000;
const TEXT_PREVIEW_BYTES = 512 * 1024;

type AttachmentTaskOptions = {
  taskId?: string;
  useWorker?: boolean;
  onProgress?: (progress: AssistantAttachmentTaskProgress) => void;
};

type AttachmentWorkerMessage =
  | { type: "progress"; progress: AssistantAttachmentTaskProgress }
  | { type: "result"; result: AssistantAttachmentPickResult }
  | { type: "error"; message: string };

type AssistantPathApp = Pick<App, "getPath"> & Partial<Pick<App, "isPackaged">> & {
  assistantTempRoot?: string;
};

type ActiveAttachmentTask = {
  worker: Worker;
  resolve: (result: AssistantAttachmentPickResult) => void;
  reject: (error: Error) => void;
  chatId: string;
  settled: boolean;
};

const activeAttachmentTasks = new Map<string, ActiveAttachmentTask>();

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

function createAttachmentId() {
  return `att_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createAttachmentTaskId() {
  return `attachment_task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function createAttachmentChatId() {
  return `chat_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function normalizeAttachmentChatId(chatId?: string | null) {
  const trimmed = chatId?.trim();
  return trimmed || createAttachmentChatId();
}

function getAssistantRoot(app: AssistantPathApp) {
  if (app.assistantTempRoot) {
    return app.assistantTempRoot;
  }
  return getAssistantTempRoot(app as App);
}

function getAttachmentChatDir(app: AssistantPathApp, chatId: string) {
  return path.join(getAssistantRoot(app), "chats", chatId);
}

function ensureAttachmentChatDir(app: AssistantPathApp, chatId?: string | null) {
  const normalizedChatId = normalizeAttachmentChatId(chatId);
  const chatDir = getAttachmentChatDir(app, normalizedChatId);
  fs.mkdirSync(path.join(chatDir, "attachments"), { recursive: true });
  return {
    id: normalizedChatId,
    dir: chatDir
  };
}

function formatAttachmentSizeLimit(sizeBytes: number) {
  return `${Math.round(sizeBytes / 1024 / 1024)}MB`;
}

function emitAttachmentProgress(
  options: AttachmentTaskOptions,
  progress: Omit<AssistantAttachmentTaskProgress, "taskId">
) {
  if (!options.taskId || !options.onProgress) {
    return;
  }
  options.onProgress({
    taskId: options.taskId,
    ...progress
  });
}

function createCancelledAttachmentResult(chatId: string, taskId: string): AssistantAttachmentPickResult {
  return {
    ok: false,
    chatId,
    message: t("attachment.cancelled"),
    attachments: [],
    taskId,
    cancelled: true
  };
}

async function getAttachmentBatchStats(filePaths: string[]) {
  let totalBytes = 0;
  let fileCount = 0;
  for (const filePath of filePaths) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) {
        totalBytes += stat.size;
        fileCount += 1;
      }
    } catch {
      fileCount += 1;
    }
  }
  return { totalBytes, fileCount };
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
      error: t("attachment.imageTooLargeForVision", {
        limit: formatAttachmentSizeLimit(MAX_ATTACHMENT_IMAGE_CONTEXT_BYTES)
      })
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

export function resolveAssistantAttachmentPath(app: App, chatId: string, attachmentId: string) {
  const attachmentsDir = path.join(getAttachmentChatDir(app, chatId), "attachments");
  const metadata = readAttachmentMetadata(attachmentsDir, path.basename(attachmentId));
  if (!metadata?.storedName) {
    throw new Error(t("attachment.localFileMissing"));
  }
  const resolved = path.resolve(path.join(attachmentsDir, path.basename(metadata.storedName)));
  if (!isInsideOrSame(attachmentsDir, resolved)) {
    throw new Error(t("attachment.pathOutsideAllowed"));
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(t("attachment.notOpenableFile"));
  }
  return resolved;
}

export async function createAssistantAttachmentsFromFiles(
  app: App,
  chatId: string | null | undefined,
  filePaths: string[],
  options: AttachmentTaskOptions = {}
): Promise<AssistantAttachmentPickResult> {
  const taskId = options.taskId || createAttachmentTaskId();
  const nextOptions = { ...options, taskId };
  const initialChatId = chatId ?? "";
  emitAttachmentProgress(nextOptions, {
    chatId: initialChatId,
    phase: "queued",
    processedFiles: 0,
    totalFiles: filePaths.length,
    processedBytes: 0,
    totalBytes: 0,
    message: t("attachment.preparing")
  });

  if (filePaths.length > 0) {
    const stats = await getAttachmentBatchStats(filePaths);
    if (stats.totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
      const message = t("attachment.batchTooLarge", {
        limit: formatAttachmentSizeLimit(MAX_ATTACHMENT_BATCH_BYTES)
      });
      emitAttachmentProgress(nextOptions, {
        chatId: initialChatId,
        phase: "error",
        processedFiles: 0,
        totalFiles: filePaths.length,
        processedBytes: 0,
        totalBytes: stats.totalBytes,
        message,
        done: true
      });
      return {
        ok: false,
        chatId: initialChatId,
        message,
        attachments: [],
        taskId
      };
    }
  }

  if (nextOptions.useWorker !== false && isMainThread) {
    return createAssistantAttachmentsFromFilesInWorker(app, chatId, filePaths, nextOptions);
  }

  return createAssistantAttachmentsFromFilesInProcess(app, chatId, filePaths, nextOptions);
}

async function createAssistantAttachmentsFromFilesInWorker(
  app: App,
  chatId: string | null | undefined,
  filePaths: string[],
  options: Required<Pick<AttachmentTaskOptions, "taskId">> & AttachmentTaskOptions
): Promise<AssistantAttachmentPickResult> {
  const workerPath = path.join(__dirname, "attachment-worker.js");
  return new Promise<AssistantAttachmentPickResult>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        assistantTempRoot: getAssistantTempRoot(app),
        chatId,
        filePaths,
        taskId: options.taskId,
        locale: getMainLocale()
      }
    });
    const activeTask: ActiveAttachmentTask = {
      worker,
      resolve,
      reject,
      chatId: chatId ?? "",
      settled: false
    };
    activeAttachmentTasks.set(options.taskId, activeTask);
    worker.on("message", (message: AttachmentWorkerMessage) => {
      if (message.type === "progress") {
        if (message.progress.chatId) {
          activeTask.chatId = message.progress.chatId;
        }
        options.onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        activeTask.settled = true;
        activeAttachmentTasks.delete(options.taskId);
        resolve({ ...message.result, taskId: options.taskId });
        return;
      }
      activeTask.settled = true;
      activeAttachmentTasks.delete(options.taskId);
      reject(new Error(message.message));
    });
    worker.on("error", (error) => {
      if (activeTask.settled) {
        return;
      }
      activeTask.settled = true;
      activeAttachmentTasks.delete(options.taskId);
      reject(error);
    });
    worker.on("exit", (code) => {
      if (activeTask.settled) {
        return;
      }
      activeTask.settled = true;
      activeAttachmentTasks.delete(options.taskId);
      if (code === 0) {
        resolve(createCancelledAttachmentResult(chatId ?? "", options.taskId));
        return;
      }
      reject(new Error(t("attachment.workerExited", { code })));
    });
  });
}

export function cancelAssistantAttachmentTask(taskId: string) {
  const task = activeAttachmentTasks.get(taskId);
  if (!task) {
    return {
      ok: false,
      message: t("attachment.taskNotFound")
    };
  }
  task.settled = true;
  activeAttachmentTasks.delete(taskId);
  task.worker.terminate().catch(() => undefined);
  task.resolve(createCancelledAttachmentResult(task.chatId, taskId));
  return {
    ok: true,
    message: t("attachment.cancelled")
  };
}

export async function createAssistantAttachmentsFromFilesInProcess(
  app: AssistantPathApp,
  chatId: string | null | undefined,
  filePaths: string[],
  options: AttachmentTaskOptions = {}
): Promise<AssistantAttachmentPickResult> {
  if (filePaths.length === 0) {
    return {
      ok: false,
      chatId: chatId ?? "",
      message: t("attachment.noneSelected"),
      attachments: [],
      ...(options.taskId ? { taskId: options.taskId } : {})
    };
  }

  const chat = ensureAttachmentChatDir(app as App, chatId);
  const chatDir = getAttachmentChatDir(app as App, chat.id);
  const attachmentsDir = path.join(chatDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const attachments: AssistantAttachment[] = [];
  let totalBytes = 0;
  for (const filePath of filePaths) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        totalBytes += stat.size;
      }
    } catch {
      // The per-file branch below will surface the concrete error as an unreadable attachment.
    }
  }
  let processedBytes = 0;
  emitAttachmentProgress(options, {
    chatId: chat.id,
    phase: "scanning",
    processedFiles: 0,
    totalFiles: filePaths.length,
    processedBytes,
    totalBytes,
    message: t("attachment.checking")
  });

  for (const [index, filePath] of filePaths.entries()) {
    const id = createAttachmentId();
    const name = safeFilename(filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      attachments.push({
        id,
        name,
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        text: "",
        error: error instanceof Error ? error.message : t("attachment.readFileFailed"),
        document: {
          format: "binary",
          readStatus: "unreadable",
          extractedChars: 0,
          truncated: false,
          errorCode: "stat_failed"
        }
      });
      emitAttachmentProgress(options, {
        chatId: chat.id,
        phase: "error",
        processedFiles: index + 1,
        totalFiles: filePaths.length,
        processedBytes,
        totalBytes,
        message: t("attachment.readFailed", { name })
      });
      continue;
    }
    if (!stat.isFile()) {
      attachments.push({
        id,
        name,
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        text: "",
        error: t("attachment.onlyFilesSupported"),
        document: {
          format: "binary",
          readStatus: "unreadable",
          extractedChars: 0,
          truncated: false,
          errorCode: "not_file"
        }
      });
      emitAttachmentProgress(options, {
        chatId: chat.id,
        phase: "error",
        processedFiles: index + 1,
        totalFiles: filePaths.length,
        processedBytes,
        totalBytes,
        message: t("attachment.notFile", { name })
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
        error: t("attachment.fileTooLarge", { limit: formatAttachmentSizeLimit(MAX_ATTACHMENT_FILE_BYTES) }),
        document: {
          format: "binary",
          readStatus: "unreadable",
          extractedChars: 0,
          truncated: false,
          errorCode: "file_too_large"
        }
      });
      processedBytes += stat.size;
      emitAttachmentProgress(options, {
        chatId: chat.id,
        phase: "error",
        processedFiles: index + 1,
        totalFiles: filePaths.length,
        processedBytes,
        totalBytes,
        message: t("attachment.tooLarge", { name, limit: formatAttachmentSizeLimit(MAX_ATTACHMENT_FILE_BYTES) })
      });
      continue;
    }

    const storedName = `${id}_${name}`;
    const storedPath = path.join(attachmentsDir, storedName);
    emitAttachmentProgress(options, {
      chatId: chat.id,
      phase: "copying",
      processedFiles: index,
      totalFiles: filePaths.length,
      processedBytes,
      totalBytes,
      message: t("attachment.saving", { name })
    });
    fs.copyFileSync(filePath, storedPath);
    const storedBuffer = fs.readFileSync(storedPath);
    const hash = createHash("sha256").update(storedBuffer).digest("hex");
    const mimeType = guessMimeType(filePath);
    const imageContext = isSupportedImage(mimeType, filePath)
      ? createImageDataUrl(storedBuffer, mimeType)
      : { dataUrl: "", error: "" };
    emitAttachmentProgress(options, {
      chatId: chat.id,
      phase: "extracting",
      processedFiles: index,
      totalFiles: filePaths.length,
      processedBytes,
      totalBytes,
      message: t("attachment.parsing", { name })
    });
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
          emitAttachmentProgress(options, {
            chatId: chat.id,
            phase: "rendering",
            processedFiles: index,
            totalFiles: filePaths.length,
            processedBytes,
            totalBytes,
            message: t("attachment.renderingScanPages", { name })
          });
	        const pageImages = await renderPdfPagesForVision(storedPath);
	        if (pageImages.length > 0) {
	          attachment.text = t("attachment.scannedPdfText", { count: pageImages.length });
	          attachment.error = t("attachment.scannedPdfError");
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
	        attachment.error = `${attachment.error || t("attachment.scannedPdfRenderFailed")} ${message}`;
	        attachment.document = {
	          ...extracted.document,
	          ...attachment.document,
	          errorCode: "scanned_pdf_render_failed"
	        };
	      }
	    }

	    writeAttachmentMetadata(attachmentsDir, attachment, storedName, hash);
    processedBytes += stat.size;
    emitAttachmentProgress(options, {
      chatId: chat.id,
      phase: "extracting",
      processedFiles: index + 1,
      totalFiles: filePaths.length,
      processedBytes,
      totalBytes,
      message: t("attachment.processed", { name })
    });
	  }

	  const visibleAttachments = attachments.filter((attachment) => !attachment.hidden);
	  const readableCount = visibleAttachments.filter((attachment) => attachment.document?.readStatus === "readable" || attachment.document?.readStatus === "truncated").length;
	  const truncatedCount = visibleAttachments.filter((attachment) => attachment.document?.truncated).length;
	  const imageCount = visibleAttachments.filter((attachment) => attachment.dataUrl).length;
	  const hiddenScanPageCount = attachments.filter((attachment) => attachment.hidden && attachment.dataUrl).length;
  const unreadableCount = visibleAttachments.filter((attachment) => attachment.document?.readStatus === "unreadable").length;
  const message = [
    t("attachment.summaryBase", { count: visibleAttachments.length, readableCount }),
    truncatedCount > 0 ? t("attachment.summaryTruncated", { count: truncatedCount }) : "",
    imageCount > 0 ? t("attachment.summaryImages", { count: imageCount }) : "",
    hiddenScanPageCount > 0 ? t("attachment.summaryScanPages", { count: hiddenScanPageCount }) : "",
    unreadableCount > 0 ? t("attachment.summaryUnreadable", { count: unreadableCount }) : ""
  ].filter(Boolean).join(t("common.listSeparator")) + t("common.sentenceEnd");
  emitAttachmentProgress(options, {
    chatId: chat.id,
    phase: "complete",
    processedFiles: filePaths.length,
    totalFiles: filePaths.length,
    processedBytes,
    totalBytes,
    message,
    done: true
  });
	  return {
	    ok: attachments.length > 0,
	    chatId: chat.id,
	    message,
    attachments,
    ...(options.taskId ? { taskId: options.taskId } : {})
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
  return createAssistantAttachmentFromImageBuffer(app, chatId, {
    name: input.name,
    mimeType: input.mimeType,
    buffer: pastedImageDataToBuffer(input.data),
    fallbackBaseName: "pasted-image",
    unsupportedMessage: t("attachment.pastedImageUnsupported"),
    readableMessage: t("attachment.pastedImageReadable"),
    oversizedVisionMessage: t("attachment.imageOversizedVision")
  });
}

export function createAssistantAttachmentFromImageBuffer(
  app: App,
  chatId: string | null | undefined,
  input: {
    name?: string;
    mimeType?: string;
    buffer: Buffer;
    fallbackBaseName?: string;
    unsupportedMessage?: string;
    readableMessage?: string;
    oversizedVisionMessage?: string;
  }
): AssistantAttachmentPickResult {
  const chat = ensureAttachmentChatDir(app, chatId);
  const chatDir = getAttachmentChatDir(app, chat.id);
  const attachmentsDir = path.join(chatDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const id = createAttachmentId();
  const mimeType = input.mimeType || "image/png";
  const fallbackName = `${input.fallbackBaseName || "image"}${getImageExtensionFromMimeType(mimeType)}`;
  const name = safeFilename(input.name || fallbackName);
  const buffer = input.buffer;
  if (!isSupportedImage(mimeType, name)) {
    return {
      ok: false,
      chatId: chat.id,
      message: input.unsupportedMessage || t("attachment.imageUnsupported"),
      attachments: []
    };
  }

  if (buffer.length > MAX_ATTACHMENT_FILE_BYTES) {
    return {
      ok: false,
      chatId: chat.id,
      message: t("attachment.imageTooLarge"),
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
    chatId: chat.id,
    message: imageContext.dataUrl
      ? input.readableMessage || t("attachment.imageReadable")
      : input.oversizedVisionMessage || t("attachment.imageOversizedVision"),
    attachments: [attachment]
  };
}
