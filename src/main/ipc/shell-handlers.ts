import fs from "node:fs";
import path from "node:path";
import {
  shell as electronShell,
  clipboard as electronClipboard,
  BrowserWindow as ElectronBrowserWindow
} from "electron";

export function registerShellIpcHandlers(ipcMain: any, options: any) {
  const shell = options.shell || electronShell;
  const clipboard = options.clipboard || electronClipboard;
  const BrowserWindow = options.BrowserWindow || ElectronBrowserWindow;

  function sanitizeDownloadFilename(filename: string, fallback: string) {
    const normalized = filename.trim() || fallback;
    return normalized.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").slice(0, 180) || fallback;
  }

  function getDesktopDownloadDefaultPath(filename: string) {
    const safeFilename = sanitizeDownloadFilename(filename, "download");
    const downloadsDir = options.platform === "win32" || options.platform === "darwin"
      ? options.app.getPath("downloads")
      : options.app.getPath("home");
    return path.join(downloadsDir, safeFilename);
  }

  async function getAvailableFilePath(targetPath: string) {
    const parsedPath = path.parse(targetPath);
    const fsAccess = options.fsAccess || fs.promises.access;
    for (let index = 0; index < 1000; index += 1) {
      const candidatePath =
        index === 0
          ? targetPath
          : path.join(parsedPath.dir, `${parsedPath.name} (${index})${parsedPath.ext}`);
      try {
        await fsAccess(candidatePath, fs.constants.F_OK);
      } catch {
        return candidatePath;
      }
    }
    return path.join(parsedPath.dir, `${parsedPath.name}-${Date.now()}${parsedPath.ext}`);
  }

  ipcMain.handle("shell.openExternal", async (_event: any, url: string) => {
    if (typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"))) {
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }
    return { ok: false, error: "invalid_protocol" };
  });

  ipcMain.handle("desktopDialog.selectDirectory", async (event: any) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? options.mainWindow;
      const result = await options.showFileDialog({
        title: "选择项目目录",
        properties: ["openDirectory", "createDirectory"]
      }, ownerWindow);
      if (result.canceled || result.filePaths.length === 0) {
        return {
          ok: false as const,
          path: "",
          message: "已取消选择目录。"
        };
      }
      return {
        ok: true as const,
        path: result.filePaths[0],
        message: "已选择目录。"
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopShell.openPath", async (_event: any, targetPath: string) => {
    try {
      return await options.revealPathInFileManager(targetPath, { targetType: "directory" }, {
        showItemInFolder: (pathToReveal: string) => shell.showItemInFolder(pathToReveal),
        openPath: (pathToOpen: string) => shell.openPath(pathToOpen),
        platform: options.platform
      });
    } catch (error) {
      return {
        ok: false as const,
        path: typeof targetPath === "string" ? targetPath : "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("clipboard.writeText", async (_event: any, text: string) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle("desktopDownloads.saveFile", async (_event: any, input: unknown) => {
    try {
      const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      const dataBase64 = typeof payload.dataBase64 === "string" ? payload.dataBase64 : "";
      
      const defaultPath = getDesktopDownloadDefaultPath(filename);
      const downloadPath = await getAvailableFilePath(defaultPath);
      
      const fsMkdir = options.fsMkdir || fs.promises.mkdir;
      const fsWriteFile = options.fsWriteFile || fs.promises.writeFile;
      
      await fsMkdir(path.dirname(downloadPath), { recursive: true });
      await fsWriteFile(downloadPath, Buffer.from(dataBase64, "base64"));
      
      return {
        ok: true as const,
        path: downloadPath,
        message: "已下载文件。"
      };
    } catch (error) {
      return {
        ok: false as const,
        path: "",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.on("diagnostics.rendererError", (event: any, report: any) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    options.reportRendererDiagnostic("renderer-error", {
      windowId: ownerWindow?.id ?? null,
      route: event.sender.getURL(),
      source: typeof report?.source === "string" ? report.source : "unknown",
      message: typeof report?.message === "string" ? report.message : String(report),
      stack: typeof report?.stack === "string" ? report.stack : undefined,
      componentStack: typeof report?.componentStack === "string" ? report.componentStack : undefined,
      filename: typeof report?.filename === "string" ? report.filename : undefined,
      lineno: typeof report?.lineno === "number" ? report.lineno : undefined,
      colno: typeof report?.colno === "number" ? report.colno : undefined
    });
  });
}
