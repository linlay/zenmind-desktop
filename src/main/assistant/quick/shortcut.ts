import type { globalShortcut as GlobalShortcut } from "electron";
import { normalizeQuickAssistantShortcut } from "../../../shared/assistant-settings";
import { isQuickAssistantSupportedPlatform, QUICK_ASSISTANT_SHORTCUT } from "./quick-copilot";
import type { QuickCopilotWindowController } from "./window";

type GlobalShortcutRegistry = typeof GlobalShortcut;
type QuickCopilotShortcutRegistrationReason = "unsupported-platform" | "registration-failed";

export type QuickCopilotShortcutRegistrationResult = {
  accelerator: string;
  registered: boolean;
  reason?: QuickCopilotShortcutRegistrationReason;
};

export function registerQuickCopilotShortcut({
  platform,
  globalShortcut,
  controller,
  accelerator = QUICK_ASSISTANT_SHORTCUT
}: {
  platform: NodeJS.Platform | string;
  globalShortcut: GlobalShortcutRegistry;
  controller: QuickCopilotWindowController;
  accelerator?: string;
}): QuickCopilotShortcutRegistrationResult {
  const normalizedAccelerator = normalizeQuickAssistantShortcut(accelerator);
  if (!isQuickAssistantSupportedPlatform(platform)) {
    return {
      accelerator: normalizedAccelerator,
      registered: false,
      reason: "unsupported-platform"
    };
  }
  const registered = globalShortcut.register(normalizedAccelerator, () => {
    controller.toggleWindow();
  });
  if (!registered) {
    console.warn(`failed to register quick assistant shortcut: ${normalizedAccelerator}`);
    return {
      accelerator: normalizedAccelerator,
      registered: false,
      reason: "registration-failed"
    };
  }
  return {
    accelerator: normalizedAccelerator,
    registered: true
  };
}

export function unregisterQuickCopilotShortcut({
  platform,
  globalShortcut,
  accelerator = QUICK_ASSISTANT_SHORTCUT
}: {
  platform: NodeJS.Platform | string;
  globalShortcut: GlobalShortcutRegistry;
  accelerator?: string;
}) {
  if (!isQuickAssistantSupportedPlatform(platform)) {
    return;
  }
  globalShortcut.unregister(normalizeQuickAssistantShortcut(accelerator));
}
