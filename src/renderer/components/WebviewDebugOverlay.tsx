import { useMemo } from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import { redactWebviewDebugUrl } from "../debug/webviewDebugUrl";
import type { SurfaceIdentity } from "../../shared/surface-identity";

export function WebviewDebugOverlay({
  url,
  surfaceIdentity,
}: {
  url: string;
  surfaceIdentity?: SurfaceIdentity;
}) {
  const debugMode = useDebugMode();
  const displayUrl = useMemo(() => redactWebviewDebugUrl(url), [url]);
  const displaySurfaceId = surfaceIdentity?.surfaceId.trim() || "";
  const displayBreadcrumb = surfaceIdentity
    ? [surfaceIdentity.parentSurfaceId, surfaceIdentity.surfaceRole].filter(Boolean).join(" › ")
    : "";

  if (!debugMode || (!displayUrl && !displaySurfaceId)) {
    return null;
  }

  return (
    <div className="webview-debug-url-overlay" aria-hidden="true">
      {displaySurfaceId ? (
        <div className="webview-debug-surface-id">
          {displayBreadcrumb ? `${displayBreadcrumb} · ` : ""}surfaceId: {displaySurfaceId}
        </div>
      ) : null}
      {displayUrl ? <div>{displayUrl}</div> : null}
    </div>
  );
}
