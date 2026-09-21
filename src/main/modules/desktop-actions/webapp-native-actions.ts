import path from "node:path";
import { type OpenDialogOptions, systemPreferences, Notification, shell, dialog, type SaveDialogOptions, clipboard } from "electron";
import { asRecord, readString, ok, fail } from "./action-values";
import {
  type WebappBridgePermissionStatus,
  type WebappBridgeCapabilitiesResult,
  WEBAPP_BRIDGE_VERSION,
  WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES,
  WEBAPP_BRIDGE_RESERVED_CAPABILITIES
} from "../../../shared/webapp-bridge";
import { type DesktopActionBridgeOptions } from "./action-contracts";
import { type DesktopActionCallResponse } from "../../../shared/desktop-actions";

export const MAX_WEBAPP_EXTERNAL_URL_CHARS = 8_192;

export const MAX_WEBAPP_CLIPBOARD_BYTES = 1024 * 1024;

export const MAX_WEBAPP_NOTIFICATION_TITLE_CHARS = 120;

export const MAX_WEBAPP_NOTIFICATION_BODY_CHARS = 1_000;

export const WEBAPP_NATIVE_RATE_WINDOW_MS = 60_000;

export const WEBAPP_EXTERNAL_RATE_LIMIT = 5;

export const WEBAPP_NOTIFICATION_RATE_LIMIT = 5;

export const WEBAPP_PAGE_ONLY_ACTIONS = new Set([
  "desktop.capabilities.list",
  "desktop.native.browser.openExternal",
  "desktop.native.dialog.selectFiles",
  "desktop.native.dialog.selectDirectory",
  "desktop.native.dialog.selectSavePath",
  "desktop.native.microphone.getPermission",
  "desktop.native.microphone.requestAccess",
  "desktop.native.clipboard.writeText",
  "desktop.native.notification.show"
]);

export class WebappActionRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  take(key: string, limit: number, now = Date.now()) {
    const cutoff = now - WEBAPP_NATIVE_RATE_WINDOW_MS;
    const current = (this.attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (current.length >= limit) {
      this.attempts.set(key, current);
      return false;
    }
    current.push(now);
    this.attempts.set(key, current);
    return true;
  }

  clear() {
    this.attempts.clear();
  }
}

export const webappActionRateLimiter = new WebappActionRateLimiter();

export function webappPathResult(selectedPath: string) {
  return {
    path: selectedPath,
    name: path.basename(selectedPath) || selectedPath
  };
}

export function readWebappDialogFilters(value: unknown) {
  if (value === undefined) {
    return { ok: true as const, filters: undefined };
  }
  if (!Array.isArray(value) || value.length > 10) {
    return { ok: false as const, message: "filters must be an array with at most 10 items." };
  }
  const filters: NonNullable<OpenDialogOptions["filters"]> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = readString(record, "name");
    const extensions = Array.isArray(record.extensions)
      ? record.extensions.map((extension) => typeof extension === "string" ? extension.trim() : "")
      : [];
    if (
      !name ||
      name.length > 80 ||
      extensions.length === 0 ||
      extensions.length > 20 ||
      extensions.some((extension) => !/^[A-Za-z0-9*][A-Za-z0-9._+-]{0,31}$/u.test(extension))
    ) {
      return { ok: false as const, message: "each filter requires a name and 1-20 safe extensions." };
    }
    filters.push({ name, extensions });
  }
  return { ok: true as const, filters };
}

export function normalizeMicrophonePermission(value: string): WebappBridgePermissionStatus {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  if (value === "restricted") return "restricted";
  if (value === "not-determined" || value === "unknown") return "prompt";
  return "unavailable";
}

export function getMicrophonePermission(options: DesktopActionBridgeOptions) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return "unavailable" as const;
  }
  try {
    const raw = options.getMicrophonePermission
      ? options.getMicrophonePermission()
      : systemPreferences.getMediaAccessStatus("microphone");
    return normalizeMicrophonePermission(raw);
  } catch {
    return "unavailable" as const;
  }
}

export function getWebappBridgeCapabilities(
  options: DesktopActionBridgeOptions,
  webappId: string
): WebappBridgeCapabilitiesResult | null {
  const item = options.webs.webappManager.list(options.app)
    .find((candidate) => candidate.id === webappId) ?? null;
  if (!item || item.schemaVersion !== 2) {
    return null;
  }
  const microphonePermission = getMicrophonePermission(options);
  const notificationAvailable = options.showNotification ? true : Notification.isSupported();
  return {
    bridgeVersion: WEBAPP_BRIDGE_VERSION,
    capabilities: [
      ...WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES.map((id) => {
        const status = id === "desktop.microphone" && microphonePermission === "unavailable"
          ? "unavailable" as const
          : id === "desktop.notification" && !notificationAvailable
            ? "unavailable" as const
            : "available" as const;
        return {
          id,
          status,
          declared: id === "skill.read" ? !!item.copilot?.agentKey : true,
          permission: id === "desktop.microphone"
            ? microphonePermission
            : id === "desktop.notification" && !notificationAvailable
              ? "unavailable" as const
              : "not_required" as const
        };
      }),
      ...WEBAPP_BRIDGE_RESERVED_CAPABILITIES.map((id) => ({
        id,
        status: "reserved" as const,
        declared: false,
        permission: "unavailable" as const
      }))
    ]
  };
}

