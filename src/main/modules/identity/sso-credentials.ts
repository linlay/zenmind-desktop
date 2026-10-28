import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import type { App } from "electron";
import { getSecretsRoot } from "../../infrastructure/filesystem/user-paths";
import { restrictDirectoryToCurrentUser } from "../credentials";

export type SsoCredentials = {
  schemaVersion: 1;
  gateway: string;
  subject: string;
  accountId?: string;
  issuer: string;
  audience: string;
  idToken: string;
  refreshToken?: string;
};

export type SsoCredentialProtection = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};

const pendingCredentials = new Map<string, SsoCredentials>();

export function clearSsoCredentials(app: App, platform: NodeJS.Platform = process.platform) {
  const file = path.join(getSecretsRoot(app, platform), "sso-credentials.enc");
  pendingCredentials.delete(file);
  fs.rmSync(file, { force: true });
}

export function systemSsoCredentialProtection(platform: NodeJS.Platform): SsoCredentialProtection {
  return {
    available() {
      if (platform === "darwin") return safeStorage.isEncryptionAvailable();
      if (platform === "win32") return safeStorage.isEncryptionAvailable();
      return false;
    },
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value)
  };
}

export function createSsoCredentialStore(app: App, platform: NodeJS.Platform, protection = systemSsoCredentialProtection(platform)) {
  const file = path.join(getSecretsRoot(app, platform), "sso-credentials.enc");
  // Keep a rotated credential in memory even when its atomic disk publication fails.
  function requireProtection() {
    if (!protection.available()) throw new Error("SSO system credential encryption is unavailable.");
  }
  return {
    read(gateway: string): SsoCredentials | null {
      const pending = pendingCredentials.get(file);
      if (!pending && !fs.existsSync(file)) return null;
      requireProtection();
      let value: SsoCredentials;
      try {
        value = pending || JSON.parse(protection.decrypt(fs.readFileSync(file)));
      } catch {
        throw new Error("SSO encrypted credentials could not be read.");
      }
      if (value.schemaVersion !== 1 || value.gateway !== gateway || !value.subject || !value.issuer ||
          !value.audience || typeof value.idToken !== "string" || !value.idToken ||
          (value.refreshToken !== undefined && (typeof value.refreshToken !== "string" || !value.refreshToken))) {
        throw new Error("SSO credential environment or format mismatch.");
      }
      return { ...value };
    },
    save(value: SsoCredentials) {
      pendingCredentials.set(file, { ...value });
      requireProtection();
      const encrypted = protection.encrypt(JSON.stringify(value));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      restrictDirectoryToCurrentUser(path.dirname(file), platform);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
        fs.renameSync(temporary, file);
        pendingCredentials.delete(file);
      } catch {
        throw new Error("SSO encrypted credentials could not be saved.");
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    clear() {
      clearSsoCredentials(app, platform);
    }
  };
}
