import { randomUUID } from "node:crypto";

export const WEBAPP_IMAGE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const WEBAPP_IMAGE_UPLOAD_BODY_MAX_BYTES = WEBAPP_IMAGE_INPUT_MAX_BYTES * 2 + 512 * 1024;
const WEBAPP_IMAGE_UPLOAD_TTL_MS = 5 * 60 * 1000;
const WEBAPP_IMAGE_UPLOAD_MAX_ENTRIES = 24;

export type WebappImageUploadFile = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
};

export type WebappImageUpload = {
  id: string;
  webappId: string;
  source?: WebappImageUploadFile;
  mask?: WebappImageUploadFile;
  createdAt: number;
  expiresAt: number;
};

const uploads = new Map<string, WebappImageUpload>();

function detectedImageMime(bytes: Buffer): WebappImageUploadFile["mimeType"] | "" {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

export function normalizeWebappImageUploadFile(input: {
  name?: string;
  mimeType?: string;
  bytes: Buffer;
}, options: { mask?: boolean } = {}): WebappImageUploadFile {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw new Error("image file is empty");
  }
  if (input.bytes.length > WEBAPP_IMAGE_INPUT_MAX_BYTES) {
    throw new Error(`image file exceeds ${WEBAPP_IMAGE_INPUT_MAX_BYTES} bytes`);
  }
  const detected = detectedImageMime(input.bytes);
  if (!detected) {
    throw new Error("image file must be PNG, JPEG, or WebP");
  }
  if (options.mask && detected !== "image/png") {
    throw new Error("image mask must be PNG");
  }
  const declared = String(input.mimeType || "").trim().toLowerCase();
  if (declared && declared !== detected && !(declared === "image/jpg" && detected === "image/jpeg")) {
    throw new Error("image MIME does not match its contents");
  }
  const fallbackName = options.mask ? "image-studio-mask.png" :
    detected === "image/jpeg" ? "image-studio-source.jpg" :
      detected === "image/webp" ? "image-studio-source.webp" : "image-studio-source.png";
  const baseName = String(input.name || "").trim().replace(/[\\/\0\r\n]/gu, "_").slice(0, 160);
  return {
    name: baseName || fallbackName,
    mimeType: detected,
    bytes: Buffer.from(input.bytes)
  };
}

function prune(now = Date.now()) {
  for (const [id, upload] of uploads) {
    if (upload.expiresAt <= now) uploads.delete(id);
  }
  while (uploads.size >= WEBAPP_IMAGE_UPLOAD_MAX_ENTRIES) {
    const oldest = uploads.keys().next().value;
    if (!oldest) break;
    uploads.delete(oldest);
  }
}

export function registerWebappImageUpload(input: {
  webappId: string;
  source?: WebappImageUploadFile;
  mask?: WebappImageUploadFile;
}, now = Date.now()) {
  const webappId = input.webappId.trim();
  if (!webappId) throw new Error("webappId is required");
  if (!input.source && !input.mask) throw new Error("source or mask image is required");
  if (input.mask && !input.source) throw new Error("mask requires a source image");
  prune(now);
  const id = `webimg_${randomUUID()}`;
  const upload: WebappImageUpload = {
    id,
    webappId,
    ...(input.source ? { source: input.source } : {}),
    ...(input.mask ? { mask: input.mask } : {}),
    createdAt: now,
    expiresAt: now + WEBAPP_IMAGE_UPLOAD_TTL_MS
  };
  uploads.set(id, upload);
  return {
    uploadId: id,
    expiresAt: upload.expiresAt,
    source: upload.source ? { name: upload.source.name, mimeType: upload.source.mimeType, sizeBytes: upload.source.bytes.length } : null,
    mask: upload.mask ? { name: upload.mask.name, mimeType: upload.mask.mimeType, sizeBytes: upload.mask.bytes.length } : null
  };
}

export function consumeWebappImageUpload(webappId: string, uploadId: string, now = Date.now()) {
  prune(now);
  const upload = uploads.get(uploadId) ?? null;
  if (!upload || upload.webappId !== webappId || upload.expiresAt <= now) {
    return null;
  }
  uploads.delete(uploadId);
  return upload;
}

export function clearWebappImageUploadsForTest() {
  uploads.clear();
}
