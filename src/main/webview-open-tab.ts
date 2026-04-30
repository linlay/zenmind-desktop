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

export function shouldOpenUrlInDesktopTab(url: string) {
  return parseHttpUrl(url) !== null;
}

export function resolveWebviewOpenDisposition(url: string) {
  return shouldOpenUrlInDesktopTab(url) ? "tab" : "external";
}

export const __testInternals = {
  parseHttpUrl
};
