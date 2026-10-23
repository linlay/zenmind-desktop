import type { IpcMain, BrowserWindow } from "electron";
import { BROWSER_USE_CHANNEL, BROWSER_USE_SETTINGS_CHANNEL, CHROME_BROWSER_EXTENSION_URL,
  type BrowserUseControlRequest, type BrowserUsePreferences, type BrowserUseResult,
  type BrowserUseSettingsRequest, type BrowserUseSettingsResult, type BrowserUseSettingsState } from "../../../shared/browser-use";
import { BrowserUseRuntime, browserUseError } from "./runtime";

export function registerBrowserUseIpc(options: {
  ipcMain: IpcMain;
  runtime: BrowserUseRuntime;
  getMainWindow(): BrowserWindow | null;
  getActiveChatId(): string | undefined;
  openExternal(url: string): Promise<void>;
  settingsStore?: {
    read(): BrowserUsePreferences;
    update(input: Omit<Extract<BrowserUseSettingsRequest, { action: "save" }>, "action">): BrowserUsePreferences;
    forget(): BrowserUsePreferences;
  };
  onSettingsChanged?(state: BrowserUseSettingsState): void;
}) {
  const assertMain = (event: Electron.IpcMainInvokeEvent) => {
    const main = options.getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw Object.assign(new Error("Browser controls are only available in the main window."), { code: "forbidden" });
  };
  options.ipcMain.handle(BROWSER_USE_CHANNEL, async (event, input: BrowserUseControlRequest): Promise<BrowserUseResult> => {
    try {
      assertMain(event);
      if (!input || typeof input.chatId !== "string" || !input.chatId || input.chatId !== options.getActiveChatId())
        throw Object.assign(new Error("The active Chat changed. Reopen its browser controls."), { code: "chat_changed" });
      switch (input.action) {
        case "state": return { ok: true, state: await options.runtime.refreshState(input.chatId) };
        case "select": return { ok: true, state: options.runtime.select(input.chatId, input.backend) };
        case "connect":
          if (input.interactive !== undefined && typeof input.interactive !== "boolean")
            throw Object.assign(new Error("The connection mode must be a boolean."), { code: "invalid_args" });
          return { ok: true, state: await options.runtime.connect(input.chatId, { interactive: input.interactive }) };
        case "disconnect": return { ok: true, state: await options.runtime.disconnect(input.chatId) };
        case "takeover": return { ok: true, state: await options.runtime.takeover(input.chatId) };
        case "activate": return { ok: true, state: await options.runtime.activate(input.chatId, input.surfaceId) };
        case "install-extension":
          await options.openExternal(CHROME_BROWSER_EXTENSION_URL);
          return { ok: true, state: options.runtime.state(input.chatId) };
        default: throw Object.assign(new Error("Unsupported browser control."), { code: "invalid_args" });
      }
    } catch (error) { return { ok: false, error: browserUseError(error) }; }
  });
  options.ipcMain.handle(BROWSER_USE_SETTINGS_CHANNEL, async (event, input: BrowserUseSettingsRequest): Promise<BrowserUseSettingsResult> => {
    try {
      assertMain(event);
      if (!options.settingsStore)
        throw Object.assign(new Error("Browser settings are unavailable."), { code: "browser_settings_unavailable" });
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Object.assign(new Error("The browser settings request is invalid."), { code: "invalid_browser_settings" });
      const allowed = input.action === "save"
        ? ["action", "defaultBackend", "rememberChromeConnection", "extensionToken"] : ["action"];
      if (Object.keys(input).some(key => !allowed.includes(key)))
        throw Object.assign(new Error("The browser settings request is invalid."), { code: "invalid_browser_settings" });
      switch (input.action) {
        case "get": break;
        case "save": {
          const { action: _action, ...preferences } = input;
          options.settingsStore.update(preferences);
          break;
        }
        case "forget":
          if (options.runtime.hasActiveRuns())
            throw Object.assign(new Error("Stop active browser tasks before forgetting the connection."), { code: "browser_busy" });
          options.settingsStore.forget();
          await options.runtime.disconnectIdleConnections();
          break;
        case "install-extension": await options.openExternal(CHROME_BROWSER_EXTENSION_URL); break;
        default: throw Object.assign(new Error("The browser settings request is invalid."), { code: "invalid_browser_settings" });
      }
      // Runtime status notifications use a metadata-only snapshot. A trusted,
      // explicit settings query refreshes the real OS capability separately.
      let state = options.runtime.settingsState();
      if (input.action === "get") state = { ...state, ...options.settingsStore.read() };
      else if (input.action === "forget") {
        // A corrupt first query may never have probed system storage. Refresh it
        // after recovery so the current page can save a replacement immediately.
        // An unavailable probe cannot undo authorization that was already forgotten.
        try { state = { ...state, ...options.settingsStore.read() }; }
        catch { state = { ...state, secureStorageAvailable: false }; }
      }
      if (input.action !== "get") {
        try { options.onSettingsChanged?.(state); } catch { /* A closed UI cannot undo a saved setting. */ }
      }
      return { ok: true, state };
    } catch (error) { return { ok: false, error: browserUseError(error) }; }
  });
}
