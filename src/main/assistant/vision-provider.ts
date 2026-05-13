import type { AssistantSettingsPrivate } from "./settings-store";
import { normalizeModelHTTPErrorMessage } from "./model-provider";

const VISION_SYSTEM_PROMPT = [
  "你是 ZenMind Desktop 的附件视觉识别模型，只负责客观描述图片、截图或扫描页图。",
  "请基于图片中可见内容回答，不要补全看不清的细节，不要编造股票代码、文件名、数字或结论。",
  "输出中文结构化文本，包含：可见对象/场景、文字 OCR、表格或图表、截图 UI、置信度与不确定点。",
  "如果图片文字较多，请优先摘录标题、字段名、关键段落、表格列名和明显数字。"
].join("\n");

const DEFAULT_VISION_TIMEOUT_MS = 60000;

export type VisionDescribeResult = {
  summary: string;
  provider: "minimax-vlm";
};

function abortSignalAny(signals: AbortSignal[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function normalizeSecretInput(value: string) {
  return value.replace(/[\r\n]/gu, "").replace(/[^\u0000-\u00ff]/gu, "").trim();
}

function coerceAPIOrigin(baseURL: string) {
  const trimmed = baseURL.trim() || "https://api.minimax.io";
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return "https://api.minimax.io";
  }
}

function isMiniMaxHost(baseURL: string) {
  try {
    const origin = coerceAPIOrigin(baseURL);
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "api.minimax.io" ||
      hostname === "api.minimaxi.com" ||
      hostname === "platform.minimax.io" ||
      hostname === "platform.minimaxi.com" ||
      hostname === "www.minimax.io";
  } catch {
    return false;
  }
}

export function canDescribeImageWithVision(settings: AssistantSettingsPrivate, dataUrl = "data:image/png;base64,") {
  return Boolean(
    settings.apiKey.trim() &&
    settings.baseURL.trim() &&
    isMiniMaxHost(settings.baseURL) &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,/iu.test(dataUrl)
  );
}

function parseImageDataUrl(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/iu.exec(dataUrl);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2]
  };
}

async function normalizeImageDataUrlForMiniMax(dataUrl: string) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) {
    return dataUrl;
  }
  if (parsed.mimeType !== "image/gif") {
    return dataUrl;
  }
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(parsed.base64, "base64"));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

async function createVisionHTTPError(response: Response) {
  const body = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") || body.trimStart().startsWith("<!DOCTYPE html")) {
    return new Error("MiniMax VLM 请求失败：Base URL 返回网页页面，不是 MiniMax API。");
  }
  return new Error(normalizeModelHTTPErrorMessage(response.status, body).replace(/^模型请求失败/u, "MiniMax VLM 请求失败"));
}

export async function describeImageWithVision({
  settings,
  name,
  dataUrl,
  signal,
  timeoutMs = DEFAULT_VISION_TIMEOUT_MS
}: {
  settings: AssistantSettingsPrivate;
  name: string;
  dataUrl: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<VisionDescribeResult> {
  if (!canDescribeImageWithVision(settings, dataUrl)) {
    throw new Error("MiniMax VLM 当前只支持 png、jpeg、webp、gif 图片，请确认已配置 MiniMax 主模型。");
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    const normalizedDataUrl = await normalizeImageDataUrlForMiniMax(dataUrl);
    const response = await fetch(new URL("/v1/coding_plan/vlm", coerceAPIOrigin(settings.baseURL)).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${normalizeSecretInput(settings.apiKey)}`,
        "content-type": "application/json",
        "MM-API-Source": "ZenMindDesktop"
      },
      body: JSON.stringify({
        prompt: `${VISION_SYSTEM_PROMPT}\n\n附件名称：${name}`,
        image_url: normalizedDataUrl
      }),
      signal: abortSignalAny([signal, timeoutController.signal])
    });

    if (!response.ok) {
      throw await createVisionHTTPError(response);
    }
    const payload = await response.json().catch(() => null) as {
      base_resp?: {
        status_code?: unknown;
        status_msg?: unknown;
      };
      content?: unknown;
    } | null;
    const statusCode = typeof payload?.base_resp?.status_code === "number" ? payload.base_resp.status_code : -1;
    if (statusCode !== 0) {
      const statusMessage = typeof payload?.base_resp?.status_msg === "string" ? payload.base_resp.status_msg : "";
      throw new Error(`MiniMax VLM API error (${statusCode})${statusMessage ? `: ${statusMessage}` : ""}`);
    }
    const summary = typeof payload?.content === "string" ? payload.content.trim() : "";
    if (!summary) {
      throw new Error("MiniMax VLM 没有返回可用内容。");
    }
    return {
      summary,
      provider: "minimax-vlm"
    };
  } finally {
    clearTimeout(timeout);
  }
}
