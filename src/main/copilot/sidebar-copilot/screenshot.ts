import {
  BrowserWindow,
  desktopCapturer,
  screen,
  systemPreferences,
  type App,
  type Display,
  type NativeImage,
  type Rectangle
} from "electron";
import { PRODUCT_NAME } from "../../../shared/generated/brand";
import { createAssistantAttachmentFromImageBuffer } from "../attachments/attachment-store";

export type ScreenshotCaptureSource = "sidebar" | "quick-assistant";

type ScreenshotSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CaptureAssistantScreenshotOptions = {
  app: App;
  chatId: string | null | undefined;
  source: ScreenshotCaptureSource;
  platform: NodeJS.Platform;
  getMainWindow: () => BrowserWindow | null;
  getQuickCopilotWindow: () => BrowserWindow | null;
  hideQuickCopilotDismissWindow: () => void;
  showQuickCopilotDismissWindow: () => void;
  delay: (ms: number) => Promise<void>;
};

function createScreenshotSelectionHtml(selectionId: string) {
  const doneUrl = `zenmind://screenshot-selection/${selectionId}`;
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;}",
    "body{cursor:crosshair;user-select:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
    "#shade{position:fixed;inset:-2px;background:rgba(15,23,42,.24);pointer-events:none;}",
    "#box{position:fixed;display:none;border:2px solid rgba(59,130,246,.98);background:rgba(59,130,246,.16);box-shadow:0 0 0 9999px rgba(15,23,42,.38),0 12px 30px rgba(15,23,42,.22);}",
    "#hint{position:fixed;left:50%;top:28px;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:rgba(17,24,39,.82);color:#fff;font-size:13px;font-weight:650;letter-spacing:.01em;box-shadow:0 10px 30px rgba(15,23,42,.24);}",
    "</style>",
    "</head>",
    "<body>",
    "<div id=\"shade\" aria-hidden=\"true\"></div>",
    "<div id=\"box\" aria-hidden=\"true\"></div>",
    "<div id=\"hint\">拖拽选择截屏范围，Esc 取消</div>",
    "<script>",
    `const doneUrl=${JSON.stringify(doneUrl)};`,
    "const box=document.getElementById('box');",
    "const hint=document.getElementById('hint');",
    "const minSize=8;",
    "let dragging=false;",
    "let startX=0;",
    "let startY=0;",
    "let currentRect=null;",
    "function clamp(value,min,max){return Math.max(min,Math.min(value,max));}",
    "function finish(action,rect){const params=new URLSearchParams({action});if(rect){params.set('rect',JSON.stringify(rect));}window.location.href=doneUrl+'?'+params.toString();}",
    "function updateBox(clientX,clientY){const endX=clamp(clientX,0,window.innerWidth);const endY=clamp(clientY,0,window.innerHeight);const x=Math.min(startX,endX);const y=Math.min(startY,endY);const width=Math.abs(endX-startX);const height=Math.abs(endY-startY);currentRect={x,y,width,height};box.style.display='block';box.style.left=x+'px';box.style.top=y+'px';box.style.width=width+'px';box.style.height=height+'px';}",
    "window.addEventListener('pointerdown',(event)=>{if(event.button!==0){return;}dragging=true;startX=clamp(event.clientX,0,window.innerWidth);startY=clamp(event.clientY,0,window.innerHeight);currentRect={x:startX,y:startY,width:0,height:0};hint.textContent='松开鼠标完成截屏，Esc 取消';box.style.display='block';updateBox(event.clientX,event.clientY);try{document.body.setPointerCapture(event.pointerId);}catch{}});",
    "window.addEventListener('pointermove',(event)=>{if(!dragging){return;}updateBox(event.clientX,event.clientY);});",
    "window.addEventListener('pointerup',(event)=>{if(!dragging){return;}dragging=false;try{document.body.releasePointerCapture(event.pointerId);}catch{}updateBox(event.clientX,event.clientY);if(!currentRect||currentRect.width<minSize||currentRect.height<minSize){box.style.display='none';hint.textContent='范围太小，请拖拽选择更大的区域，Esc 取消';return;}finish('select',currentRect);});",
    "window.addEventListener('keydown',(event)=>{if(event.key==='Escape'){finish('cancel');}});",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}

function parseScreenshotSelectionUrl(value: string, selectionId: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "zenmind:" ||
      url.hostname !== "screenshot-selection" ||
      url.pathname !== `/${selectionId}`
    ) {
      return undefined;
    }
    if (url.searchParams.get("action") === "cancel") {
      return null;
    }
    const rawRect = url.searchParams.get("rect");
    if (!rawRect) {
      return null;
    }
    const rect = JSON.parse(rawRect) as Partial<ScreenshotSelectionRect>;
    if (
      typeof rect.x !== "number" ||
      typeof rect.y !== "number" ||
      typeof rect.width !== "number" ||
      typeof rect.height !== "number" ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      return null;
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  } catch {
    return undefined;
  }
}

