function parseHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
  } catch {
    // Invalid URLs should fall back to the external-open path.
  }
  return null;
}

const DOWNLOAD_FILE_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".gz",
  ".json",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".tar",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip"
]);

export function shouldDownloadUrlFromWebview(url: string) {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return false;
  }

  const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
  const lastSegment = pathname.split("/").pop() ?? "";
  const extensionIndex = lastSegment.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return false;
  }

  return DOWNLOAD_FILE_EXTENSIONS.has(lastSegment.slice(extensionIndex));
}

export function shouldOpenUrlInDesktopTab(url: string) {
  return parseHttpUrl(url) !== null;
}

export function resolveWebviewOpenDisposition(url: string) {
  if (shouldDownloadUrlFromWebview(url)) {
    return "download";
  }
  return shouldOpenUrlInDesktopTab(url) ? "tab" : "external";
}

export const __testInternals = {
  parseHttpUrl
};
