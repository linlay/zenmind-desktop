import fs, { openAsBlob } from "node:fs";
import path from "node:path";
import type {
  EnterpriseChatAttachment,
  EnterpriseChatAttachmentData,
  EnterpriseChatAttachmentInput,
  EnterpriseChatDesktopAction,
  EnterpriseChatDownloadResult,
  EnterpriseChatScreenshotMode,
  EnterpriseChatSendFilesInput,
  EnterpriseChatSendPastedFilesInput,
  EnterpriseChatSendRawAgentChatInput,
  EnterpriseChatSendScreenshotInput,
  EnterpriseChatSendSupportBundleInput,
  EnterpriseChatSnapshot
} from "../../../shared/contracts";
import {
  ENTERPRISE_CHAT_MAX_PASTED_FILES,
  ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES
} from "../../../shared/contracts/enterprise-chat";
import { t } from "../../support/i18n/main-i18n";
import { ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES, ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES, ENTERPRISE_CHAT_MAX_SELECTED_FILES, ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES, EnterpriseChatRawAgentChatData, contentTypeForFile, safeDownloadName, safeRawAgentChatFilename } from "./attachment-policy";
import { ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS, FetchLike } from "./connection-transport";
import { normalizeAttachment } from "./message-projection";
import { isRecord, readNumber, readText } from "./protocol-values";

export interface AttachmentServiceDependencies {
  readonly selectFiles: () => Promise<string[]>;
  getState(): EnterpriseChatSnapshot;
  ensureSession(): Promise<void>;
  assertMessageSendReady(): void;
  uploadFilePath(filePath: string): Promise<EnterpriseChatAttachment>;
  sendMessagePayload(input: {
    conversationId: string;
    clientMessageId: string;
    body: string;
    fileIds: string[];
    replyToId?: string;
    kind?: string;
    desktopAction?: Record<string, unknown>;
  }): Promise<EnterpriseChatSnapshot>;
  readonly createSupportBundle: () => Promise<{ filename: string; bytes: Buffer; }>;
  uploadBlob(blob: Blob, filename: string): Promise<EnterpriseChatAttachment>;
  readonly platform: NodeJS.Platform;
  readonly captureScreenshot?: ((mode: EnterpriseChatScreenshotMode) => Promise<{ ok: boolean; message?: string; dataBase64?: string; mimeType?: string; cancelled?: boolean; }>) | undefined;
  fetchAttachment(fileId: string, maxBytes: number): Promise<{ buffer: Buffer<ArrayBuffer>; contentType: string; }>;
  readonly showSaveDialog?: ((options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[]; }>; }) => Promise<{ canceled?: boolean; filePath?: string; }>) | undefined;
  readonly app: Electron.App;
  requestJson<T>(path: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }, useImSessionToken?: boolean): Promise<T>;
  readonly fetchImpl: FetchLike;
  readonly serverUrl: string;
  readonly imSessionToken: string;
  readonly createSupportArtifact?: ((action: string, args: Record<string, unknown>) => Promise<{ filename: string; contentType: string; bytes: Buffer; }>) | undefined;
}

export async function sendFiles(dependencies: AttachmentServiceDependencies, input: EnterpriseChatSendFilesInput) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  if (!conversationId || !clientMessageId) {
    throw new Error("conversationId and clientMessageId are required.");
  }
  const selected = (await dependencies.selectFiles())
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .slice(0, ENTERPRISE_CHAT_MAX_SELECTED_FILES);
  if (selected.length === 0) {
    return dependencies.getState();
  }
  await dependencies.ensureSession();
  dependencies.assertMessageSendReady();
  const fileIds: string[] = [];
  for (const filePath of selected) {
    const attachment = await dependencies.uploadFilePath(filePath);
    fileIds.push(attachment.id);
  }
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body: "",
    fileIds
  });
}

export async function sendSupportBundle(dependencies: AttachmentServiceDependencies, input: EnterpriseChatSendSupportBundleInput) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  if (!conversationId || !clientMessageId) {
    throw new Error("conversationId and clientMessageId are required.");
  }
  await dependencies.ensureSession();
  dependencies.assertMessageSendReady();
  const bundle = await dependencies.createSupportBundle();
  const bundleBytes = Uint8Array.from(bundle.bytes);
  const attachment = await dependencies.uploadBlob(new Blob([bundleBytes.buffer], { type: "application/zip" }), bundle.filename);
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body: "",
    fileIds: [attachment.id]
  });
}

