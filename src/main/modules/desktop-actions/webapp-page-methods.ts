import { randomUUID } from "node:crypto";
import { type AssistantAttachment } from "../../../shared/contracts";
import { type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { type AgentPlatformImageOperation } from "../agent-platform";
import { consumeWebappImageUpload } from "../webs";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { fail, ok, readString } from "./action-values";
import {
  webappImageRunKey,
  activeWebappImageRuns,
  normalizeWebappImageRequest,
  WEBAPP_IMAGE_MASK_REQUIRED
} from "./webapp-image-input";
import { executeNativeWebappAction } from "./webapp-native-actions";

// WebApp Bridge methods that only a local WebApp page may call. They are not Desktop
// Actions: agents cannot reach them, and they never go through Desktop Action confirmation.
export const WEBAPP_PAGE_METHODS = new Set([
  "desktop.capabilities.list",
  "desktop.native.browser.openExternal",
  "desktop.native.dialog.selectFiles",
  "desktop.native.dialog.selectDirectory",
  "desktop.native.dialog.selectSavePath",
  "desktop.native.microphone.getPermission",
  "desktop.native.microphone.requestAccess",
  "desktop.native.clipboard.writeText",
  "desktop.native.notification.show",
  "desktop.assistant.image",
  "desktop.assistant.image.cancel"
]);

export async function executeWebappPageMethod(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  if (action === "desktop.assistant.image") return executeWebappImage(options, action, args, webappId);
  if (action === "desktop.assistant.image.cancel") return cancelWebappImage(options, action, args, webappId);
  return executeNativeWebappAction(options, action, args, webappId);
}

async function cancelWebappImage(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  const requestId = readString(args, "requestId");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId) || Object.keys(args).some((key) => key !== "requestId")) {
    return fail(action, "invalid_args", "requestId is invalid");
  }
  const key = webappImageRunKey(webappId, requestId);
  const runId = activeWebappImageRuns.get(key);
  if (!runId) {
    return ok(action, { requestId, cancelled: false });
  }
  const stopped = await options.assistantBridge.stopRun(runId);
  return stopped.ok
    ? ok(action, { requestId, cancelled: true })
    : fail(action, "assistant_cancel_failed", stopped.message);
}

async function executeWebappImage(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  let normalized: ReturnType<typeof normalizeWebappImageRequest>;
  try {
    normalized = normalizeWebappImageRequest(args);
  } catch (error) {
    return fail(action, "invalid_args", error instanceof Error ? error.message : "image request is invalid");
  }
  const key = webappImageRunKey(webappId, normalized.requestId);
  if (activeWebappImageRuns.has(key)) {
    return fail(action, "request_conflict", "an image request with this requestId is already running");
  }
  const upload = normalized.uploadId
    ? consumeWebappImageUpload(webappId, normalized.uploadId)
    : null;
  if (normalized.operation !== "generate" && !upload?.source) {
    return fail(action, "image_upload_missing", "source image upload is missing or expired");
  }
  if (WEBAPP_IMAGE_MASK_REQUIRED.has(normalized.operation) && !upload?.mask) {
    return fail(action, "selection_required", "this image operation requires a selection mask");
  }
  const attachments: AssistantAttachment[] = [];
  if (upload?.source) {
    const extension = upload.source.mimeType === "image/jpeg" ? "jpg" :
      upload.source.mimeType === "image/webp" ? "webp" : "png";
    attachments.push({
      id: "image-studio-source",
      name: `image-studio-source.${extension}`,
      mimeType: upload.source.mimeType,
      sizeBytes: upload.source.bytes.length,
      text: "",
      dataUrl: `data:${upload.source.mimeType};base64,${upload.source.bytes.toString("base64")}`,
      kind: "input",
      document: { format: "image", readStatus: "readable", extractedChars: 0, truncated: false, imageMode: "vision" }
    });
  }
  if (upload?.mask) {
    attachments.push({
      id: "image-studio-mask",
      name: "image-studio-mask.png",
      mimeType: "image/png",
      sizeBytes: upload.mask.bytes.length,
      text: "",
      dataUrl: `data:image/png;base64,${upload.mask.bytes.toString("base64")}`,
      kind: "input",
      document: { format: "image", readStatus: "readable", extractedChars: 0, truncated: false, imageMode: "vision" }
    });
  }
  const runId = `run_webimg_${randomUUID().replace(/-/gu, "")}`;
  activeWebappImageRuns.set(key, runId);
  try {
    const completion = await options.assistantBridge.completeImage({
      runId,
      requestId: normalized.requestId,
      agentKey: "zenmi",
      source: "copilot",
      action: "image_studio",
      operation: normalized.operation as AgentPlatformImageOperation,
      prompt: normalized.prompt,
      negativePrompt: normalized.negativePrompt,
      width: normalized.width,
      height: normalized.height,
      count: normalized.count,
      strength: normalized.strength,
      seed: normalized.seed,
      preserveComposition: normalized.preserveComposition,
      edgeMode: normalized.edgeMode as "strict" | "soft",
      attachments
    });
    if (!completion.ok) {
      return fail(action, "assistant_image_failed", completion.message, {
        runId: completion.runId,
        chatId: completion.chatId
      });
    }
    return ok(action, {
      provider: "desktop-zenmi",
      agentKey: "zenmi",
      requestId: normalized.requestId,
      runId: completion.runId,
      chatId: completion.chatId,
      images: completion.images
    });
  } finally {
    activeWebappImageRuns.delete(key);
  }
}
