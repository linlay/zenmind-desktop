import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { safeStorage, type App } from "electron";
import type { BrowserUseBackend, BrowserUsePreferences } from "../../../shared/browser-use";
import { getDesktopConfigRoot, getSecretsRoot } from "../../infrastructure/filesystem/user-paths";

const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 4096;
const MAX_AUTHORIZATION_BYTES = 16 * 1024;
const AUTHORIZATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TOKEN_PREFIX = "PLAYWRIGHT_MCP_EXTENSION_TOKEN=";

type StoredSettings = {
  version: 1;
  defaultBackend: BrowserUseBackend;
  rememberChromeConnection: boolean;
  authorizationId?: string;
};

export type BrowserUseSettingsInput = {
  defaultBackend?: BrowserUseBackend;
  rememberChromeConnection?: boolean;
  extensionToken?: string;
};

export type BrowserUseSettingsStore = {
  /** Main-only metadata snapshot; never probes or initializes OS cryptography. */
  readSnapshot(): BrowserUsePreferences;
  /** Explicit trusted settings query: refreshes actual system storage availability. */
  read(): BrowserUsePreferences;
  update(input: BrowserUseSettingsInput): BrowserUsePreferences;
  forget(): BrowserUsePreferences;
  /** Main-only: this value must never be returned through the public settings API. */
  authorization(): string | undefined;
};

const ERROR_MESSAGES = {
  invalid_browser_settings: "Browser settings are invalid.",
  invalid_browser_authorization: "The Chrome extension authorization is invalid.",
  secure_storage_unavailable: "Secure system storage is unavailable for Chrome authorization.",
  browser_authorization_unavailable: "The saved Chrome authorization cannot be read. Save it again or forget it.",
  browser_settings_unavailable: "Browser settings could not be read or saved.",
} as const;

export class BrowserUseSettingsError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
  }
}

const defaults = (): StoredSettings => ({ version: SETTINGS_VERSION, defaultBackend: "workpanel", rememberChromeConnection: false });
const fail = (code: keyof typeof ERROR_MESSAGES): never => { throw new BrowserUseSettingsError(code); };
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeAuthorization(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || /[\r\n]/u.test(value)) return fail("invalid_browser_authorization");
  let token = value.trim();
  const unquote = (text: string) => text.length >= 2 && (text[0] === "\"" || text[0] === "'") && text.at(-1) === text[0] ? text.slice(1, -1) : text;
  token = unquote(token);
  if (token.startsWith(TOKEN_PREFIX)) token = token.slice(TOKEN_PREFIX.length).trim();
  token = unquote(token);
  // The official extension generates a base64url token. Shell syntax and complete
  // commands are intentionally not accepted, even when copied beside the token.
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(token)) return fail("invalid_browser_authorization");
  return token;
}

