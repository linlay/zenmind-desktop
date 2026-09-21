import { type DesktopPageContextSnapshot } from "../../../shared/contracts";

export function readSnapshotUrl(snapshot: DesktopPageContextSnapshot) {
  const browserTarget = snapshot.pageContext?.browserTarget;
  if (browserTarget?.kind === "webview" && browserTarget.currentUrl) {
    return browserTarget.currentUrl;
  }
  return snapshot.pageContext?.url || "";
}

export function readUrlOrigin(rawUrl: string) {
  try {
    const origin = new URL(rawUrl).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}
