import { type ApiResponse } from "./bridge-contracts";

export function readErrorCode(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") {
    return record.code;
  }
  const data = record.data;
  if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).code === "string") {
    return (data as Record<string, unknown>).code as string;
  }
  return "";
}

export async function readErrorText(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `HTTP ${response.status}`;
    }
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const code = readErrorCode(payload);
      const message =
        typeof payload.msg === "string" ? payload.msg : typeof payload.message === "string" ? payload.message : text;
      return code ? `${code}: ${message}` : message;
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

export class ResponseBytesTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number
  ) {
    super(`response is ${actualBytes} bytes; limit is ${limitBytes} bytes`);
  }
}

export async function readResponseBytesWithLimit(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseBytesTooLargeError(declaredLength, maxBytes);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new ResponseBytesTooLargeError(bytes.length, maxBytes);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseBytesTooLargeError(totalBytes, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function filenameFromContentDisposition(value: string | null) {
  const header = String(value || "");
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(header);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const plainMatch = /filename=([^;]+)/i.exec(header);
  return plainMatch?.[1] ? plainMatch[1].trim() : "";
}

export function unwrapApiResponse<T>(payload: unknown): T {
  if (typeof payload === "object" && payload !== null && "code" in payload && "data" in payload) {
    const response = payload as ApiResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data;
  }
  return payload as T;
}

export function dataUrlToBlob(dataUrl: string, fallbackMimeType: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/u.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1] || fallbackMimeType || "application/octet-stream";
  const encoded = match[3] || "";
  const bytes = match[2]
    ? Buffer.from(encoded, "base64")
    : Buffer.from(decodeURIComponent(encoded), "utf8");
  return new Blob([bytes], { type: mimeType });
}
