import type { globalShortcut as GlobalShortcut } from "electron";
import { isQuickAssistantSupportedPlatform, QUICK_ASSISTANT_SHORTCUT } from "./quick-copilot";
import type { QuickCopilotWindowController } from "./window";

type GlobalShortcutRegistry = typeof GlobalShortcut;

export function registerQuickCopilotShortcut({
  platform,
  globalShortcut,
  controller
}: {
  platform: NodeJS.Platform | string;
  globalShortcut: GlobalShortcutRegistry;
  controller: QuickCopilotWindowController;
}) {
  if (!isQuickAssistantSupportedPlatform(platform)) {
    return;
  }
  const registered = globalShortcut.register(QUICK_ASSISTANT_SHORTCUT, () => {
    controller.toggleWindow();
  });
  if (!registered) {
    console.warn(`failed to register quick assistant shortcut: ${QUICK_ASSISTANT_SHORTCUT}`);
  }
}

export function unregisterQuickCopilotShortcut({
  platform,
  globalShortcut
}: {
  platform: NodeJS.Platform | string;
  globalShortcut: GlobalShortcutRegistry;
}) {
  if (!isQuickAssistantSupportedPlatform(platform)) {
    return;
  }
  globalShortcut.unregister(QUICK_ASSISTANT_SHORTCUT);
}
