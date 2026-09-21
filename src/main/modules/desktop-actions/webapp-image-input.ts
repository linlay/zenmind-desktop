import { WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS } from "../../../shared/webapp-manifest";
import { readString } from "./action-values";

export const MAX_ASSISTANT_PROMPT_CHARS = WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS;

export const WEBAPP_IMAGE_PROMPT_MAX_CHARS = 4_000;

export const WEBAPP_IMAGE_MAX_PIXELS = 100_000_000;

export const WEBAPP_IMAGE_OPERATIONS = new Set([
  "generate",
  "imageToImage",
  "inpaint",
  "outpaint",
  "removeObject",
  "replaceBackground",
  "removeBackground",
  "enhance",
  "repairSelection"
]);

export const WEBAPP_IMAGE_PROMPT_REQUIRED = new Set([
  "generate",
  "imageToImage",
  "inpaint",
  "outpaint",
  "replaceBackground"
]);

export const WEBAPP_IMAGE_MASK_REQUIRED = new Set(["inpaint", "removeObject", "repairSelection"]);

export const activeWebappImageRuns = new Map<string, string>();

export function webappImageRunKey(webappId: string, requestId: string) {
  return `${webappId}:${requestId}`;
}

export function normalizeWebappImageRequest(args: Record<string, unknown>) {
  const allowed = new Set([
    "requestId", "uploadId", "operation", "prompt", "negativePrompt", "width", "height",
    "count", "strength", "seed", "preserveComposition", "edgeMode"
  ]);
  const rejected = Object.keys(args).filter((key) => !allowed.has(key));
  if (rejected.length > 0) throw new Error(`unsupported image request fields: ${rejected.join(", ")}`);
  const requestId = readString(args, "requestId");
  const uploadId = readString(args, "uploadId");
  const operation = readString(args, "operation");
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const negativePrompt = typeof args.negativePrompt === "string" ? args.negativePrompt.trim() : "";
  const width = Number(args.width);
  const height = Number(args.height);
  const count = Number(args.count);
  const strength = Number(args.strength);
  const seed = Number(args.seed);
  const preserveComposition = args.preserveComposition;
  const edgeMode = args.edgeMode;
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId)) throw new Error("requestId is invalid");
  if (!WEBAPP_IMAGE_OPERATIONS.has(operation)) throw new Error("image operation is unsupported");
  if (prompt.length > WEBAPP_IMAGE_PROMPT_MAX_CHARS || negativePrompt.length > WEBAPP_IMAGE_PROMPT_MAX_CHARS) {
    throw new Error("image prompt is too long");
  }
  if (WEBAPP_IMAGE_PROMPT_REQUIRED.has(operation) && !prompt) throw new Error("prompt is required for this image operation");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 ||
    width > 16_384 || height > 16_384 || width * height > WEBAPP_IMAGE_MAX_PIXELS) {
    throw new Error("image output dimensions are invalid");
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("image output width and height must be divisible by 16");
  }
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("image count must be between 1 and 4");
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("image strength must be between 0 and 1");
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error("image seed is invalid");
  if (typeof preserveComposition !== "boolean") throw new Error("preserveComposition must be boolean");
  if (edgeMode !== "strict" && edgeMode !== "soft") throw new Error("edgeMode must be strict or soft");
  if (operation !== "generate" && !/^webimg_[0-9a-f-]{36}$/iu.test(uploadId)) throw new Error("source image upload is required");
  return {
    requestId,
    uploadId,
    operation,
    prompt,
    negativePrompt,
    width,
    height,
    count,
    strength,
    seed,
    preserveComposition,
    edgeMode
  };
}
