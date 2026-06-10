import type { WebContents } from "electron";

type FocusedWebviewDevToolsContents = Pick<
  WebContents,
  "getType" | "isDestroyed" | "openDevTools"
>;

export function openFocusedWebviewDevTools(
  focusedContents: FocusedWebviewDevToolsContents | null | undefined
) {
  if (!focusedContents || focusedContents.isDestroyed()) {
    return { ok: false, reason: "no-focused-webview" as const };
  }

  if (focusedContents.getType() !== "webview") {
    return { ok: false, reason: "not-webview" as const };
  }

  focusedContents.openDevTools({ mode: "detach" });
  return { ok: true as const };
}
