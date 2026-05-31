import type { DebugWebviewSurfaceRegistration } from "../../shared/contracts/debug";

export function readDebugWebContentsId(value: unknown) {
  const webContentsId = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("缺少有效的 webContentsId。");
  }
  return webContentsId;
}

export function normalizeDebugSurfaceRegistration(input: unknown): DebugWebviewSurfaceRegistration {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const webContentsId = readDebugWebContentsId(record.webContentsId);
  const kind = record.kind === "plugin" || record.kind === "external" ? record.kind : "webview";
  const readOptionalString = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    webContentsId,
    kind,
    ...(readOptionalString("surfaceId") ? { surfaceId: readOptionalString("surfaceId") } : {}),
    ...(readOptionalString("surfaceLabel") ? { surfaceLabel: readOptionalString("surfaceLabel") } : {}),
    ...(readOptionalString("tabId") ? { tabId: readOptionalString("tabId") } : {}),
    ...(readOptionalString("url") ? { url: readOptionalString("url") } : {})
  };
}
