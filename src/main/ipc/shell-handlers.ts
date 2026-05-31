import fs from "node:fs";
import {
  shell as electronShell,
  clipboard as electronClipboard,
  BrowserWindow as ElectronBrowserWindow
} from "electron";
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  getAvailableFilePath,
  getDesktopDownloadDefaultPath,
  getPlatformPath
} from "../download-paths";

type ShellIpcResult = {
  ok: boolean;
  path?: string;
  message?: string;
};

type ShellIpcOptions = {
  shell?: typeof electronShell;
  clipboard?: typeof electronClipboard;
  BrowserWindow?: Pick<typeof ElectronBrowserWindow, "fromWebContents">;
  app?: {
    getPath: (name: string) => string;
  };
  platform?: NodeJS.Platform | string;
  mainWindow?: BrowserWindow | null;
  showFileDialog?: (
    options: { title: string; properties: Array<"openDirectory" | "createDirectory"> },
    ownerWindow?: BrowserWindow | null
  ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  revealPathInFileManager?: (
    targetPath: string,
    options: { targetType: "directory" },
    fsOptions: {
      showItemInFolder: (pathToReveal: string) => void;
      openPath: (pathToOpen: string) => Promise<string>;
      platform?: NodeJS.Platform | string;
    }
  ) => Promise<ShellIpcResult>;
  fsAccess?: (filePath: string, mode?: number) => Promise<unknown>;
  fsMkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>;
  fsWriteFile?: (filePath: string, data: Buffer) => Promise<unknown>;
  reportRendererDiagnostic?: (source: string, data: Record<string, unknown>) => void;
};

type DesktopDownloadPayload = {
  filename?: string;
  dataBase64: string;
};

export function registerShellIpcHandlers(ipcMain: Pick<IpcMain, "handle" | "on">, options: ShellIpcOptions) {
  const shell = options.shell || electronShell;
  const clipboard = options.clipboard || electronClipboard;
  const BrowserWindow = options.BrowserWindow || ElectronBrowserWindow;

  function isDesktopDownloadPayload(input: unknown): input is DesktopDownloadPayload {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const payload = input as Record<string, unknown>;
    return typeof payload.dataBase64 === "string";
  }

  ipcMain.handle("shell.openExternal", async (_event: IpcMainInvokeEvent, url: string) => {
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

  ipcMain.handle("desktopDialog.selectDirectory", async (event: IpcMainInvokeEvent) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? options.mainWindow;
      const result = await options.showFileDialog?.({
        title: "选择项目目录",
        properties: ["openDirectory", "createDirectory"]
      }, ownerWindow);
      if (!result || result.canceled || result.filePaths.length === 0) {
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

  ipcMain.handle("desktopShell.openPath", async (_event: IpcMainInvokeEvent, targetPath: string) => {
    try {
      return await options.revealPathInFileManager?.(targetPath, { targetType: "directory" }, {
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

  ipcMain.handle("clipboard.writeText", async (_event: IpcMainInvokeEvent, text: string) => {
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

  ipcMain.handle("desktopDownloads.saveFile", async (_event: IpcMainInvokeEvent, input: unknown) => {
    try {
      if (!isDesktopDownloadPayload(input)) {
        return {
          ok: false as const,
          path: "",
          message: "下载请求无效。"
        };
      }
      const filename = typeof input.filename === "string" ? input.filename : "";
      const dataBase64 = input.dataBase64;
      
      const defaultPath = getDesktopDownloadDefaultPath(options.app, filename, options.platform);
      const downloadPath = await getAvailableFilePath(defaultPath, {
        platform: options.platform,
        fsAccess: options.fsAccess
      });
      const platformPath = getPlatformPath(options.platform);
      
      const fsMkdir = options.fsMkdir || fs.promises.mkdir;
      const fsWriteFile = options.fsWriteFile || fs.promises.writeFile;
      
      await fsMkdir(platformPath.dirname(downloadPath), { recursive: true });
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

  ipcMain.on("diagnostics.rendererError", (event: IpcMainEvent, report: unknown) => {
    const rendererReport = report && typeof report === "object" ? report as Record<string, unknown> : {};
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    options.reportRendererDiagnostic?.("renderer-error", {
      windowId: ownerWindow?.id ?? null,
      route: event.sender.getURL(),
      source: typeof rendererReport.source === "string" ? rendererReport.source : "unknown",
      message: typeof rendererReport.message === "string" ? rendererReport.message : String(report),
      stack: typeof rendererReport.stack === "string" ? rendererReport.stack : undefined,
      componentStack: typeof rendererReport.componentStack === "string" ? rendererReport.componentStack : undefined,
      filename: typeof rendererReport.filename === "string" ? rendererReport.filename : undefined,
      lineno: typeof rendererReport.lineno === "number" ? rendererReport.lineno : undefined,
      colno: typeof rendererReport.colno === "number" ? rendererReport.colno : undefined
    });
  });
}
