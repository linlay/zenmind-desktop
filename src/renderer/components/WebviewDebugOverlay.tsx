import { useMemo } from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import { redactWebviewDebugUrl } from "../debug/webviewDebugUrl";

export function WebviewDebugOverlay({
  url,
  surfaceId,
}: {
  url: string;
  surfaceId?: string;
}) {
  const debugMode = useDebugMode();
  const displayUrl = useMemo(() => redactWebviewDebugUrl(url), [url]);
  const displaySurfaceId = surfaceId?.trim() || "";

  if (!debugMode || (!displayUrl && !displaySurfaceId)) {
    return null;
  }

  return (
    <div className="webview-debug-url-overlay" aria-hidden="true">
      {displaySurfaceId ? (
        <div className="webview-debug-surface-id">surfaceId: {displaySurfaceId}</div>
      ) : null}
      {displayUrl ? <div>{displayUrl}</div> : null}
    </div>
  );
}
