import type {
  DesktopGlobalSearchShortcut,
  DesktopGlobalSearchShortcutSlot
} from "../shared/contracts/desktop-api";

export type DesktopPlatform = NodeJS.Platform;

export type AppIdentityTarget = {
  setAppUserModelId(appId: string): void;
};

export function applyPlatformAppInit(platform: DesktopPlatform, app: AppIdentityTarget, appId: string) {
  if (platform === "win32") {
    app.setAppUserModelId(appId);
  }
}

type KeyboardShortcutInput = {
  type: string;
  key: string;
  code?: string;
  meta?: boolean;
  alt?: boolean;
  control?: boolean;
  shift?: boolean;
  isAutoRepeat?: boolean;
};

export function isDevToolsShortcut(platform: DesktopPlatform, input: KeyboardShortcutInput) {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "i") {
    return false;
  }
  if (platform === "darwin") {
    return Boolean(input.meta && input.alt && !input.control && !input.shift);
  }
  return Boolean(input.control && input.shift && !input.meta && !input.alt);
}

export function isGlobalSearchShortcut(platform: DesktopPlatform, input: KeyboardShortcutInput) {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "k") {
    return false;
  }
  if (platform === "darwin") {
    return Boolean(input.meta && !input.control && !input.alt && !input.shift);
  }
  if (platform === "win32") {
    return Boolean(input.control && !input.meta && !input.alt && !input.shift);
  }
  return false;
}

export function isWorkPanelCloseShortcut(platform: DesktopPlatform, input: KeyboardShortcutInput) {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.key.toLowerCase() !== "w") {
    return false;
  }
  if (platform === "darwin") {
    return Boolean(input.meta && !input.control && !input.alt && !input.shift);
  }
  if (platform === "win32") {
    return Boolean(input.control && !input.meta && !input.alt && !input.shift);
  }
  return false;
}

export function resolveGlobalSearchCommandShortcut(
  platform: DesktopPlatform,
  input: KeyboardShortcutInput
): DesktopGlobalSearchShortcut | null {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.shift) {
    return null;
  }
  const key = resolveGlobalSearchShortcutKey(input);
  const usesAgentModifier = platform === "darwin"
    ? Boolean(input.alt && !input.meta && !input.control)
    : platform === "win32"
      ? Boolean(input.alt && !input.control && !input.meta)
      : false;
  if (usesAgentModifier) {
    const slot = toGlobalSearchShortcutSlot(key);
    return slot ? { kind: "agent", slot } : null;
  }

  const usesPrimaryModifier = platform === "darwin"
    ? Boolean(input.meta && !input.control && !input.alt)
    : platform === "win32"
      ? Boolean(input.control && !input.meta && !input.alt)
      : false;
  if (!usesPrimaryModifier) {
    return null;
  }

  const slot = toGlobalSearchShortcutSlot(key);
  if (slot) {
    return { kind: "attention", slot };
  }
  switch (key) {
    case "n":
      return { kind: "action", actionId: "newChat" };
    case "h":
      return { kind: "action", actionId: "history" };
    case "a":
      return { kind: "action", actionId: "agents" };
    case "s":
      return { kind: "action", actionId: "skills" };
    case "m":
      return { kind: "action", actionId: "mcpConnectors" };
    default:
      return null;
  }
}

function resolveGlobalSearchShortcutKey(input: KeyboardShortcutInput) {
  // macOS Option+digit changes `key` into symbols such as ™ or £; `code` preserves the physical digit.
  const digitCode = /^(?:Digit|Numpad)([0-9])$/u.exec(input.code ?? "");
  if (digitCode) {
    return digitCode[1];
  }
  return input.key.toLowerCase();
}

function toGlobalSearchShortcutSlot(key: string): DesktopGlobalSearchShortcutSlot | null {
  if (key === "0") {
    return 10;
  }
  if (/^[1-9]$/u.test(key)) {
    return Number(key) as DesktopGlobalSearchShortcutSlot;
  }
  return null;
}

export function getFocusedWebviewDevToolsShortcut(platform: DesktopPlatform) {
  if (platform === "darwin") {
    return "Command+Shift+D";
  }
  if (platform === "win32") {
    return "Control+Shift+D";
  }
  return "Control+Shift+D";
}

export function getDesktopSsoBrowserUserAgent(
  platform: DesktopPlatform,
  versions: { chromeVersion?: string; electronVersion?: string } = {}
) {
  const chromeVersion = versions.chromeVersion || process.versions.chrome || "120.0.0.0";
  const electronVersion = versions.electronVersion || process.versions.electron || "0.0.0";
  const platformToken = platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Electron/${electronVersion} Safari/537.36`
    .replace(/\sElectron\/[^\s]+/u, "");
}

export function getArchiveExtensions(platform: DesktopPlatform) {
  return platform === "win32" ? ["zip"] : ["gz", "tgz"];
}
