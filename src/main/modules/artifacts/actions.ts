import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { App, BrowserWindow, IpcMain, SaveDialogOptions, SaveDialogReturnValue, Shell } from "electron";
import type { AssistantChatInfo } from "../../../shared/contracts";
import type { DesktopArtifactActionInput, DesktopArtifactActionResult } from "../../../shared/artifacts";
import { artifactExternalExtension } from "../../../shared/artifacts";
import { resolveArtifactLocalFile } from "./local-file";
import { artifactError } from "./platform-client";
import { validIdentity } from "./metadata";
import type { ArtifactActionLibrary } from "./ports";

// Published URLs are chat-relative references, never arbitrary fetch URLs.
// "@chat/artifacts/..." carries the literal path; the bare form is encoded.
export function artifactRelativePath(url: unknown, _chatId: string): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  if (/^@chat\//iu.test(url)) {
    const literal = url.slice("@chat/".length);
    const parts = literal.split("/");
    return literal.startsWith("artifacts/") && !/[\\\u0000-\u001f\u007f]/u.test(literal) &&
      parts.every((part) => part && part !== "." && part !== "..") ? literal : null;
  }
  if (!url.startsWith("artifacts/") || /[?#\\\u0000-\u001f\u007f]/u.test(url)) return null;
  try {
    const parts = url.split("/").map((part) => decodeURIComponent(part));
    if (parts.some((part) => !part || part === "." || part === ".." || /[/\\\u0000-\u001f\u007f]/u.test(part))) return null;
    return parts.join("/");
  } catch { return null; }
}

export function registerArtifactActionIpc(ipcMain: Pick<IpcMain, "handle">, ports: {
  library?: ArtifactActionLibrary;
  getMainWindow(): BrowserWindow | null;
  getChatInfo(chatId: string): Promise<AssistantChatInfo | null>;
  getRuntimeRoot(): string;
  showSaveDialog(options: SaveDialogOptions, owner?: BrowserWindow | null): Promise<SaveDialogReturnValue>;
  app?: Pick<App, "getApplicationInfoForProtocol">;
  fileShell?: Pick<Shell, "showItemInFolder" | "openPath">;
  platform?: NodeJS.Platform;
  launchBrowser?: (command: string, args: string[]) => Promise<void>;
}) {
  ipcMain.handle("artifacts.act", async (event, input: DesktopArtifactActionInput): Promise<DesktopArtifactActionResult> => {
    const window = ports.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false };
    if (!validIdentity(input) || !["view", "download", "reveal", "open-default", "open-browser"].includes(input.action)) return { ok: false };
    const context = ports.library?.actionContext(input);
    if (!context?.record) return { ok: false, error: "missing" };
    const item = context.record;
    if (item.sourceState !== "active") return { ok: false, error: item.sourceState };
    if (!input.runId || item.contentState === "unresolved") return { ok: false, error: "unresolved" };
    if (item.contentState === "ambiguous") return { ok: false, error: "ambiguous" };
    const current = () => context.isCurrent() && ports.getMainWindow() === window && !window.isDestroyed() &&
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
    try {
      const info = await ports.getChatInfo(input.chatId);
      if (!current() || info?.chatId !== input.chatId || !info.agentKey) return { ok: false };
      // The current artifact projection is authoritative. Do not replay every message
      // through the Assistant event parser just to resolve a single resource.
      const detail = JSON.parse(info.rawJson);
      if (detail?.chatId !== input.chatId || !Array.isArray(detail.artifact?.items)) return { ok: false };
      const matches = detail.artifact.items.filter((value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const artifact = value as Record<string, unknown>;
        return artifact.artifactId === input.artifactId && artifactRelativePath(artifact.url, input.chatId)?.split("/")[1] === input.runId;
      }) as Record<string, unknown>[];
      if (matches.length !== 1) {
        ports.library?.reportFailure(input, matches.length ? "artifact_ambiguous" : "artifact_not_found");
        return { ok: false, error: matches.length ? "ambiguous" : "missing" };
      }
      const artifact = matches[0];
      const relativePath = artifactRelativePath(artifact?.url, input.chatId);
      if (!relativePath) return { ok: false };
      const result = { ok: true as const, agentKey: info.agentKey, relativePath };
      if (input.action === "view") return result;
      // The source projection, rather than renderer metadata, decides which files can launch externally.
      const external = input.action === "open-default" || input.action === "open-browser";
      const extension = external ? artifactExternalExtension(relativePath, typeof artifact?.mimeType === "string" ? artifact.mimeType : "") : null;
      if (external && !extension) return { ok: false };
      if (input.action === "download") {
        const selected = await ports.showSaveDialog({ defaultPath: path.posix.basename(relativePath) }, window);
        if (selected.canceled || !selected.filePath) return { ...result, cancelled: true };
        if (!current()) return { ok: false };
        const bytes = await ports.library!.read({ chatId: input.chatId, runId: input.runId, artifactId: input.artifactId }, AbortSignal.timeout(30_000));
        if (!current()) return { ok: false };
        await fs.writeFile(selected.filePath, bytes);
        return result;
      }
      const platform = ports.platform ?? process.platform;
      const resolveLocal = () => resolveArtifactLocalFile(ports.getRuntimeRoot(), input.chatId, relativePath, platform);
      const target = resolveLocal();
      if (!target || (external && !artifactExternalExtension(target, ""))) return { ok: false };
      if (!current()) return { ok: false };
      if (input.action === "reveal") {
        if (!ports.fileShell) return { ok: false };
        if (platform === "darwin") ports.fileShell.showItemInFolder(target);
        else if (platform === "win32") ports.fileShell.showItemInFolder(target);
        else return { ok: false };
      } else if (input.action === "open-default") {
        if (!ports.fileShell || (await ports.fileShell.openPath(target))) return { ok: false };
      } else if (input.action === "open-browser") {
        if (!ports.app || (platform !== "darwin" && platform !== "win32")) return { ok: false };
        const browser = await ports.app.getApplicationInfoForProtocol("https://example.com");
        if (!current() || !browser.path || resolveLocal() !== target) return { ok: false };
        const launch = ports.launchBrowser ?? launchExternalBrowser;
        if (platform === "darwin") await launch("/usr/bin/open", ["-a", browser.path, target]);
        else if (platform === "win32") await launch(browser.path, [pathToFileURL(target).href]);
      }
      return result;
    } catch (error) {
      const code = artifactError(error);
      if (current()) ports.library?.reportFailure(input, code);
      return { ok: false, error: code === "artifact_changed" ? "changed" : code === "artifact_ambiguous" ? "ambiguous" :
        code === "artifact_not_found" ? "missing" : code === "chat_access_denied" ? "denied" : "failed" };
    }
  });
}

function launchExternalBrowser(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
