import type { BrowserWindow, WebFrameMain } from "electron";

const QUICK_AGENT_WEBCLIENT_PATHNAMES = new Set(["/copilot"]);
const QUICK_AGENT_OPEN_RETRY_COUNT = 24;
const QUICK_AGENT_OPEN_RETRY_MS = 180;

export type QuickAgentOpenRequest = {
  chatId?: string;
  agentKey: string;
  focusComposerOnComplete: boolean;
};

export function createAgentWebclientRoute(request: {
  agentKey?: string | null;
  chatId?: string | null;
}) {
  const agentKey = request.agentKey?.trim() ?? "";
  if (!agentKey) {
    return "/service/agent-webclient";
  }

  const params = new URLSearchParams();
  const chatId = request.chatId?.trim() ?? "";
  if (chatId) {
    params.set("chatId", chatId);
  }
  const query = params.toString();
  return `/agent/${encodeURIComponent(agentKey)}${query ? `?${query}` : ""}`;
}

export function collectWebFrames(frame: WebFrameMain, frames: WebFrameMain[] = []) {
  frames.push(frame);
  for (const childFrame of frame.frames) {
    collectWebFrames(childFrame, frames);
  }
  return frames;
}

export function isQuickAgentWebclientFrame(frame: WebFrameMain) {
  try {
    return QUICK_AGENT_WEBCLIENT_PATHNAMES.has(new URL(frame.url).pathname);
  } catch {
    return false;
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
      focusComposerOnComplete: request.focusComposerOnComplete
    })}`,
    "}));",
    "true;"
  ].join("\n");
}

export function dispatchQuickAgentOpenRequest(
  targetWindow: BrowserWindow,
  request: QuickAgentOpenRequest
) {
  const script = createQuickAgentOpenScript(request);
  const frames = collectWebFrames(targetWindow.webContents.mainFrame).filter(isQuickAgentWebclientFrame);
  let dispatched = false;
  for (const frame of frames) {
    dispatched = true;
    frame.executeJavaScript(script).catch((error) => {
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
