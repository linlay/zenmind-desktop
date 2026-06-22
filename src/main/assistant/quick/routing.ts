import type { BrowserWindow, WebContents, WebFrameMain } from "electron";
import { webContents as electronWebContents } from "electron";
import { AGENT_WEBCLIENT_TARGET_PATH } from "../../../shared/agent-webclient-routes";

const QUICK_AGENT_OPEN_RETRY_COUNT = 80;
const QUICK_AGENT_OPEN_RETRY_MS = 200;

export type QuickAgentOpenRequest = {
  chatId?: string;
  agentKey: string;
  focusComposerOnComplete: boolean;
};

type WebContentsAccess = {
  getAllWebContents(): WebContents[];
};

export function createAgentWebclientRoute(request: {
  agentKey?: string | null;
  chatId?: string | null;
}) {
  const agentKey = request.agentKey?.trim() ?? "";
  if (!agentKey) {
    return AGENT_WEBCLIENT_TARGET_PATH;
  }

  const params = new URLSearchParams();
  const chatId = request.chatId?.trim() ?? "";
  if (chatId) {
    params.set("chatId", chatId);
  }
  const query = params.toString();
  return `/agent/${encodeURIComponent(agentKey)}${query ? `?${query}` : ""}`;
}

export function isQuickAgentWebclientUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    return pathname === "/copilot" || pathname.startsWith("/copilot/");
  } catch {
    return false;
  }
}

export function collectWebFrames(frame: WebFrameMain, frames: WebFrameMain[] = []) {
  frames.push(frame);
  for (const childFrame of frame.frames) {
    collectWebFrames(childFrame, frames);
  }
  return frames;
}

export function isQuickAgentWebclientFrame(frame: WebFrameMain) {
  return isQuickAgentWebclientUrl(frame.url);
}

export function isQuickAgentWebclientContents(
  contents: WebContents,
  targetWindow: BrowserWindow
) {
  try {
    if (contents.isDestroyed() || contents.getType() !== "webview") {
      return false;
    }
    const hostWebContents = contents.hostWebContents;
    if (
      !hostWebContents ||
      hostWebContents.isDestroyed() ||
      hostWebContents.id !== targetWindow.webContents.id
    ) {
      return false;
    }
    return isQuickAgentWebclientUrl(contents.getURL());
  } catch {
    return false;
  }
}

export function collectQuickAgentWebContents(
  targetWindow: BrowserWindow,
  webContentsAccess: WebContentsAccess = electronWebContents
) {
  try {
    return webContentsAccess
      .getAllWebContents()
      .filter((contents) => isQuickAgentWebclientContents(contents, targetWindow));
  } catch {
    return [];
  }
}

export function createQuickAgentOpenScript(request: QuickAgentOpenRequest) {
  const agentKey = request.agentKey.trim();
  if (!agentKey) {
    return "true;";
  }
  return [
    "window.dispatchEvent(new CustomEvent('agent:select-worker', {",
    `  detail: ${JSON.stringify({
      agentKey,
      workerKey: `agent:${agentKey}`,
      focusComposerOnComplete: request.focusComposerOnComplete
    })}`,
    "}));",
    "true;"
  ].join("\n");
}

export function dispatchQuickAgentOpenRequest(
  targetWindow: BrowserWindow,
  request: QuickAgentOpenRequest,
  webContentsAccess: WebContentsAccess = electronWebContents
) {
  const script = createQuickAgentOpenScript(request);
  const frames = collectWebFrames(targetWindow.webContents.mainFrame).filter(isQuickAgentWebclientFrame);
  const contentsList = collectQuickAgentWebContents(targetWindow, webContentsAccess);
  let dispatched = false;
  for (const frame of frames) {
    dispatched = true;
    frame.executeJavaScript(script).catch((error) => {
      console.warn("[quick-assistant] failed to open agent webclient copilot", error);
    });
  }
  for (const contents of contentsList) {
    dispatched = true;
    contents.executeJavaScript(script, true).catch((error) => {
      console.warn("[quick-assistant] failed to open agent webclient copilot", error);
    });
  }
  return dispatched;
}

export function scheduleQuickAgentOpenRequest(
  targetWindow: BrowserWindow,
  request: QuickAgentOpenRequest,
  attempt = 0
) {
  if (targetWindow.isDestroyed()) {
    return;
  }
  if (dispatchQuickAgentOpenRequest(targetWindow, request)) {
    return;
  }
  if (attempt >= QUICK_AGENT_OPEN_RETRY_COUNT) {
    console.warn("[quick-assistant] agent webclient copilot frame was not ready");
    return;
  }
  setTimeout(() => {
    scheduleQuickAgentOpenRequest(targetWindow, request, attempt + 1);
  }, QUICK_AGENT_OPEN_RETRY_MS);
}
