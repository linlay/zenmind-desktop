const path = require("node:path");
const {
  app,
  BrowserWindow,
  systemPreferences
} = require("electron");

const { captureScreenshotForBridge } = require(path.join(
  process.cwd(),
  "dist-electron",
  "main",
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

  const readyTimer = setInterval(() => {
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
    console.log(`SCREENSHOT_OVERLAY_READY ${process.pid}`);
  }, OVERLAY_POLL_INTERVAL_MS);
});

setTimeout(() => app.quit(), EXIT_TIMEOUT_MS);
