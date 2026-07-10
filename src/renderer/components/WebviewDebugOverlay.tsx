import { useMemo } from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import { redactWebviewDebugUrl } from "../debug/webviewDebugUrl";

export function WebviewDebugOverlay({ url }: { url: string }) {
  const debugMode = useDebugMode();
  const displayUrl = useMemo(() => redactWebviewDebugUrl(url), [url]);

  if (!debugMode || !displayUrl) {
    return null;
  }

  return (
    <div className="webview-debug-url-overlay" aria-hidden="true">
      {displayUrl}
    </div>
  );
}