export function getWebappDialogOwner(options: DesktopActionBridgeOptions, webappId: string) {
  return options.webs.webappWindowManager.getWindow(webappId) ?? options.getMainWindow();
}

export async function executeNativeWebappAction(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  if (action === "desktop.capabilities.list") {
    const result = getWebappBridgeCapabilities(options, webappId);
    return result
      ? ok(action, result)
      : fail(action, "unsupported_schema", "Desktop Bridge v1 requires WebApp manifest schema v2.");
  }

  const owner = getWebappDialogOwner(options, webappId);
  if (action === "desktop.native.browser.openExternal") {
    const rawUrl = readString(args, "url");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return fail(action, "invalid_args", "url must be a valid HTTP(S) URL.");
    }
    if (
      !rawUrl ||
      rawUrl.length > MAX_WEBAPP_EXTERNAL_URL_CHARS ||
      (target.protocol !== "http:" && target.protocol !== "https:")
    ) {
      return fail(action, "invalid_args", "url must be an HTTP(S) URL with at most 8192 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:openExternal`, WEBAPP_EXTERNAL_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp opened too many external URLs.");
    }
    await (options.openExternal ?? shell.openExternal)(target.toString());
    return ok(action, { opened: true, url: target.toString() });
  }

  if (action === "desktop.native.dialog.selectFiles") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const dialogOptions: OpenDialogOptions = {
      title: "Select files",
      properties: args.multiple === true ? ["openFile", "multiSelections"] : ["openFile"],
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    return ok(action, {
      canceled: result.canceled,
      files: result.canceled ? [] : result.filePaths.map(webappPathResult)
    });
  }

  if (action === "desktop.native.dialog.selectDirectory") {
    const dialogOptions: OpenDialogOptions = {
      title: "Select directory",
      defaultPath: options.app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"]
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePaths[0] || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.dialog.selectSavePath") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const suggestedName = readString(args, "suggestedName");
    if (suggestedName.length > 255 || (suggestedName && path.basename(suggestedName) !== suggestedName)) {
      return fail(action, "invalid_args", "suggestedName must be a filename with at most 255 characters.");
    }
    const dialogOptions: SaveDialogOptions = {
      title: "Select save path",
      ...(suggestedName ? { defaultPath: path.join(options.app.getPath("documents"), suggestedName) } : {}),
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showSaveDialog
      ? await options.showSaveDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePath || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.microphone.getPermission") {
    return ok(action, { permission: getMicrophonePermission(options) });
  }

  if (action === "desktop.native.microphone.requestAccess") {
    if (process.platform === "darwin") {
      const granted = await (options.requestMicrophoneAccess
        ? options.requestMicrophoneAccess()
        : systemPreferences.askForMediaAccess("microphone"));
      return granted
        ? ok(action, { permission: "granted" })
        : fail(action, "permission_denied", "Microphone permission was denied.", { permission: "denied" });
    }
    if (process.platform === "win32") {
      const permission = getMicrophonePermission(options);
      return permission === "denied" || permission === "restricted"
        ? fail(action, "permission_denied", "Microphone permission is unavailable.", { permission })
        : ok(action, { permission });
    }
    return fail(action, "unsupported_platform", "Microphone access is unavailable on this platform.");
  }

  if (action === "desktop.native.clipboard.writeText") {
    const text = typeof args.text === "string" ? args.text : "";
    if (Buffer.byteLength(text, "utf8") > MAX_WEBAPP_CLIPBOARD_BYTES) {
      return fail(action, "invalid_args", "text must be at most 1 MiB when encoded as UTF-8.");
    }
    (options.writeClipboardText ?? ((value: string) => clipboard.writeText(value)))(text);
    return ok(action, { written: true });
  }

  if (action === "desktop.native.notification.show") {
    const title = readString(args, "title");
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!title || title.length > MAX_WEBAPP_NOTIFICATION_TITLE_CHARS || body.length > MAX_WEBAPP_NOTIFICATION_BODY_CHARS) {
      return fail(action, "invalid_args", "title is required (max 120 characters); body is limited to 1000 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:notification`, WEBAPP_NOTIFICATION_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp showed too many notifications.");
    }
    const focus = () => options.webs.webappWindowManager.focus(webappId, options.getMainWindow());
    const shown = options.showNotification
      ? options.showNotification({ title, body, onClick: focus })
      : Notification.isSupported()
        ? (() => {
            const notification = new Notification({ title, body });
            notification.once("click", focus);
            notification.show();
            return true;
          })()
        : false;
    return shown
      ? ok(action, { shown: true })
      : fail(action, "unavailable", "System notifications are unavailable.");
  }

  return fail(action, "unknown_action", `unknown WebApp native action: ${action}`);
}
