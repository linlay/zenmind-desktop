import { nativeImage } from "electron";
import type { Clipboard, GlobalShortcut } from "electron";
import {
  hideDesktopClipboardPalette,
  showDesktopClipboardPalette
} from "./desktop-effects";

const DEFAULT_CLIPBOARD_PLUGIN_SHORTCUT = "Alt+V";

type ClipboardShortcutRecord = {
  accelerator: string;
  url: string;
  width: number;
  height: number;
};

export type PluginClipboardBridgeOptions = {
  platform: NodeJS.Platform;
  clipboard: Pick<Clipboard, "readText" | "writeText" | "readImage" | "writeImage">;
  globalShortcut: Pick<GlobalShortcut, "register" | "unregister">;
};

function asPluginRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizePluginShortcutAccelerator(value: unknown) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_CLIPBOARD_PLUGIN_SHORTCUT;
  return raw.replace(/^Option\+/iu, "Alt+");
}

function normalizePluginLocalHttpUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("url is required");
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:") {
    throw new Error("url must use http");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("url must point to localhost");
  }
  return parsed.toString();
}

function clampPluginWindowDimension(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

export function createPluginClipboardBridge(options: PluginClipboardBridgeOptions) {
  const pluginClipboardShortcuts = new Map<string, ClipboardShortcutRecord>();

  function readDesktopClipboardText() {
    if (options.platform === "darwin") {
      return { text: options.clipboard.readText(), platform: "darwin" };
    }
    if (options.platform === "win32") {
      return { text: options.clipboard.readText(), platform: "win32" };
    }
    return { text: options.clipboard.readText(), platform: options.platform };
  }

  function writeDesktopClipboardText(params: unknown) {
    const text = String(asPluginRecord(params).text ?? "");
    if (options.platform === "darwin") {
      options.clipboard.writeText(text);
      return { written: true, platform: "darwin" };
    }
    if (options.platform === "win32") {
      options.clipboard.writeText(text);
      return { written: true, platform: "win32" };
    }
    options.clipboard.writeText(text);
    return { written: true, platform: options.platform };
  }

  function readDesktopClipboardContent() {
    const image = options.clipboard.readImage();
    if (!image.isEmpty()) {
      return {
        type: "image",
        dataUrl: image.toDataURL(),
        platform: options.platform
      };
    }
    return {
      type: "text",
      text: options.clipboard.readText(),
      platform: options.platform
    };
  }

  function writeDesktopClipboardContent(params: unknown) {
    const record = asPluginRecord(params);
    if (record.type === "image") {
      const dataUrl = String(record.dataUrl ?? "");
      if (!/^data:image\//iu.test(dataUrl)) {
        throw new Error("image clipboard content requires a data:image URL");
      }
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) {
        throw new Error("image clipboard content is empty");
      }
      options.clipboard.writeImage(image);
      return { written: true, type: "image", platform: options.platform };
    }
    options.clipboard.writeText(String(record.text ?? ""));
    return { written: true, type: "text", platform: options.platform };
  }

  function showDesktopClipboardPaletteForPlugin(pluginId: string, params: unknown) {
    if (options.platform !== "darwin") {
      return { shown: false, unsupported: true, platform: options.platform };
    }
    const record = asPluginRecord(params);
    return showDesktopClipboardPalette(pluginId, {
      url: normalizePluginLocalHttpUrl(record.url),
      width: clampPluginWindowDimension(record.width, 520, 360, 760),
      height: clampPluginWindowDimension(record.height, 520, 320, 760)
    });
  }

  function hideDesktopClipboardPaletteForPlugin(pluginId: string) {
    return hideDesktopClipboardPalette(pluginId);
  }

  function unregisterDesktopClipboardShortcut(pluginId: string) {
    const owned = pluginClipboardShortcuts.get(pluginId);
    if (!owned) {
      return { unregistered: false };
    }
    options.globalShortcut.unregister(owned.accelerator);
    pluginClipboardShortcuts.delete(pluginId);
    hideDesktopClipboardPaletteForPlugin(pluginId);
    return { unregistered: true, accelerator: owned.accelerator };
  }

  function cleanupPlugin(pluginId: string) {
    unregisterDesktopClipboardShortcut(pluginId);
  }

  function registerDesktopClipboardShortcut(pluginId: string, params: unknown) {
    if (options.platform !== "darwin") {
      return { registered: false, unsupported: true, platform: options.platform };
    }
    const record = asPluginRecord(params);
    const accelerator = normalizePluginShortcutAccelerator(record.accelerator);
    const url = normalizePluginLocalHttpUrl(record.url);
    const width = clampPluginWindowDimension(record.width, 520, 360, 760);
    const height = clampPluginWindowDimension(record.height, 520, 320, 760);
    unregisterDesktopClipboardShortcut(pluginId);
    const registered = options.globalShortcut.register(accelerator, () => {
      showDesktopClipboardPalette(pluginId, { url, width, height });
    });
    if (!registered) {
      return { registered: false, accelerator };
    }
    pluginClipboardShortcuts.set(pluginId, { accelerator, url, width, height });
    return { registered: true, accelerator };
  }

  return {
    readDesktopClipboardText,
    writeDesktopClipboardText,
    readDesktopClipboardContent,
    writeDesktopClipboardContent,
    registerDesktopClipboardShortcut,
    unregisterDesktopClipboardShortcut,
    showDesktopClipboardPaletteForPlugin,
    hideDesktopClipboardPaletteForPlugin,
    cleanupPlugin
  };
}

export type PluginClipboardBridge = ReturnType<typeof createPluginClipboardBridge>;
