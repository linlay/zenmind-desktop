import path from "node:path";
import type { App } from "electron";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

type AssistantPathApp = Pick<App, "getPath">;

export type AssistantChatStoragePaths = {
  chatsDirectoryPath: string;
  chatDirectoryPath: string;
  chatFilePath: string;
};

export function resolveAssistantChatStoragePaths(
  app: AssistantPathApp,
  chatId: string,
  platform: NodeJS.Platform = process.platform,
): AssistantChatStoragePaths | null {
  const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
  if (!/^[A-Za-z0-9_-]+$/u.test(normalizedChatId)) {
    return null;
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const chatsDirectoryPath = pathApi.join(resolveRuntimeRoot(app, platform), "chats");
  return {
    chatsDirectoryPath,
    chatDirectoryPath: pathApi.join(chatsDirectoryPath, normalizedChatId),
    chatFilePath: pathApi.join(chatsDirectoryPath, `${normalizedChatId}.jsonl`),
  };
}
