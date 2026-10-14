import fs from "node:fs";
import { dialog, powerMonitor, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { WebsiteCredentialError, type WebsiteCredentialImportSummary, type WebsiteCredentialResult, type WebsiteCredentialRevealResult, type WebsiteCredentialState } from "../../../shared/website-credentials";
import { t } from "../../support/i18n/main-i18n";
import type { WebsiteCredentialStore } from "./store";
import type { AuthenticationGate } from "./system-auth";
import type { LoginCapture } from "./capture/controller";
import { decryptWebsiteCredentialBackup, encryptWebsiteCredentialBackup, isWebsiteCredentialBackup, parseWebsiteCredentialCsv, WEBSITE_CREDENTIAL_BACKUP_MAX_BYTES, WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES } from "./transfer";

const BACKUP_EXTENSION = "pwbackup";
type OperationResult = WebsiteCredentialState & { cancelled?: boolean; imported?: WebsiteCredentialImportSummary };

/** Vault management is only reachable from the main window's top frame; guests and WebApps have no path to it. */
export function registerWebsiteCredentialIpc(ipcMain: IpcMain, options: {
  getMainWindow(): BrowserWindow | null;
  store: WebsiteCredentialStore;
  gate: AuthenticationGate;
  capture: LoginCapture;
}) {
  const { store, gate, capture } = options;
  function requireOwner(event: IpcMainInvokeEvent) {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Website credential management requires the main window.");
    }
    return window;
  }
  const errorCode = (error: unknown) => error instanceof WebsiteCredentialError ? error.code : "storageFailed";
  /** Re-checks the sender after the system prompt: the window may have reloaded while it was open. */
  async function authenticated(event: IpcMainInvokeEvent) {
    await gate.require(t("settings.websiteCredentials.authReason"));
    requireOwner(event);
  }
  function register(channel: string, operation: (event: IpcMainInvokeEvent, input: any) => Promise<OperationResult> | OperationResult) {
    ipcMain.handle(channel, async (event, input): Promise<WebsiteCredentialResult> => {
      requireOwner(event);
      try { return { ok: true, ...await operation(event, input) }; }
      catch (error) { return { ok: false, error: errorCode(error) }; }
    });
  }

  register("settings.getWebsiteCredentials", () => store.state());
  register("settings.setWebsiteCredentialCapture", (_event, enabled) => {
    const state = store.setCaptureEnabled(enabled);
    if (state.captureEnabled) capture.refresh(); else capture.clearPending();
    return state;
  });
  register("settings.setWebsiteCredentialNeverSave", (_event, input) => store.setNeverSave(input?.origin, input?.never));
  // Answers a save prompt. The offer id is the capability: it is random, short-lived and only sent to this window.
  ipcMain.handle("credentials.resolveSaveOffer", (event, input): boolean => {
    requireOwner(event);
    const decision = input?.decision;
    if (decision !== "save" && decision !== "never" && decision !== "dismiss") return false;
    try { return capture.resolveOffer(input?.offerId, decision); }
    catch { return false; }
  });
  register("settings.addWebsiteCredential", (_event, input) => store.add(input));
  register("settings.updateWebsiteCredential", async (event, patch) => { await authenticated(event); return store.update(patch); });
  register("settings.removeWebsiteCredential", async (event, id) => { await authenticated(event); return store.remove(id); });
  ipcMain.handle("settings.revealWebsiteCredential", async (event, id): Promise<WebsiteCredentialRevealResult> => {
    requireOwner(event);
    try {
      await authenticated(event);
      return { ok: true, secret: store.reveal(id) };
    } catch (error) {
      return { ok: false, error: errorCode(error) };
    }
  });

  // An encrypted backup needs its password after the file is chosen; the renderer never handles the path.
  let pendingBackupPath: string | null = null;
  function readImportFile(file: string) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > WEBSITE_CREDENTIAL_BACKUP_MAX_BYTES) throw new WebsiteCredentialError("importTooLarge");
    const bytes = fs.readFileSync(file);
    // Only an encrypted backup may be larger than a browser CSV export.
    if (bytes.length > WEBSITE_CREDENTIAL_IMPORT_MAX_BYTES && !isWebsiteCredentialBackup(bytes)) throw new WebsiteCredentialError("importTooLarge");
    return bytes;
  }
  register("settings.importWebsiteCredentials", async (event, input) => {
    await authenticated(event);
    if (typeof input?.password === "string") {
      if (!pendingBackupPath) throw new WebsiteCredentialError("importUnrecognized");
      const imported = store.importMany(decryptWebsiteCredentialBackup(readImportFile(pendingBackupPath), input.password));
      pendingBackupPath = null;
      return { ...store.state(), imported };
    }
    pendingBackupPath = null;
    const selected = await dialog.showOpenDialog(requireOwner(event), {
      filters: [{ name: "CSV / Backup", extensions: ["csv", BACKUP_EXTENSION] }],
      properties: process.platform === "win32" ? ["openFile", "dontAddToRecent"] : ["openFile"]
    });
    requireOwner(event);
    if (selected.canceled || !selected.filePaths[0]) return { ...store.state(), cancelled: true };
    // A dialog can stay open indefinitely, through a lock or sleep: authenticate again before touching the vault.
    await authenticated(event);
    const bytes = readImportFile(selected.filePaths[0]);
    if (isWebsiteCredentialBackup(bytes)) {
      pendingBackupPath = selected.filePaths[0];
      throw new WebsiteCredentialError("backupPasswordRequired");
    }
    const imported = store.importMany(parseWebsiteCredentialCsv(bytes));
    return { ...store.state(), imported };
  });
  register("settings.exportWebsiteCredentials", async (event, input) => {
    await authenticated(event);
    const bytes = encryptWebsiteCredentialBackup(store.exportAll(), input?.password);
    const selected = await dialog.showSaveDialog(requireOwner(event), {
      defaultPath: `website-passwords.${BACKUP_EXTENSION}`,
      filters: [{ name: "Backup", extensions: [BACKUP_EXTENSION] }]
    });
    requireOwner(event);
    if (selected.canceled || !selected.filePath) return { ...store.state(), cancelled: true };
    // A dialog can stay open indefinitely, through a lock or sleep: authenticate again before writing the backup.
    await authenticated(event);
    fs.writeFileSync(selected.filePath, bytes, { mode: 0o600 });
    return store.state();
  });

  const clear = () => {
    gate.clear();
    capture.clearPending();
    pendingBackupPath = null;
    // The settings page drops any password it is showing or editing.
    const window = options.getMainWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("credentials.locked");
  };
  powerMonitor.on("lock-screen", clear);
  powerMonitor.on("suspend", clear);
}
