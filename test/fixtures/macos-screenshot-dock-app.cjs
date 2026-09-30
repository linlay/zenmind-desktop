const path = require("node:path");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
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

  const capture = captureScreenshotForBridge({
    platform: "darwin",
    getMainWindow: () => mainWindow,
    delay: async () => undefined
  }, "region");

  const readyTimer = setInterval(async () => {
    const overlayWindows = BrowserWindow.getAllWindows().filter((candidate) =>
      candidate.getTitle().includes("Screenshot Selection")
    );
    const displays = screen.getAllDisplays();
    if (
      overlayWindows.length !== displays.length ||
      overlayWindows.some((window) => !window.isVisible() || !window.isVisibleOnAllWorkspaces())
    ) {
      return;
    }
    clearInterval(readyTimer);
    const overlays = await Promise.all(overlayWindows.map(async (window) => {
      const display = screen.getDisplayMatching(window.getBounds());
      return {
        displayId: display.id,
        bounds: window.getBounds(),
        displayBounds: display.bounds,
        viewport: await window.webContents.executeJavaScript("({ width: innerWidth, height: innerHeight })"),
        focused: window.isFocused()
      };
    }));
    console.log(`SCREENSHOT_OVERLAY_READY ${JSON.stringify({
      pid: process.pid,
      displayCount: displays.length,
      preferredDisplayId: screen.getDisplayMatching(mainWindow.getBounds()).id,
      overlays
    })}`);

    process.stdin.once("data", async (chunk) => {
      const action = chunk.toString().trim();
      const target = overlayWindows.find((window) => !window.isFocused()) ?? overlayWindows[0];
      const selectedDisplay = screen.getDisplayMatching(target.getBounds());
      target.focus();
      if (action === "drag") {
        // Exercise real renderer input and navigation without reading the user's desktop.
        const pixel = nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 });
        desktopCapturer.getSources = async () => displays.map((display) => ({
          display_id: String(display.id),
          thumbnail: pixel.resize({
            width: Math.round(display.bounds.width * display.scaleFactor),
            height: Math.round(display.bounds.height * display.scaleFactor)
          })
        }));
        target.webContents.sendInputEvent({ type: "mouseDown", x: 100, y: 100, button: "left", clickCount: 1 });
        target.webContents.sendInputEvent({ type: "mouseMove", x: 300, y: 250, button: "left" });
        target.webContents.sendInputEvent({ type: "mouseUp", x: 300, y: 250, button: "left", clickCount: 1 });
      } else if (action === "right-click") {
        target.webContents.sendInputEvent({ type: "mouseDown", x: 100, y: 100, button: "right", clickCount: 1 });
        target.webContents.sendInputEvent({ type: "mouseUp", x: 100, y: 100, button: "right", clickCount: 1 });
      } else {
        target.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        target.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      }
      const result = await capture;
      console.log(`SCREENSHOT_SELECTION_RESULT ${JSON.stringify({
        action,
        ok: result.ok,
        cancelled: result.cancelled === true,
        width: result.width,
        height: result.height,
        expectedWidth: Math.round(200 * selectedDisplay.scaleFactor),
        expectedHeight: Math.round(150 * selectedDisplay.scaleFactor),
        remainingOverlays: BrowserWindow.getAllWindows().filter((window) => window.getTitle().includes("Screenshot Selection")).length
      })}`);
    });
  }, OVERLAY_POLL_INTERVAL_MS);
});

setTimeout(() => app.quit(), EXIT_TIMEOUT_MS);
