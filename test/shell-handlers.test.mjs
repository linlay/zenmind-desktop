import test from "node:test";
import assert from "node:assert/strict";

const { registerShellIpcHandlers } = await import("../dist-electron/main/ipc/shell-handlers.js");

test("registerShellIpcHandlers registers shell.openExternal and validates protocol", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    },
    on() {}
  };

  let openedUrl = null;
  const mockShell = {
    async openExternal(url) {
      openedUrl = url;
    }
  };

  const mockOptions = {
    shell: mockShell
  };

  registerShellIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["shell.openExternal"], "Should register shell.openExternal");

  // Valid https URL
  const res1 = await handlers["shell.openExternal"]({}, "https://example.com");
  assert.deepEqual(res1, { ok: true });
  assert.equal(openedUrl, "https://example.com");

  // Invalid protocol
  const res2 = await handlers["shell.openExternal"]({}, "file:///etc/passwd");
  assert.deepEqual(res2, { ok: false, error: "invalid_protocol" });

  // Handle openExternal throwing
  mockShell.openExternal = () => Promise.reject(new Error("failed"));
  const res3 = await handlers["shell.openExternal"]({}, "https://example.com");
  assert.deepEqual(res3, { ok: false, error: "Error: failed" });
});

test("registerShellIpcHandlers registers dialog, path and clipboard handlers", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    },
    on() {}
  };

  let fileDialogOptions = null;
  let fileDialogOwnerWindow = null;
  let fileDialogResult = null;

  let revealedPath = null;
  let revealResult = null;

  let writtenText = null;

  const mockOptions = {
    platform: "win32",
    mainWindow: { id: 1 },
    async showFileDialog(options, ownerWindow) {
      fileDialogOptions = options;
      fileDialogOwnerWindow = ownerWindow;
      if (fileDialogResult instanceof Error) throw fileDialogResult;
      return fileDialogResult;
    },
    async revealPathInFileManager(targetPath, options, fsOptions) {
      revealedPath = targetPath;
      if (revealResult instanceof Error) throw revealResult;
      return revealResult;
    },
    clipboard: {
      writeText(text) {
        if (text === "throw") throw new Error("clipboard failed");
        writtenText = text;
      }
    }
  };

  registerShellIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["desktopDialog.selectDirectory"], "Should register desktopDialog.selectDirectory");
  assert.ok(handlers["desktopShell.openPath"], "Should register desktopShell.openPath");
  assert.ok(handlers["clipboard.writeText"], "Should register clipboard.writeText");

  // 1. Test selectDirectory success
  fileDialogResult = { canceled: false, filePaths: ["/selected/dir"] };
  const mockSender = { id: 2 };
  const mockBrowserWindow = {
    fromWebContents(sender) {
      assert.equal(sender, mockSender);
      return { id: 3 };
    }
  };
  const mockOptionsWithBW = { ...mockOptions, BrowserWindow: mockBrowserWindow };
  const handlersWithBW = {};
  const mockIpcMainWithBW = {
    handle(channel, callback) {
      handlersWithBW[channel] = callback;
    },
    on() {}
  };
  registerShellIpcHandlers(mockIpcMainWithBW, mockOptionsWithBW);
  
  const resSelect = await handlersWithBW["desktopDialog.selectDirectory"]({ sender: mockSender });
  assert.deepEqual(resSelect, { ok: true, path: "/selected/dir", message: "已选择目录。" });
  assert.deepEqual(fileDialogOptions, {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"]
  });
  assert.deepEqual(fileDialogOwnerWindow, { id: 3 });

  // 2. Test selectDirectory canceled
  fileDialogResult = { canceled: true, filePaths: [] };
  const resCancel = await handlersWithBW["desktopDialog.selectDirectory"]({ sender: mockSender });
  assert.deepEqual(resCancel, { ok: false, path: "", message: "已取消选择目录。" });

  // 3. Test selectDirectory throwing error
  fileDialogResult = new Error("dialog error");
  const resError = await handlersWithBW["desktopDialog.selectDirectory"]({ sender: mockSender });
  assert.deepEqual(resError, { ok: false, path: "", message: "dialog error" });

  // 4. Test openPath success
  revealResult = { ok: true, path: "/open/path", message: "path opened" };
  const resOpen = await handlers["desktopShell.openPath"]({}, "/open/path");
  assert.deepEqual(resOpen, { ok: true, path: "/open/path", message: "path opened" });
  assert.equal(revealedPath, "/open/path");

  // 5. Test openPath throwing error
  revealResult = new Error("reveal error");
  const resRevealError = await handlers["desktopShell.openPath"]({}, "/open/path");
  assert.deepEqual(resRevealError, { ok: false, path: "/open/path", message: "reveal error" });

  // 6. Test clipboard success
  const resClip = await handlers["clipboard.writeText"]({}, "hello");
  assert.deepEqual(resClip, { ok: true });
  assert.equal(writtenText, "hello");

  // 7. Test clipboard error
  const resClipError = await handlers["clipboard.writeText"]({}, "throw");
  assert.deepEqual(resClipError, { ok: false, message: "clipboard failed" });
});

