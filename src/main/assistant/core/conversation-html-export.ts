import fs from "node:fs";
import type { App } from "electron";
import type { AssistantNavActionResult } from "../../../shared/contracts";
import { getAssistantExportDefaultPath, getAvailableFilePath, getPlatformPath } from "../../download-paths";
import { t } from "../../i18n/main-i18n";
import { MAX_CONVERSATION_HTML_BYTES } from "./conversation-export-contract";
import { resolveConversationAssetOrigin } from "./conversation-share-target";

export { MAX_CONVERSATION_HTML_BYTES } from "./conversation-export-contract";

type ConversationHtmlExportBridge = {
  downloadChatHtmlExport(
    chatId: string,
    assetOrigin: string
  ): Promise<{ ok: true; bytes: Buffer; filename: string; message: string } | { ok: false; message: string }>;
};

export async function saveConversationHtmlExport(
  app: App,
  assistantBridge: ConversationHtmlExportBridge,
  chatId: string,
  platform: NodeJS.Platform | string = process.platform
): Promise<AssistantNavActionResult> {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) {
    return { ok: false, message: t("assistant.chatIdRequired") };
  }

  const assetOrigin = resolveConversationAssetOrigin(app);
  if (!assetOrigin.ok) return assetOrigin;
  const result = await assistantBridge.downloadChatHtmlExport(normalizedChatId, assetOrigin.origin);
  if (!result.ok) return { ok: false, message: result.message };
  if (result.bytes.byteLength > MAX_CONVERSATION_HTML_BYTES) {
    return {
      ok: false,
      message: t("assistant.chatHtmlExportTooLarge", {
        actual: result.bytes.byteLength,
        limit: MAX_CONVERSATION_HTML_BYTES
      })
    };
  }

  const filename = conversationHtmlFilename(result.filename, normalizedChatId);
  const exportPath = await getAvailableFilePath(getAssistantExportDefaultPath(app, filename, platform), { platform });
  try {
    await fs.promises.mkdir(getPlatformPath(platform).dirname(exportPath), {
      recursive: true
    });
    await fs.promises.writeFile(exportPath, result.bytes);
  } catch (error) {
    return {
      ok: false,
      message: t("assistant.chatHtmlExportFailed", {
        message: error instanceof Error ? error.message : String(error)
      })
    };
  }
  return {
    ok: true,
    message: t("assistant.chatHtmlExportDownloaded"),
    filePath: exportPath
  };
}

export function conversationHtmlFilename(platformFilename: string, chatId: string): string {
  const normalized = platformFilename.trim();
  return /\.html$/iu.test(normalized) ? normalized : `${chatId.trim() || "conversation"}.html`;
}
