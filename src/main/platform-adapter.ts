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