test("registerShellIpcHandlers registers desktopDownloads.saveFile and manages filename conflict", async () => {
  const handlers = {};
  const mockIpcMain = {
    handle(channel, callback) {
      handlers[channel] = callback;
    },
    on() {}
  };

  const mockApp = {
    getPath(name) {
      if (name === "downloads") return "C:\\Users\\test\\Downloads";
      if (name === "home") return "C:\\Users\\test";
      return "";
    }
  };

  let mkdirDir = null;
  let writeFilePath = null;
  let writeFileBuffer = null;

  const existingPaths = new Set([
    "C:\\Users\\test\\Downloads\\report.pdf",
    "C:\\Users\\test\\Downloads\\report (1).pdf"
  ]);

  const mockOptions = {
    platform: "win32",
    app: mockApp,
    async fsMkdir(dir, options) {
      mkdirDir = dir;
    },
    async fsWriteFile(filePath, data) {
      writeFilePath = filePath;
      writeFileBuffer = data;
    },
    async fsAccess(filePath, mode) {
      if (existingPaths.has(filePath)) {
        return Promise.resolve(); // Path exists
      }
      return Promise.reject(new Error("enoent")); // Path does not exist
    }
  };

  registerShellIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(handlers["desktopDownloads.saveFile"], "Should register desktopDownloads.saveFile");

  // Test downloading and auto-incrementing file path when conflict exists
  const res = await handlers["desktopDownloads.saveFile"]({}, {
    filename: "report.pdf",
    dataBase64: "aGVsbG8=" // "hello" in base64
  });

  assert.deepEqual(res, {
    ok: true,
    path: "C:\\Users\\test\\Downloads\\report (2).pdf",
    message: "已下载文件。"
  });

  assert.equal(mkdirDir, "C:\\Users\\test\\Downloads");
  assert.equal(writeFilePath, "C:\\Users\\test\\Downloads\\report (2).pdf");
  assert.equal(writeFileBuffer.toString("utf8"), "hello");

  const invalidRes = await handlers["desktopDownloads.saveFile"]({}, {
    filename: "report.pdf"
  });
  assert.deepEqual(invalidRes, {
    ok: false,
    path: "",
    message: "下载请求无效。"
  });
});

test("registerShellIpcHandlers listens to diagnostics.rendererError", () => {
  const listeners = {};
  const mockIpcMain = {
    handle() {},
    on(event, callback) {
      listeners[event] = callback;
    }
  };

  let diagnosticReported = null;
  const mockOptions = {
    BrowserWindow: {
      fromWebContents(sender) {
        return { id: sender.id };
      }
    },
    reportRendererDiagnostic(source, data) {
      diagnosticReported = { source, data };
    }
  };

  registerShellIpcHandlers(mockIpcMain, mockOptions);

  assert.ok(listeners["diagnostics.rendererError"], "Should register listener for diagnostics.rendererError");

  const mockSender = {
    id: 42,
    getURL() {
      return "https://example.com/page";
    }
  };

  const mockReport = {
    source: "renderer",
    message: "Some error",
    stack: "Some stack"
  };

  listeners["diagnostics.rendererError"]({ sender: mockSender }, mockReport);

  assert.deepEqual(diagnosticReported, {
    source: "renderer-error",
    data: {
      windowId: 42,
      route: "https://example.com/page",
      source: "renderer",
      message: "Some error",
      stack: "Some stack",
      componentStack: undefined,
      filename: undefined,
      lineno: undefined,
      colno: undefined
    }
  });
});
