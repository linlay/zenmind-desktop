import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";

type FocusedWebviewDevToolsContents = Pick<
  WebContents,
  "getType" | "isDestroyed" | "openDevTools"
>;

type WebContentsLookup = {
  fromId: (id: number) => FocusedWebviewDevToolsContents | null | undefined;
  getFocusedWebContents: () => FocusedWebviewDevToolsContents | null | undefined;
};

function isLiveWebviewContents(
  contents: FocusedWebviewDevToolsContents | null | undefined
): contents is FocusedWebviewDevToolsContents {
  return Boolean(
    contents &&
    !contents.isDestroyed() &&
    contents.getType() === "webview"
  );
}

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

export function openCurrentWebviewDevTools(options: {
  currentPageSnapshot: DesktopPageContextSnapshot | null | undefined;
  webContents: WebContentsLookup;
}) {
  const { currentPageSnapshot, webContents } = options;
  if (
    currentPageSnapshot?.pageKind === "webview" &&
    typeof currentPageSnapshot.webContentsId === "number"
  ) {
    const snapshotContents = webContents.fromId(currentPageSnapshot.webContentsId);
    if (isLiveWebviewContents(snapshotContents)) {
      snapshotContents.openDevTools({ mode: "detach" });
      return { ok: true as const, source: "snapshot" as const };
    }
  }

  const focusedResult = openFocusedWebviewDevTools(
    webContents.getFocusedWebContents()
  );
  return focusedResult.ok
    ? { ok: true as const, source: "focused" as const }
    : focusedResult;
}
