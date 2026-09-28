import path from "node:path";

export const ENTERPRISE_CHAT_INLINE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

export const ENTERPRISE_CHAT_DOWNLOAD_MAX_BYTES = 110 * 1024 * 1024;

export const ENTERPRISE_CHAT_RAW_AGENT_CHAT_MAX_BYTES = 100 * 1024 * 1024;

export const ENTERPRISE_CHAT_MAX_SELECTED_FILES = 10;

export type EnterpriseChatRawAgentChatData = {
  filename: string;
  bytes: Uint8Array;
};

export function contentTypeForFile(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export function safeDownloadName(value: string, platform: NodeJS.Platform) {
  const base = path.basename(value.trim()) || "attachment";
  if (platform === "win32") {
    const sanitized = base.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
    return sanitized || "attachment";
  }
  if (platform === "darwin") {
    return base.replace(/[:/\u0000]/gu, "_") || "attachment";
  }
  return base.replace(/[/\u0000]/gu, "_") || "attachment";
}

export function safeRawAgentChatFilename(
  chatName: string,
  chatId: string,
  platform: NodeJS.Platform
) {
  const source = (chatName.trim() || chatId).replace(/\.jsonl$/iu, "").slice(0, 180);
  const stem = source.replace(/[\\/]+/gu, "_").trim() || chatId;
  return safeDownloadName(`${stem}.jsonl`, platform);
}
