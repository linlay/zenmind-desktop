const path = require("node:path");
const {
  app,
  BrowserWindow,
  screen,
  systemPreferences
} = require("electron");

const { captureScreenshotForBridge } = require(path.join(
  process.cwd(),
  "dist-electron",
  "main",
  "modules",
  "assistant",
  "copilot",
  "screenshot.js"
));

const EXIT_TIMEOUT_MS = 15_000;
const OVERLAY_POLL_INTERVAL_MS = 20;

app.whenReady().then(async () => {
  systemPreferences.getMediaAccessStatus = () => "granted";

  const mainWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: true
  });
  await mainWindow.loadURL("data:text/html,<h1>Screenshot Dock visibility probe</h1>");

  void captureScreenshotForBridge({
    platform: "darwin",
    getMainWindow: () => mainWindow,
    delay: async () => undefined
  }, "region");

  const readyTimer = setInterval(async () => {
    const overlayWindow = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.getTitle().includes("Screenshot Selection")
    );
    if (
      !overlayWindow ||
      !overlayWindow.isVisible() ||
      !overlayWindow.isVisibleOnAllWorkspaces()
    ) {
      return;
    }
    clearInterval(readyTimer);
    const viewport = await overlayWindow.webContents.executeJavaScript(
      "({ width: innerWidth, height: innerHeight })"
    );
    console.log(`SCREENSHOT_OVERLAY_READY ${JSON.stringify({
      pid: process.pid,
      bounds: overlayWindow.getBounds(),
      displayBounds: screen.getDisplayMatching(mainWindow.getBounds()).bounds,
      viewport
    })}`);
  }, OVERLAY_POLL_INTERVAL_MS);
});

setTimeout(() => app.quit(), EXIT_TIMEOUT_MS);
