import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { shell, type App, type BrowserWindow, type Shell } from "electron";
import type { WorkPanelDocumentHtmlFileActionRequest, WorkPanelDocumentHtmlActionResult } from "../../../shared/work-panel-document-html";
import { t } from "../../support/i18n/main-i18n";
import { resolveDocumentLocalPath, type HtmlPreviewDocument } from "./document-html-preview";

export type HtmlFileActionRuntime = {
  app: App;
  getMainWindow(): BrowserWindow | null;
  showSaveDialog?(options: Electron.SaveDialogOptions, owner?: BrowserWindow | null): Promise<Electron.SaveDialogReturnValue>;
  platform?: NodeJS.Platform;
  fileShell?: Pick<Shell, "openPath" | "showItemInFolder">;
  launchBrowser?: (command: string, args: string[]) => Promise<void>;
};

function launchBrowser(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function performHtmlFileAction(
  document: HtmlPreviewDocument & { fileName: string; localOriginal: boolean },
  action: WorkPanelDocumentHtmlFileActionRequest["action"],
  runtime: HtmlFileActionRuntime,
  stillOwned: () => boolean,
): Promise<WorkPanelDocumentHtmlActionResult> {
  const fail = () => ({ ok: false, message: t("chatWorkPanel.resourceActions.failed") });
  if (!["reveal", "open-default", "open-browser", "save-copy"].includes(action)) return fail();
  const platform = runtime.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return fail();
  const fileShell = runtime.fileShell ?? shell;
  let target = resolveDocumentLocalPath(document);
  if (!stillOwned() || !target || (action === "reveal" && !document.localOriginal)) return fail();
  try {
    if (action === "save-copy" || !document.localOriginal) {
      if (!runtime.showSaveDialog) return fail();
      const selected = await runtime.showSaveDialog({
        defaultPath: path.join(runtime.app.getPath("downloads"), document.fileName),
        filters: [{ name: "HTML", extensions: ["html", "htm", "xhtml"] }],
      }, runtime.getMainWindow());
      if (selected.canceled || !selected.filePath) return { ok: true };
      target = resolveDocumentLocalPath(document);
      if (!stillOwned() || !target) return fail();
      if (path.resolve(selected.filePath) !== path.resolve(target)) await fs.promises.copyFile(target, selected.filePath);
      if (!stillOwned()) return fail();
      target = selected.filePath;
      if (action === "save-copy") return { ok: true };
    }
    if (action === "reveal") {
      // Electron has platform-specific Finder/Explorer selection behavior.
      if (platform === "darwin") fileShell.showItemInFolder(target);
      else if (platform === "win32") fileShell.showItemInFolder(target);
    } else if (action === "open-default") {
      const error = await fileShell.openPath(target);
      if (error) return fail();
    } else if (action === "open-browser") {
      // file:// uses the .html association (possibly an editor), not the browser.
      const browser = await runtime.app.getApplicationInfoForProtocol("https://example.com");
      if (!browser.path || !stillOwned()) return fail();
      if (document.localOriginal) {
        target = resolveDocumentLocalPath(document);
        if (!target) return fail();
      }
      const launch = runtime.launchBrowser ?? launchBrowser;
      if (platform === "darwin") await launch("/usr/bin/open", ["-a", browser.path, target]);
      else if (platform === "win32") await launch(browser.path, [pathToFileURL(target).href]);
    }
    return { ok: true };
  } catch { return fail(); }
}
