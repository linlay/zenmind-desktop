import type { DesktopPlatform } from "../../infrastructure/electron/platform-adapter";
import type { WebviewEditCommand, AttachedWebviewLike } from "./window-model";

export function isWorkPanelFullscreenExitShortcut(input: any) {
  return input?.type === "keyDown" &&
    String(input?.key || "").toLowerCase() === "escape" &&
    input?.isAutoRepeat !== true &&
    input?.meta !== true &&
    input?.control !== true &&
    input?.alt !== true &&
    input?.shift !== true;
}

export function resolveWebviewEditShortcut(
  platform: DesktopPlatform,
  input: any
): WebviewEditCommand | null {
  if (input?.type && input.type !== "keyDown") {
    return null;
  }
  if (input?.alt || input?.shift) {
    return null;
  }

  const hasPlatformModifier = platform === "darwin"
    ? input?.meta === true && input?.control !== true
    : input?.control === true && input?.meta !== true;
  if (!hasPlatformModifier) {
    return null;
  }

  switch (String(input?.key || "").toLowerCase()) {
    case "a":
      return "selectAll";
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "x":
      return "cut";
    default:
      return null;
  }
}

export function runWebviewEditCommand(
  contents: AttachedWebviewLike,
  command: WebviewEditCommand
) {
  switch (command) {
    case "copy":
      contents.copy();
      return;
    case "cut":
      contents.cut();
      return;
    case "paste":
      contents.paste();
      return;
    case "selectAll":
      contents.selectAll();
      return;
  }
}