/** Use after app readiness. macOS Keychain and Windows DPAPI never fall back to plaintext. */
export function createBrowserUseSettingsStore(app: App, platform: NodeJS.Platform = process.platform): BrowserUseSettingsStore {
  let configRoot: string;
  let secretsRoot: string;
  try {
    configRoot = path.resolve(getDesktopConfigRoot(app, platform));
    secretsRoot = path.resolve(getSecretsRoot(app, platform));
  } catch {
    return fail("browser_settings_unavailable");
  }
  const dataRoot = path.dirname(secretsRoot);
  const credentialRoot = path.join(secretsRoot, "browser-use");
  const settingsFile = path.join(configRoot, "browser-use.json");
  // Unknown is conservatively unavailable in background snapshots. The settings
  // page explicitly calls read(), while encryption/decryption verifies anew.
  let lastKnownSecureStorageAvailable = false;

  if (path.resolve(configRoot, "../..") !== dataRoot) return fail("browser_settings_unavailable");

  function secureStorageAvailable() {
    let available = false;
    try {
      if (platform === "darwin") available = safeStorage.isEncryptionAvailable();
      else if (platform === "win32") available = safeStorage.isEncryptionAvailable();
      // Some Linux builds expose a basic_text backend, which is not acceptable here.
    } catch { /* Keep the last completed probe conservative. */ }
    lastKnownSecureStorageAvailable = available;
    return available;
  }

  function safely<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof BrowserUseSettingsError) throw error;
      // Do not expose filesystem paths, OS/keychain diagnostics, or credential bytes.
      return fail("browser_settings_unavailable");
    }
  }

  function assertManagedPath(target: string, leaf: "file" | "directory") {
    const relative = path.relative(dataRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail("browser_settings_unavailable");
    const parts = relative ? relative.split(path.sep) : [];
    let current = dataRoot;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index]);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const isLeaf = index === parts.length - 1;
      if (stat.isSymbolicLink() || (!isLeaf || leaf === "directory") && !stat.isDirectory()) return fail("browser_settings_unavailable");
      if (isLeaf && leaf === "file" && (!stat.isFile() || stat.nlink !== 1)) return fail("browser_settings_unavailable");
    }
  }

  function hardenDirectory(directory: string) {
    assertManagedPath(directory, "directory");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertManagedPath(directory, "directory");
    if (platform === "win32") {
      const { username } = os.userInfo();
      const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
      execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
      return;
    }
    if (platform === "darwin") { fs.chmodSync(directory, 0o700); return; }
    fs.chmodSync(directory, 0o700);
  }

  function readSmallFile(file: string, limit: number): Buffer | undefined {
    assertManagedPath(file, "file");
    let descriptor: number;
    try {
      const noFollow = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || before.size > limit) return fail("browser_settings_unavailable");
      const content = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < content.length) {
        const read = fs.readSync(descriptor, content, length, content.length - length, null);
        if (!read) break;
        length += read;
      }
      if (length > limit) return fail("browser_settings_unavailable");
      assertManagedPath(file, "file");
      const current = fs.lstatSync(file);
      if (current.dev !== before.dev || current.ino !== before.ino) return fail("browser_settings_unavailable");
      return content.subarray(0, length);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function readStored(): StoredSettings {
    const bytes = readSmallFile(settingsFile, MAX_SETTINGS_BYTES);
    if (!bytes) return defaults();
    const stored: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(stored) || Object.keys(stored).some(key => !["version", "defaultBackend", "rememberChromeConnection", "authorizationId"].includes(key)) ||
      stored.version !== SETTINGS_VERSION || !["chrome", "workpanel"].includes(stored.defaultBackend as string) || typeof stored.rememberChromeConnection !== "boolean" ||
      (stored.rememberChromeConnection ? typeof stored.authorizationId !== "string" || !AUTHORIZATION_ID.test(stored.authorizationId) : stored.authorizationId !== undefined)) {
      return fail("browser_settings_unavailable");
    }
    return stored as StoredSettings;
  }

  function credentialFile(id: string) {
    if (!AUTHORIZATION_ID.test(id)) return fail("browser_authorization_unavailable");
    return path.join(credentialRoot, `${id}.sealed`);
  }

  function readEncrypted(id: string) {
    try {
      const bytes = readSmallFile(credentialFile(id), MAX_AUTHORIZATION_BYTES);
      if (!bytes || bytes.length < 2) return fail("browser_authorization_unavailable");
      const envelope: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isObject(envelope) || Object.keys(envelope).some(key => !["version", "ciphertext"].includes(key)) || envelope.version !== SETTINGS_VERSION ||
        typeof envelope.ciphertext !== "string" || !envelope.ciphertext || envelope.ciphertext.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.ciphertext)) return fail("browser_authorization_unavailable");
      const encrypted = Buffer.from(envelope.ciphertext, "base64");
      if (encrypted.toString("base64") !== envelope.ciphertext) return fail("browser_authorization_unavailable");
      return encrypted;
    } catch {
      return fail("browser_authorization_unavailable");
    }
  }

  function publicState(stored: StoredSettings): BrowserUsePreferences {
    return { defaultBackend: stored.defaultBackend, rememberChromeConnection: stored.rememberChromeConnection,
      hasSavedAuthorization: Boolean(stored.authorizationId), secureStorageAvailable: lastKnownSecureStorageAvailable };
  }

  function authorization(stored = readStored()) {
    if (!stored.rememberChromeConnection || !stored.authorizationId) return undefined;
    if (!secureStorageAvailable()) return fail("secure_storage_unavailable");
    try { return normalizeAuthorization(safeStorage.decryptString(readEncrypted(stored.authorizationId))); }
    catch { return fail("browser_authorization_unavailable"); }
  }

  function writeAtomic(file: string, content: string, limit: number) {
    if (Buffer.byteLength(content, "utf8") > limit) return fail("browser_settings_unavailable");
    const directory = path.dirname(file);
    hardenDirectory(directory);
    assertManagedPath(file, "file");
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      // Windows files inherit the owner-only directory ACL; POSIX needs an explicit mode.
      if (platform === "darwin") fs.fchmodSync(descriptor, 0o600);
      else if (platform !== "win32") fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertManagedPath(file, "file");
      assertManagedPath(temporary, "file");
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.rmSync(temporary, { force: true }); } catch { /* Keep the original failure safe and stable. */ }
    }
  }

  function removeObsoleteCredentials(keepId?: string) {
    assertManagedPath(credentialRoot, "directory");
    let files: string[];
    try { files = fs.readdirSync(credentialRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of files) {
      if (!name.endsWith(".sealed") || !AUTHORIZATION_ID.test(name.slice(0, -7)) || name === `${keepId}.sealed`) continue;
      const file = path.join(credentialRoot, name);
      assertManagedPath(file, "file");
      fs.unlinkSync(file);
    }
  }

  function commit(stored: StoredSettings, encrypted?: Buffer): BrowserUsePreferences {
    let staged: string | undefined;
    // Build the returned state before publishing so nothing can fail after commit.
    const result = publicState(stored);
    try {
      if (encrypted && stored.authorizationId) {
        hardenDirectory(secretsRoot);
        staged = credentialFile(stored.authorizationId);
        writeAtomic(staged, `${JSON.stringify({ version: SETTINGS_VERSION, ciphertext: encrypted.toString("base64") })}\n`, MAX_AUTHORIZATION_BYTES);
      }
      writeAtomic(settingsFile, `${JSON.stringify(stored)}\n`, MAX_SETTINGS_BYTES);
    } catch (error) {
      if (staged) {
        try { assertManagedPath(staged, "file"); fs.rmSync(staged, { force: true }); } catch { /* The old metadata still governs authorization. */ }
      }
      throw error;
    }
    // The metadata switch is authoritative. An interrupted cleanup can only leave
    // inaccessible old ciphertext; a later save/forget removes it, never revives it.
    try { removeObsoleteCredentials(stored.authorizationId); } catch { /* No rollback after the atomic publication. */ }
    return result;
  }

  return {
    readSnapshot: () => safely(() => publicState(readStored())),
    read: () => safely(() => {
      const stored = readStored();
      if (stored.authorizationId) readEncrypted(stored.authorizationId);
      // Even isEncryptionAvailable() can initialize Keychain synchronously on macOS.
      // Never perform this probe from a Run grant or a status notification.
      secureStorageAvailable();
      return publicState(stored);
    }),
    authorization: () => safely(() => authorization()),
    update: input => safely(() => {
      if (!isObject(input) || Object.keys(input).some(key => !["defaultBackend", "rememberChromeConnection", "extensionToken"].includes(key)) ||
        input.defaultBackend !== undefined && input.defaultBackend !== "chrome" && input.defaultBackend !== "workpanel" ||
        input.rememberChromeConnection !== undefined && typeof input.rememberChromeConnection !== "boolean") return fail("invalid_browser_settings");
      const token = input.extensionToken === undefined ? undefined : normalizeAuthorization(input.extensionToken);
      const before = readStored();
      const next: StoredSettings = { version: SETTINGS_VERSION, defaultBackend: input.defaultBackend ?? before.defaultBackend,
        rememberChromeConnection: input.rememberChromeConnection ?? before.rememberChromeConnection };
      let encrypted: Buffer | undefined;
      if (next.rememberChromeConnection) {
        if (!secureStorageAvailable()) return fail("secure_storage_unavailable");
        if (token) {
          try { encrypted = safeStorage.encryptString(token); }
          catch { return fail("browser_authorization_unavailable"); }
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_AUTHORIZATION_BYTES / 2) return fail("browser_authorization_unavailable");
          next.authorizationId = randomUUID();
        } else {
          if (!authorization(before)) return fail("invalid_browser_authorization");
          next.authorizationId = before.authorizationId;
        }
      }
      return commit(next, encrypted);
    }),
    forget: () => safely(() => {
      // Explicit forget also recovers a corrupt/unreadable token without decrypting it.
      let before = defaults();
      try { before = readStored(); } catch { /* Replace only when the user explicitly forgets authorization. */ }
      return commit({ version: SETTINGS_VERSION, defaultBackend: before.defaultBackend, rememberChromeConnection: false });
    }),
  };
}
