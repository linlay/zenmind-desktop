import {
  app
} from "electron";
import { isDesktopDevelopmentRuntime } from "../infrastructure/electron/development-runtime";
import { safeConsoleError } from "../support/logging/safe-console";
export async function collectWebviewLoadDiagnostics(contents: Electron.WebContents, validatedUrl: string): Promise<Record<string, unknown>> {
  const sessionRef = contents.session;
  let resolvedProxy = "unknown";
  try {
    resolvedProxy = await sessionRef.resolveProxy(validatedUrl);
  }
  catch (error) {
    resolvedProxy = `resolve-proxy-failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    guestId: contents.id,
    currentUrl: contents.getURL(),
    validatedUrl,
    userAgent: contents.getUserAgent(),
    resolvedProxy,
    sessionPartition: sessionRef.getStoragePath() || "default"
  };
}

export function reportRendererDiagnostic(source: string, details: Record<string, unknown>) {
  const diagnosticLevel = details.diagnosticLevel === "debug" ||
    details.diagnosticLevel === "warn" ||
    details.diagnosticLevel === "error"
    ? details.diagnosticLevel
    : "error";
  const payload = {
    source,
    ...(source === "deprecated-compatibility" ? { desktopVersion: app.getVersion() } : {}),
    ...details
  };
  if (diagnosticLevel === "debug") {
    if (!isDesktopDevelopmentRuntime(app))
      return;
    console.debug("[renderer-diagnostic]", payload);
  }
  else if (diagnosticLevel === "warn") {
    console.warn("[renderer-diagnostic]", payload);
  }
  else {
    safeConsoleError("[renderer-diagnostic]", payload);
  }
}

