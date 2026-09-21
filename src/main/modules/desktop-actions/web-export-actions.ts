import { type WebContents } from "electron";
import { asRecord, readString, fail, ok } from "./action-values";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { getDesktopDownloadDefaultPath, getAvailableFilePath, sanitizeDownloadFilename } from "../../infrastructure/filesystem/download-paths";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { type DesktopActionCallRequest, type DesktopActionCallResponse, type DesktopWebExportArtifactResult } from "../../../shared/desktop-actions";

export const DESKTOP_WEB_EXPORT_FORMATS = ["png", "html", "project", "pdf"] as const;

export type DesktopWebExportFormat = typeof DESKTOP_WEB_EXPORT_FORMATS[number];

export const DESKTOP_WEB_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export const DESKTOP_WEB_EXPORT_PROVIDER_VERSION = 1;

export const DESKTOP_WEB_EXPORT_SPEC: Record<DesktopWebExportFormat, {
  mimeType: string;
  encoding: "base64" | "utf8";
  extension: string;
}> = {
  png: { mimeType: "image/png", encoding: "base64", extension: ".png" },
  html: { mimeType: "text/html", encoding: "utf8", extension: ".html" },
  project: { mimeType: "application/json", encoding: "utf8", extension: ".poster-v2.json" },
  pdf: { mimeType: "application/pdf", encoding: "base64", extension: ".pdf" }
};

export type DesktopExportWebContents = Pick<
  WebContents,
  "executeJavaScript" | "isDestroyed" | "printToPDF"
>;

export type DesktopExportProviderDescription = {
  formats?: unknown;
  suggestedFilenames?: unknown;
};

export function isDesktopWebExportFormat(value: string): value is DesktopWebExportFormat {
  return (DESKTOP_WEB_EXPORT_FORMATS as readonly string[]).includes(value);
}

export function hasUnpairedUtf16Surrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function decodeStrictBase64(value: string) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value, "base64");
  return value.replace(/=+$/u, "") === buffer.toString("base64").replace(/=+$/u, "")
    ? buffer
    : null;
}

export function validateExportFilename(value: unknown, extension: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 240 ||
    /[\\/\u0000-\u001f]/u.test(value) ||
    !value.toLowerCase().endsWith(extension)
  ) {
    return "";
  }
  return value.trim();
}

export async function readDesktopExportProvider(
  contents: DesktopExportWebContents
): Promise<
  | { status: "ok"; description: DesktopExportProviderDescription }
  | { status: "unavailable" }
  | { status: "render_failed" }
> {
  try {
    const result = await contents.executeJavaScript(`(async () => {
      const provider = globalThis.__DESKTOP_WEBAPP_EXPORT__;
      if (!provider || provider.version !== ${DESKTOP_WEB_EXPORT_PROVIDER_VERSION} || typeof provider.describe !== "function" || typeof provider.create !== "function") {
        return { status: "unavailable" };
      }
      try {
        return { status: "ok", description: await provider.describe() };
      } catch {
        return { status: "render_failed" };
      }
    })()`, true) as unknown;
    const record = asRecord(result);
    if (record.status === "ok") {
      return { status: "ok", description: asRecord(record.description) };
    }
    return { status: record.status === "render_failed" ? "render_failed" : "unavailable" };
  } catch {
    return { status: "render_failed" };
  }
}

export async function createDesktopExportPayload(
  contents: DesktopExportWebContents,
  format: Exclude<DesktopWebExportFormat, "pdf">
) {
  try {
    return await contents.executeJavaScript(`(async () => {
      const provider = globalThis.__DESKTOP_WEBAPP_EXPORT__;
      if (!provider || provider.version !== ${DESKTOP_WEB_EXPORT_PROVIDER_VERSION} || typeof provider.create !== "function") {
        return { status: "unavailable" };
      }
      try {
        return { status: "ok", payload: await provider.create({ format: ${JSON.stringify(format)} }) };
      } catch {
        return { status: "render_failed" };
      }
    })()`, true) as unknown;
  } catch {
    return { status: "render_failed" };
  }
}