export async function sendRawAgentChat(dependencies: AttachmentServiceDependencies, input: EnterpriseChatSendRawAgentChatInput, rawChat: EnterpriseChatRawAgentChatData) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  const chatId = readText(input?.chatId);
  if (!conversationId || !clientMessageId || !chatId) {
    throw new Error("conversationId, chatId, and clientMessageId are required.");
  }
  if (!(rawChat?.bytes instanceof Uint8Array)) {
    throw new Error(t("assistant.rawChatJsonlReadFailed"));
  }
  if (rawChat.bytes.byteLength > ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES) {
    throw new Error(t("assistant.rawChatJsonlTooLarge"));
  }
  await dependencies.ensureSession();
  dependencies.assertMessageSendReady();
  const filename = safeRawAgentChatFilename(readText(input.chatName) || path.basename(readText(rawChat.filename), ".jsonl"), chatId, dependencies.platform);
  const bytes = Uint8Array.from(rawChat.bytes);
  const attachment = await dependencies.uploadBlob(new Blob([bytes.buffer], { type: "application/x-ndjson" }), filename);
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body: "",
    kind: "file",
    fileIds: [attachment.id]
  });
}

export async function sendPastedFiles(dependencies: AttachmentServiceDependencies, input: EnterpriseChatSendPastedFilesInput) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  const files = Array.isArray(input?.files) ? input.files : [];
  if (!conversationId || !clientMessageId) {
    throw new Error("conversationId and clientMessageId are required.");
  }
  if (files.length === 0 || files.length > ENTERPRISE_CHAT_MAX_PASTED_FILES) {
    throw new Error(`Paste between 1 and ${ENTERPRISE_CHAT_MAX_PASTED_FILES} files.`);
  }
  const blobs = files.map((file, index) => {
    const value: unknown = file;
    const record = isRecord(value) ? value : {};
    const name = readText(record.name) || `pasted-file-${Date.now()}-${index + 1}`;
    const contentType = readText(record.contentType) || contentTypeForFile(name);
    const sizeBytes = Math.max(0, Math.trunc(readNumber(record.sizeBytes)));
    const rawDataBase64 = record.dataBase64;
    const hasData = typeof rawDataBase64 === "string";
    const dataBase64 = hasData
      ? rawDataBase64.trim()
      : "";
    const maxBase64Length = Math.ceil(ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES / 3) * 4 + 4;
    if (!hasData ||
      dataBase64.length > maxBase64Length ||
      dataBase64.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)) {
      throw new Error(`Pasted file "${name}" has invalid data.`);
    }
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length > ENTERPRISE_CHAT_MAX_PASTED_FILE_BYTES ||
      bytes.length !== sizeBytes) {
      throw new Error(`Pasted file "${name}" exceeds the local attachment limit.`);
    }
    return {
      blob: new Blob([bytes], { type: contentType }),
      name
    };
  });
  await dependencies.ensureSession();
  dependencies.assertMessageSendReady();
  const fileIds: string[] = [];
  for (const file of blobs) {
    const attachment = await dependencies.uploadBlob(file.blob, file.name);
    fileIds.push(attachment.id);
  }
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body: "",
    fileIds
  });
}

