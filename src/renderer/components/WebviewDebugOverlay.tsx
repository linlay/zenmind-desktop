import { useEffect, useMemo, useState } from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import {
  buildWebviewDebugClipboardText,
  formatWebviewDebugSurfaceLabel,
  redactWebviewDebugUrl,
} from "../debug/webviewDebugUrl";
import type { SurfaceIdentity } from "../../shared/surface-identity";
import { useI18n } from "../i18n/useI18n";

type CopyState = "idle" | "copied" | "failed";

export function WebviewDebugOverlay({
  url,
  surfaceIdentity,
}: {
  url: string;
  surfaceIdentity?: SurfaceIdentity;
}) {
  const debugMode = useDebugMode();
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const displayUrl = useMemo(() => redactWebviewDebugUrl(url), [url]);
  const displaySurfaceLabel = formatWebviewDebugSurfaceLabel(surfaceIdentity);
  const copyText = buildWebviewDebugClipboardText(url, surfaceIdentity);

  useEffect(() => {
    setCopyState("idle");
  }, [copyText]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopyAll() {
    try {
      const result = await window.electronAPI.clipboard.writeText(copyText);
      setCopyState(result.ok ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  }

  const copyLabel = copyState === "copied"
    ? t("settings.debug.webviewOverlay.copied")
    : copyState === "failed"
      ? t("settings.debug.webviewOverlay.copyFailed")
      : t("settings.debug.webviewOverlay.copyAll");

  if (!debugMode || (!displayUrl && !displaySurfaceLabel)) {
    return null;
  }

  return (
    <div className="webview-debug-url-overlay">
      {displaySurfaceLabel ? (
        <div className="webview-debug-surface-id">
          {displaySurfaceLabel}
        </div>
      ) : null}
      {displayUrl ? <div className="webview-debug-url-value">{displayUrl}</div> : null}
      {copyText ? (
        <button
          aria-live="polite"
          className={`webview-debug-copy-button is-${copyState}`}
          onClick={() => void handleCopyAll()}
          title={copyLabel}
          type="button"
        >
          {copyLabel}
        </button>
      ) : null}
    </div>
  );
}
