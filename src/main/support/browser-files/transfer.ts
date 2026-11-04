/** Browser file transfer rules shared by the Chrome worker and WorkPanel guests. */

export const BROWSER_UPLOAD_MAX_FILES = 8;
export const BROWSER_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const BROWSER_UPLOAD_MAX_BYTES = BROWSER_FILE_MAX_BYTES;
export const BROWSER_DOWNLOAD_MAX_FILES = 8;
export const BROWSER_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;

export function transferError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Names cross both macOS and Windows; they never become a caller-chosen path. */
export function safeDownloadName(value: string): string {
  let name = value.replace(/\\/gu, "/").split("/").pop() ?? "";
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_").trim()
    .slice(0, 200).replace(/[. ]+$/gu, "");
  if (!name || name === "." || name === "..") name = "download";
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)) name = `download-${name}`;
  if (name.startsWith(".")) name = `download${name}`;
  return name;
}

export function mimeTypeForName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return ({ csv: "text/csv", txt: "text/plain", json: "application/json", pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    zip: "application/zip" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

/** Platform resolves authorized Chat references; the worker accepts bytes, never filesystem paths. */
export function decodeBrowserUploadFiles(input: unknown): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (!Array.isArray(input) || input.length === 0 || input.length > BROWSER_UPLOAD_MAX_FILES) {
    throw transferError("invalid_params", "Choose between one and eight authorized Chat files.");
  }
  let total = 0;
  return input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["name", "mimeType", "data"].includes(key))) {
      throw transferError("invalid_params", "Upload files must contain only a name, MIME type and encoded contents.");
    }
    const { name, mimeType, data } = item as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0 || name.length > 255 || name.trim() !== name
      || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name)
      || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)) {
      throw transferError("invalid_params", "Upload filenames must be safe names without directory components.");
    }
    const normalizedMime = typeof mimeType === "string" ? mimeType.split(";", 1)[0].trim().toLowerCase() : "";
    if (typeof mimeType !== "string" || /[\r\n\u0000]/u.test(mimeType) || mimeType.length > 256
      || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(normalizedMime)) {
      throw transferError("invalid_params", "The upload MIME type is invalid.");
    }
    const padding = typeof data === "string" ? data.indexOf("=") : -1;
    if (typeof data !== "string" || data.length > 4 * Math.ceil(BROWSER_FILE_MAX_BYTES / 3)
      || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(data)
      || (padding >= 0 && (padding < data.length - 2 || !/^={1,2}$/u.test(data.slice(padding))))) {
      throw transferError("invalid_params", "Upload contents must be valid base64 within the file size limit.");
    }
    const buffer = Buffer.from(data, "base64");
    total += buffer.length;
    if (buffer.length > BROWSER_FILE_MAX_BYTES || total > BROWSER_UPLOAD_MAX_BYTES) {
      throw transferError("file_transfer_limit", "Uploads are limited to 4 MiB in total per operation.");
    }
    return { name, mimeType: normalizedMime, buffer };
  });
}