export async function sendScreenshot(dependencies: AttachmentServiceDependencies, input: EnterpriseChatSendScreenshotInput) {
  const conversationId = readText(input?.conversationId);
  const clientMessageId = readText(input?.clientMessageId);
  const mode = readText(input?.mode);
  if (!conversationId || !clientMessageId) {
    throw new Error("conversationId and clientMessageId are required.");
  }
  if (mode !== "region" && mode !== "window" && mode !== "desktop") {
    throw new Error("Screenshot mode is invalid.");
  }
  if (!dependencies.captureScreenshot) {
    throw new Error("Screenshot capture is unavailable.");
  }
  const capture = await dependencies.captureScreenshot(mode);
  if (!capture.ok) {
    if (capture.cancelled) {
      return dependencies.getState();
    }
    throw new Error(capture.message || "Screenshot capture failed.");
  }
  const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
  if (bytes.length === 0) {
    throw new Error("Screenshot capture returned no image.");
  }
  await dependencies.ensureSession();
  dependencies.assertMessageSendReady();
  const attachment = await dependencies.uploadBlob(new Blob([bytes], { type: capture.mimeType || "image/png" }), `screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
  return dependencies.sendMessagePayload({
    conversationId,
    clientMessageId,
    body: "",
    fileIds: [attachment.id]
  });
}

export async function loadAttachment(dependencies: AttachmentServiceDependencies, input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatAttachmentData> {
  const fileId = readText(input?.fileId);
  if (!fileId) {
    throw new Error("fileId is required.");
  }
  const { buffer, contentType } = await dependencies.fetchAttachment(fileId, ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES);
  return {
    fileId,
    contentType: readText(input?.contentType) || contentType,
    sizeBytes: buffer.length,
    dataBase64: buffer.toString("base64")
  };
}

export async function downloadAttachment(dependencies: AttachmentServiceDependencies, input: EnterpriseChatAttachmentInput): Promise<EnterpriseChatDownloadResult> {
  const fileId = readText(input?.fileId);
  if (!fileId) {
    throw new Error("fileId is required.");
  }
  const { buffer } = await dependencies.fetchAttachment(fileId, ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES);
  const filename = safeDownloadName(readText(input?.name) || "attachment", dependencies.platform);
  const saveResult = dependencies.showSaveDialog
    ? await dependencies.showSaveDialog({
      title: "Save attachment",
      defaultPath: path.join(dependencies.app.getPath("downloads"), filename)
    })
    : {
      canceled: false,
      filePath: path.join(dependencies.app.getPath("downloads"), filename)
    };
  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, cancelled: true, path: "", message: "Download cancelled." };
  }
  const target = saveResult.filePath;
  if (dependencies.platform === "win32") {
    await fs.promises.writeFile(target, buffer);
  }
  else {
    await fs.promises.writeFile(target, buffer, { mode: 0o600 });
  }
  return { ok: true, path: target, message: "" };
}

export async function uploadFilePath(dependencies: AttachmentServiceDependencies, filePath: string) {
  const blob = await openAsBlob(filePath, { type: contentTypeForFile(filePath) });
  return dependencies.uploadBlob(blob, path.basename(filePath));
}

export async function uploadBlob(dependencies: AttachmentServiceDependencies, blob: Blob, filename: string) {
  const form = new FormData();
  form.append("file", blob, safeDownloadName(filename, dependencies.platform));
  const response = await dependencies.requestJson<unknown>("/api/v1/files", {
    method: "POST",
    body: form
  });
  const attachment = normalizeAttachment(response);
  if (!attachment) {
    throw new Error("The IM server returned invalid attachment metadata.");
  }
  return attachment;
}

export async function fetchAttachment(dependencies: AttachmentServiceDependencies, fileId: string, maxBytes: number) {
  await dependencies.ensureSession();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
  try {
    const response = await dependencies.fetchImpl(`${dependencies.serverUrl}/api/v1/files/${encodeURIComponent(fileId)}`, {
      headers: {
        Authorization: `Bearer ${dependencies.imSessionToken}`
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Attachment download failed (${response.status}).`);
    }
    if (typeof response.arrayBuffer !== "function") {
      throw new Error("Attachment response cannot be read.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("Attachment exceeds the local preview or download limit.");
    }
    return {
      buffer,
      contentType: "application/octet-stream"
    };
  }
  finally {
    clearTimeout(timeout);
  }
}

export async function createRemoteSupportAttachment(dependencies: AttachmentServiceDependencies, request: EnterpriseChatDesktopAction) {
  if (request.action === "desktop.support.requestDiagnostics") {
    const bundle = await dependencies.createSupportBundle();
    const attachment = await dependencies.uploadBlob(new Blob([Uint8Array.from(bundle.bytes).buffer], { type: "application/zip" }), bundle.filename);
    return [attachment.id];
  }
  if (request.action === "desktop.support.requestScreenshot") {
    const mode = readText(request.args.mode) as EnterpriseChatScreenshotMode;
    if (!dependencies.captureScreenshot || !["region", "window", "desktop"].includes(mode)) {
      throw new Error("Screenshot capture is unavailable or the mode is invalid.");
    }
    const capture = await dependencies.captureScreenshot(mode);
    if (!capture.ok || capture.cancelled) {
      throw new Error(capture.message || "Screenshot capture was cancelled.");
    }
    const bytes = Buffer.from(capture.dataBase64 ?? "", "base64");
    if (bytes.length === 0) {
      throw new Error("Screenshot capture returned no image.");
    }
    const attachment = await dependencies.uploadBlob(new Blob([bytes], { type: capture.mimeType || "image/png" }), `desktop-screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
    return [attachment.id];
  }
  if (!dependencies.createSupportArtifact) {
    throw new Error("The requested support artifact is unavailable.");
  }
  const artifact = await dependencies.createSupportArtifact(request.action, request.args);
  const attachment = await dependencies.uploadBlob(new Blob([Uint8Array.from(artifact.bytes).buffer], { type: artifact.contentType }), artifact.filename);
  return [attachment.id];
}
