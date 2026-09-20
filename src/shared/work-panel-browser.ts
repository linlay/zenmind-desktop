export const WORK_PANEL_BROWSER_SHORTCUT_CHANNEL = "app.workPanelBrowserShortcut";
export const BROWSER_ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
export type WorkPanelBrowserCommand = "find" | "print" | "zoom-in" | "zoom-out" | "zoom-reset";
export type WorkPanelBrowserShortcut = { guestId: number; command: WorkPanelBrowserCommand };

export function nextBrowserZoom(current: number, direction: number) {
  return direction > 0
    ? BROWSER_ZOOM_STEPS.find((value) => value > current) ?? 300
    : [...BROWSER_ZOOM_STEPS].reverse().find((value) => value < current) ?? 25;
}

export function resolveWorkPanelBrowserShortcut(platform: string, input: {
  type?: string; key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean;
}): WorkPanelBrowserCommand | null {
  if (input.type && input.type !== "keyDown") return null;
  // macOS uses Command; Windows and Linux use Control.
  const modifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!modifier || input.alt) return null;
  if (input.key === "+" || input.key === "=") return "zoom-in";
  if (input.shift) return null;
  switch (input.key.toLowerCase()) {
    case "-": return "zoom-out";
    case "0": return "zoom-reset";
    case "f": return "find";
    case "p": return "print";
    default: return null;
  }
}
