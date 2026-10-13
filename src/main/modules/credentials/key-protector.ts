import { safeStorage } from "electron";
import type { VaultKeyProtector } from "./vault-file";

/**
 * Protects the vault key with the operating system. Use only after `app` is ready.
 *
 * The two platforms give different guarantees and are kept as explicit branches:
 * macOS binds the key to the application signature through Keychain, while Windows
 * DPAPI only binds it to the user account and does not isolate other same-user processes.
 */
export function createSystemVaultKeyProtector(platform: NodeJS.Platform = process.platform): VaultKeyProtector {
  const supported = () => {
    if (platform === "darwin") return safeStorage.isEncryptionAvailable();
    if (platform === "win32") return safeStorage.isEncryptionAvailable();
    // No silent downgrade: other platforms may only offer an obfuscation-grade backend.
    return false;
  };
  return {
    available: supported,
    protect(key) {
      if (!supported()) throw new Error("System key protection is unavailable");
      return safeStorage.encryptString(key.toString("base64"));
    },
    unprotect(blob) {
      if (!supported()) throw new Error("System key protection is unavailable");
      return Buffer.from(safeStorage.decryptString(blob), "base64");
    }
  };
}
