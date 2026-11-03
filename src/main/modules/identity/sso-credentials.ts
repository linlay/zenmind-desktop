import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import { getSecretsRoot } from "../../infrastructure/filesystem/user-paths";
import { restrictDirectoryToCurrentUser } from "../credentials";
import { SsoKnownFailure } from "./sso-failures";

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

const pendingCredentials = new Map<string, SsoCredentials>();

export function clearSsoCredentials(app: App, platform: NodeJS.Platform = process.platform) {
  const file = path.join(getSecretsRoot(app, platform), "sso-credentials.json");
  pendingCredentials.delete(file);
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(path.dirname(file), "sso-credentials.enc"), { force: true });
}

export function createSsoCredentialStore(app: App, platform: NodeJS.Platform) {
  const file = path.join(getSecretsRoot(app, platform), "sso-credentials.json");
  // Keep a rotated credential in memory even when its atomic disk publication fails.
  return {
    read(gateway: string): SsoCredentials | null {
      const pending = pendingCredentials.get(file);
      if (!pending && !fs.existsSync(file)) return null;
      let value: SsoCredentials;
      try {
        // Never open legacy .enc files: startup must not invoke the OS keychain.
        value = pending || JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new SsoKnownFailure("credentialRead");
      }
      if (!value || value.schemaVersion !== 1 || value.gateway !== gateway || !value.subject || !value.issuer ||
          !value.audience || typeof value.idToken !== "string" || !value.idToken ||
          (value.refreshToken !== undefined && (typeof value.refreshToken !== "string" || !value.refreshToken))) {
        throw new SsoKnownFailure("credentialMismatch");
      }
      return { ...value };
    },
    save(value: SsoCredentials) {
      pendingCredentials.set(file, { ...value });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        restrictDirectoryToCurrentUser(path.dirname(file), platform);
        // Directory protection is explicit on macOS (0700) and Windows (user ACL).
        // This is a permission-protected plaintext file, not an encrypted vault.
        fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(temporary, file);
        pendingCredentials.delete(file);
        fs.rmSync(path.join(path.dirname(file), "sso-credentials.enc"), { force: true });
      } catch {
        throw new SsoKnownFailure("credentialSave");
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    clear() {
      clearSsoCredentials(app, platform);
    }
  };
}
