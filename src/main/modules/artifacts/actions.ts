import fs from "node:fs/promises";
import type { BrowserWindow, IpcMain, SaveDialogOptions, SaveDialogReturnValue } from "electron";
import type { AssistantChatInfo } from "../../../shared/contracts";
import type { DesktopArtifactActionInput, DesktopArtifactActionResult } from "../../../shared/artifacts";

// Published URLs are encoded, chat-relative references, never arbitrary fetch URLs.
export function artifactRelativePath(url: unknown, _chatId: string): string | null {
  if (typeof url !== "string" || !url.startsWith("artifacts/") || url.length > 2048 || /[?#\\\u0000-\u001f\u007f]/u.test(url)) return null;
  try {
    const parts = url.split("/").map((part) => decodeURIComponent(part));
    if (parts.some((part) => !part || part === "." || part === ".." || /[/\\\u0000-\u001f\u007f]/u.test(part))) return null;
    return parts.join("/");
  } catch { return null; }
}

export function registerArtifactActionIpc(ipcMain: Pick<IpcMain, "handle">, ports: {
  getMainWindow(): BrowserWindow | null;
  getChatInfo(chatId: string): Promise<AssistantChatInfo | null>;
  fetchResource(input: { chatId: string; relativePath: string }): Promise<{ bytes: Buffer } | null>;
  showSaveDialog(options: SaveDialogOptions, owner?: BrowserWindow | null): Promise<SaveDialogReturnValue>;
}) {
  ipcMain.handle("artifacts.act", async (event, input: DesktopArtifactActionInput): Promise<DesktopArtifactActionResult> => {
    const window = ports.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false };
    if (!input || !["view", "download"].includes(input.action) ||
        typeof input.chatId !== "string" || !input.chatId || input.chatId.length > 256 || /[/\\\u0000-\u001f]/u.test(input.chatId) ||
        typeof input.artifactId !== "string" || !input.artifactId || input.artifactId.length > 256) return { ok: false };
    try {
      const info = await ports.getChatInfo(input.chatId);
      if (info?.chatId !== input.chatId || !info.agentKey) return { ok: false };
      // The current artifact projection is authoritative. Do not replay every message
      // through the Assistant event parser just to resolve a single resource.
      const detail = JSON.parse(info.rawJson);
      if (detail?.chatId !== input.chatId || !Array.isArray(detail.artifact?.items)) return { ok: false };
      const artifact = detail.artifact.items.find((value: unknown) => value && typeof value === "object" &&
        (value as Record<string, unknown>).artifactId === input.artifactId) as Record<string, unknown> | undefined;
      const relativePath = artifactRelativePath(artifact?.url, input.chatId);
      if (!relativePath) return { ok: false };
      const result = { ok: true as const, agentKey: info.agentKey, relativePath };
      if (input.action === "view") return result;
      const selected = await ports.showSaveDialog({ defaultPath: relativePath.split("/").at(-1) }, window);
      if (selected.canceled || !selected.filePath) return { ...result, cancelled: true };
      const resource = await ports.fetchResource({ chatId: input.chatId, relativePath });
      if (!resource) return { ok: false };
      await fs.writeFile(selected.filePath, resource.bytes);
      return result;
    } catch { return { ok: false }; }
  });
}
