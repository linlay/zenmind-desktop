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

type PreferredWebviewDevToolsTarget = {
  webContentsId?: number;
} | null | undefined;

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
  focusedWebviewDevToolsTarget?: PreferredWebviewDevToolsTarget;
  preferredWebviewDevToolsTarget?: PreferredWebviewDevToolsTarget;
  currentPageSnapshot: DesktopPageContextSnapshot | null | undefined;
  webContents: WebContentsLookup;
}) {
  const {
    focusedWebviewDevToolsTarget,
    preferredWebviewDevToolsTarget,
    currentPageSnapshot,
    webContents,
  } = options;
  // Split views can keep several guests alive at once, so the exact focused guest
  // must win before longer-lived Copilot and page-snapshot fallbacks.
  const focusedContents = focusedWebviewDevToolsTarget === undefined
    ? webContents.getFocusedWebContents()
    : typeof focusedWebviewDevToolsTarget?.webContentsId === "number"
      ? webContents.fromId(focusedWebviewDevToolsTarget.webContentsId)
      : null;
  const focusedResult = openFocusedWebviewDevTools(
    focusedContents
  );
  if (focusedResult.ok) {
    return { ok: true as const, source: "focused" as const };
  }

  if (typeof preferredWebviewDevToolsTarget?.webContentsId === "number") {
    const preferredContents = webContents.fromId(preferredWebviewDevToolsTarget.webContentsId);
    if (isLiveWebviewContents(preferredContents)) {
      preferredContents.openDevTools({ mode: "detach" });
      return { ok: true as const, source: "copilot" as const };
    }
  }

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

  return focusedResult;
}
