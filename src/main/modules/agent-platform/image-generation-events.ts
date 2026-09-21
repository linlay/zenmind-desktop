import { type AgentPlatformImageOperation, type AgentPlatformImageCompletionRequest } from "./bridge-contracts";
import { readString } from "./bridge-values";

export const IMAGE_OPERATION_INSTRUCTIONS: Record<AgentPlatformImageOperation, string> = {
  generate: "根据提示词生成一张全新图片。",
  imageToImage: "以原图为编辑目标，根据提示词进行图生图修改。",
  inpaint: "只重绘蒙版指定区域，未选区域保持不变。",
  outpaint: "在保持主体与视觉风格的前提下智能扩展原图边界。",
  removeObject: "移除蒙版区域内的对象，并根据周围内容自然补全。",
  replaceBackground: "替换图片背景，主体的外观、姿态和细节保持稳定。",
  removeBackground: "移除背景并保留主体，尽可能输出透明背景。",
  enhance: "增强清晰度、细节与色彩，保持原内容和构图。",
  repairSelection: "清除蒙版区域内的文字、标记或水印，并根据周围内容自然修复；素材已由用户确认拥有或获得授权。"
};

export function buildZenmiImageGenerateMessage(request: AgentPlatformImageCompletionRequest) {
  const source = request.attachments?.find((attachment) => attachment.id === "image-studio-source");
  const mask = request.attachments?.find((attachment) => attachment.id === "image-studio-mask");
  const promptParts = [
    IMAGE_OPERATION_INSTRUCTIONS[request.operation],
    request.prompt.trim(),
    request.negativePrompt?.trim() ? `避免出现：${request.negativePrompt.trim()}。` : "",
    `重绘强度参考 ${Math.round(request.strength * 100)}%。`,
    request.preserveComposition ? "保持原有构图。" : "允许重新组织构图。",
    request.edgeMode === "strict" ? "严格限制修改范围。" : "允许自然影响蒙版边缘。",
    `随机种子参考 ${request.seed}。`
  ].filter(Boolean).join(" ");
  const toolArgs: Record<string, unknown> = {
    prompt: promptParts,
    size: `${request.width}x${request.height}`,
    n: request.count
  };
  if (source) {
    toolArgs.images = [{ source_type: "reference_name", value: source.name }];
  }
  if (source && mask) {
    toolArgs.mask = { source_type: "reference_name", value: mask.name, mode: "white_edit" };
  }
  return [
    "必须且只能调用一次 image_generate 工具；不要调用文件、Shell、浏览器、桌面控制或其他工具，也不要向用户追问。",
    `请使用以下参数调用 image_generate：${JSON.stringify(toolArgs)}`
  ].join("\n");
}

export type ImageGenerateOutcome = {
  callCount: number;
  resultSeen: boolean;
  ok: boolean;
  message: string;
  artifacts: Array<Record<string, unknown>>;
};

export function imageResultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function imageGenerateFailureMessage(value: unknown): string {
  const record = imageResultRecord(value);
  if (!record) return "image_generate 返回了无效结果。";
  const direct = readString(record.message).trim() || readString(record.error).trim();
  if (direct) return direct;
  const nested = record.output;
  if (typeof nested === "string") {
    try {
      return imageGenerateFailureMessage(JSON.parse(nested));
    } catch {
      return nested.trim().slice(0, 500) || "image_generate 执行失败。";
    }
  }
  if (nested && nested !== value) return imageGenerateFailureMessage(nested);
  return "image_generate 执行失败。";
}

export function observeImageGenerateEvent(event: Record<string, unknown>, outcome: ImageGenerateOutcome) {
  const eventType = readString(event.type);
  const toolName = readString(event.toolName);
  if (eventType === "tool.start") {
    if (toolName !== "image_generate") {
      outcome.message = `Zenmi 图片任务不允许调用 ${toolName || "未知工具"}。`;
      return true;
    }
    outcome.callCount += 1;
    if (outcome.callCount > 1) {
      outcome.message = "Zenmi 图片任务检测到第二次 image_generate 调用，运行已终止。";
      return true;
    }
    return false;
  }
  if (eventType !== "tool.result" || toolName !== "image_generate") return false;
  if (outcome.resultSeen) {
    outcome.message = "Zenmi 图片任务返回了多个 image_generate 结果，运行已终止。";
    outcome.ok = false;
    return true;
  }
  outcome.resultSeen = true;
  if (outcome.callCount === 0) outcome.callCount = 1;
  const result = imageResultRecord(event.result);
  const images = result?.images;
  if (result?.ok !== true || !Array.isArray(images) || images.length === 0) {
    outcome.message = imageGenerateFailureMessage(result);
    outcome.ok = false;
    return true;
  }
  for (const image of images) {
    const artifact = imageResultRecord(image);
    if (artifact) outcome.artifacts.push(artifact);
  }
  outcome.ok = outcome.artifacts.length > 0;
  outcome.message = outcome.ok ? "" : "image_generate 未返回有效 images[]。";
  return true;
}

export function validGeneratedImageRelativePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("://")) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}