export async function writeDesktopExportFile(
  options: DesktopActionBridgeOptions,
  filename: string,
  data: Buffer
) {
  const platform = options.platform ?? process.platform;
  const defaultPath = getDesktopDownloadDefaultPath(options.app, filename, platform);
  const filePath = await getAvailableFilePath(defaultPath, { platform });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(temporaryPath, data, { flag: "wx" });
    await fs.promises.rename(temporaryPath, filePath);
    return filePath;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function executeDesktopWebExportArtifact(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  source?: DesktopActionCallRequest["source"]
): Promise<DesktopActionCallResponse> {
  const format = readString(args, "format").toLowerCase();
  if (!isDesktopWebExportFormat(format)) {
    return fail(action, "export_format_unsupported", "format must be png, html, project, or pdf.");
  }
  const surfaceId = readString(args, "surfaceId");
  if (!surfaceId) return fail(action, "invalid_args", "surfaceId is required.");
  const target = await options.resolveWebSurface?.({ method: "Surface.getState", surfaceId, ...(source ? { source } : {}) });
  if (!target || target.surfaceKind !== "webapp") return fail(action, "current_webapp_required", "The authorized Surface must be a WebApp with an export provider.");
  await target.validate();
  const provider = await readDesktopExportProvider(target.contents);
  if (provider.status === "unavailable") {
    return fail(action, "export_provider_unavailable", "The current WebApp does not expose export provider v1.");
  }
  if (provider.status === "render_failed") {
    return fail(action, "export_render_failed", "The WebApp export provider could not be inspected.");
  }
  const formats = Array.isArray(provider.description.formats)
    ? provider.description.formats.filter((value): value is string => typeof value === "string")
    : [];
  if (!formats.includes(format)) {
    return fail(action, "export_format_unsupported", `The current WebApp does not support ${format} export.`);
  }

  await target.validate();
  const spec = DESKTOP_WEB_EXPORT_SPEC[format];
  let filename = "";
  let data: Buffer | null = null;
  if (format === "pdf") {
    const suggestedFilenames = asRecord(provider.description.suggestedFilenames);
    filename = validateExportFilename(suggestedFilenames.pdf, spec.extension) || "poster.pdf";
    try {
      data = await target.contents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        preferCSSPageSize: true
      });
    } catch {
      return fail(action, "export_render_failed", "Desktop could not render the WebApp as PDF.");
    }
  } else {
    const generated = asRecord(await createDesktopExportPayload(target.contents, format));
    if (generated.status === "unavailable") {
      return fail(action, "export_provider_unavailable", "The current WebApp export provider became unavailable.");
    }
    if (generated.status !== "ok") {
      return fail(action, "export_render_failed", `The WebApp could not render ${format}.`);
    }
    const payload = asRecord(generated.payload);
    filename = validateExportFilename(payload.filename, spec.extension);
    if (
      !filename ||
      payload.mimeType !== spec.mimeType ||
      payload.encoding !== spec.encoding ||
      typeof payload.data !== "string"
    ) {
      return fail(action, "export_payload_invalid", "The WebApp returned an invalid export payload.");
    }
    if (spec.encoding === "base64") {
      data = decodeStrictBase64(payload.data);
    } else if (!hasUnpairedUtf16Surrogate(payload.data)) {
      data = Buffer.from(payload.data, "utf8");
    }
    if (!data) {
      return fail(action, "export_payload_invalid", "The WebApp returned malformed export data.");
    }
  }
  if (!data || data.byteLength === 0) {
    return fail(action, "export_payload_invalid", "The rendered export is empty.");
  }
  if (data.byteLength > DESKTOP_WEB_EXPORT_MAX_BYTES) {
    return fail(action, "export_too_large", "The rendered export exceeds the 32 MiB limit.", {
      sizeBytes: data.byteLength,
      maxBytes: DESKTOP_WEB_EXPORT_MAX_BYTES
    });
  }

  await target.validate();
  const safeFilename = sanitizeDownloadFilename(filename, `poster${spec.extension}`);
  try {
    const filePath = await writeDesktopExportFile(options, safeFilename, data);
    return ok(action, {
      surfaceId: target.surfaceId,
      format,
      filePath,
      filename: path.basename(filePath),
      mimeType: spec.mimeType,
      sizeBytes: data.byteLength
    } satisfies DesktopWebExportArtifactResult);
  } catch {
    return fail(action, "export_write_failed", "Desktop could not write the export to Downloads.");
  }
}