function selectScreenshotRegion(display: Display, platform: NodeJS.Platform) {
  return new Promise<ScreenshotSelectionRect | null>((resolve) => {
    const selectionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const overlayWindow = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      ...(platform === "darwin" ? { roundedCorners: false } : {}),
      backgroundColor: "#00000000",
      title: `${PRODUCT_NAME} Screenshot Selection`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    let settled = false;
    const settle = (rect: ScreenshotSelectionRect | null) => {
      if (settled) {
        return;
      }
      settled = true;
      overlayWindow.webContents.off("will-navigate", handleNavigate);
      if (!overlayWindow.isDestroyed()) {
        overlayWindow.close();
      }
      resolve(rect);
    };
    const handleNavigate = (event: Electron.Event, url: string) => {
      const selection = parseScreenshotSelectionUrl(url, selectionId);
      if (selection === undefined) {
        return;
      }
      event.preventDefault();
      settle(selection);
    };

    if (platform === "darwin") {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else if (platform === "win32") {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    } else {
      overlayWindow.setAlwaysOnTop(true);
    }

    overlayWindow.webContents.on("will-navigate", handleNavigate);
    overlayWindow.on("closed", () => settle(null));
    overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createScreenshotSelectionHtml(selectionId))}`)
      .then(() => {
        if (overlayWindow.isDestroyed()) {
          return;
        }
        overlayWindow.show();
        overlayWindow.moveTop();
        overlayWindow.focus();
      })
      .catch(() => settle(null));
  });
}

function getScreenshotPermissionMessage(platform: NodeJS.Platform) {
  if (platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "denied" || status === "restricted") {
      return `${PRODUCT_NAME} 没有屏幕录制权限。请在系统设置 > 隐私与安全性 > 屏幕录制中允许 ${PRODUCT_NAME} 后重试。`;
    }
    return "";
  }
  if (platform === "win32") {
    return "";
  }
  return "当前平台暂不支持截屏提问。";
}

function getDisplayThumbnailSize(display: Display) {
  const scaleFactor = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
    ? display.scaleFactor
    : 1;
  return {
    width: Math.max(1, Math.round(display.size.width * scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * scaleFactor))
  };
}

function chooseDisplaySource(
  sources: Electron.DesktopCapturerSource[],
  display: Display,
  thumbnailSize: { width: number; height: number }
) {
  const displayId = String(display.id);
  return sources.find((source) => source.display_id === displayId) ??
    sources.find((source) => {
      const size = source.thumbnail.getSize();
      return Math.abs(size.width - thumbnailSize.width) <= 2 &&
        Math.abs(size.height - thumbnailSize.height) <= 2;
    }) ??
    sources[0] ??
    null;
}

async function captureDisplayImage(display: Display) {
  const thumbnailSize = getDisplayThumbnailSize(display);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false
  });
  const source = chooseDisplaySource(sources, display, thumbnailSize);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("没有获取到可用的屏幕截图，请检查系统截屏权限后重试。");
  }
  return source.thumbnail;
}

function intersectRect(a: Rectangle, b: Rectangle): Rectangle | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    return null;
  }
  return {
    x: left,
    y: top,
    width,
    height
  };
}

function getScreenshotSelectionGlobalRect(
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect
): Rectangle {
  return {
    x: displayBounds.x + selection.x,
    y: displayBounds.y + selection.y,
    width: selection.width,
    height: selection.height
  };
}

function getScreenshotWindowFallbackTargets(
  source: ScreenshotCaptureSource,
  options: Pick<CaptureAssistantScreenshotOptions, "getMainWindow" | "getQuickCopilotWindow">
) {
  const targets: BrowserWindow[] = [];
  const addTarget = (targetWindow: BrowserWindow | null) => {
    if (
      targetWindow &&
      !targetWindow.isDestroyed() &&
      targetWindow.isVisible() &&
      !targets.includes(targetWindow)
    ) {
      targets.push(targetWindow);
    }
  };

  if (source === "quick-assistant") {
    addTarget(options.getMainWindow());
    addTarget(options.getQuickCopilotWindow());
    return targets;
  }

  addTarget(options.getMainWindow());
  return targets;
}

async function captureWindowSelectionFallback(
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect,
  source: ScreenshotCaptureSource,
  options: Pick<CaptureAssistantScreenshotOptions, "getMainWindow" | "getQuickCopilotWindow">
) {
  const selectionBounds = getScreenshotSelectionGlobalRect(displayBounds, selection);
  for (const targetWindow of getScreenshotWindowFallbackTargets(source, options)) {
    const contentBounds = targetWindow.getContentBounds();
    const intersection = intersectRect(selectionBounds, contentBounds);
    if (!intersection) {
      continue;
    }
    const captured = await targetWindow.webContents.capturePage({
      x: clampInteger(intersection.x - contentBounds.x, 0, Math.max(0, contentBounds.width - 1)),
      y: clampInteger(intersection.y - contentBounds.y, 0, Math.max(0, contentBounds.height - 1)),
      width: clampInteger(intersection.width, 1, contentBounds.width),
      height: clampInteger(intersection.height, 1, contentBounds.height)
    });
    if (!captured.isEmpty()) {
      return captured;
    }
  }
  return null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.round(value), max));
}

function cropScreenshotImage(
  image: NativeImage,
  displayBounds: Rectangle,
  selection: ScreenshotSelectionRect
) {
  const imageSize = image.getSize();
  const ratioX = imageSize.width / Math.max(1, displayBounds.width);
  const ratioY = imageSize.height / Math.max(1, displayBounds.height);
  const x = clampInteger(selection.x * ratioX, 0, Math.max(0, imageSize.width - 1));
  const y = clampInteger(selection.y * ratioY, 0, Math.max(0, imageSize.height - 1));
  const width = clampInteger(selection.width * ratioX, 1, Math.max(1, imageSize.width - x));
  const height = clampInteger(selection.height * ratioY, 1, Math.max(1, imageSize.height - y));
  return image.crop({ x, y, width, height });
}

async function captureScreenshotImage(
  display: Display,
  selection: ScreenshotSelectionRect,
  source: ScreenshotCaptureSource,
  options: Pick<CaptureAssistantScreenshotOptions, "platform" | "getMainWindow" | "getQuickCopilotWindow">
) {
  let screenCaptureFailure: Error | null = null;
  try {
    const image = await captureDisplayImage(display);
    const cropped = cropScreenshotImage(image, display.bounds, selection);
    if (cropped.isEmpty()) {
      throw new Error("截屏区域为空，请重新选择更大的范围。");
    }
    return cropped;
  } catch (error) {
    screenCaptureFailure = error instanceof Error ? error : new Error(String(error));
  }

  const fallback = await captureWindowSelectionFallback(display.bounds, selection, source, options);
  if (fallback && !fallback.isEmpty()) {
    return fallback;
  }

  if (options.platform === "darwin" && screenCaptureFailure.message.includes("没有获取到可用的屏幕截图")) {
    throw new Error(
      `没有获取到系统屏幕截图源，也无法从当前 ${PRODUCT_NAME} 窗口截取该区域。请确认选择范围在 ${PRODUCT_NAME} 窗口内，或在系统设置 > 隐私与安全性 > 屏幕录制中允许 ${PRODUCT_NAME}。`
    );
  }

  if (options.platform === "win32" && screenCaptureFailure.message.includes("没有获取到可用的屏幕截图")) {
    throw new Error(`没有获取到系统屏幕截图源，也无法从当前 ${PRODUCT_NAME} 窗口截取该区域，请重新选择窗口内区域后重试。`);
  }

  throw screenCaptureFailure;
}

function createScreenshotAttachmentName() {
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/u, "")
    .replace(/[-:T]/gu, "");
  return `screenshot-${timestamp}.png`;
}

export async function captureAssistantScreenshot(options: CaptureAssistantScreenshotOptions) {
  const permissionMessage = getScreenshotPermissionMessage(options.platform);
  if (permissionMessage) {
    return {
      ok: false,
      chatId: options.chatId ?? "",
      message: permissionMessage,
      attachments: []
    };
  }

  const quickAssistantWindow = options.getQuickCopilotWindow();
  const shouldRestoreQuickAssistant = options.source === "quick-assistant" &&
    Boolean(quickAssistantWindow && !quickAssistantWindow.isDestroyed() && quickAssistantWindow.isVisible());
  if (options.source === "quick-assistant") {
    options.hideQuickCopilotDismissWindow();
    if (quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
      quickAssistantWindow.hide();
    }
    await options.delay(140);
  }

  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const selection = await selectScreenshotRegion(display, options.platform);
    if (!selection) {
      return {
        ok: false,
        chatId: options.chatId ?? "",
        message: "已取消截屏。",
        attachments: []
      };
    }

    await options.delay(80);
    const cropped = await captureScreenshotImage(display, selection, options.source, options);
    return createAssistantAttachmentFromImageBuffer(options.app, options.chatId, {
      name: createScreenshotAttachmentName(),
      mimeType: "image/png",
      buffer: cropped.toPNG(),
      fallbackBaseName: "screenshot",
      unsupportedMessage: "截屏图片格式暂不支持。",
      readableMessage: "已截取 1 张屏幕图片，图片已进入视觉上下文。",
      oversizedVisionMessage: "截屏已保存，但过大，未发送给模型视觉接口。"
    });
  } catch (error) {
    return {
      ok: false,
      chatId: options.chatId ?? "",
      message: error instanceof Error ? error.message : String(error),
      attachments: []
    };
  } finally {
    if (options.source === "quick-assistant") {
      if (shouldRestoreQuickAssistant && quickAssistantWindow && !quickAssistantWindow.isDestroyed()) {
        options.showQuickCopilotDismissWindow();
        quickAssistantWindow.show();
        quickAssistantWindow.focus();
      }
    }
  }
}
