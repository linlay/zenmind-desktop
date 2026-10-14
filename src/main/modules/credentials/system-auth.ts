import { systemPreferences } from "electron";
import { WebsiteCredentialError } from "../../../shared/website-credentials";

export type SystemAuthenticationOutcome = "authenticated" | "failed" | "unavailable";
export type SystemAuthenticator = { authenticate(reason: string): Promise<SystemAuthenticationOutcome> };

/**
 * Asks the operating system to confirm the user is present. This is a UI gate in
 * front of the vault, not a cryptographic unlock: the vault key does not depend on it.
 */
export function createSystemAuthenticator(platform: NodeJS.Platform = process.platform): SystemAuthenticator {
  return {
    async authenticate(reason) {
      if (platform === "darwin") {
        // Electron only exposes the Touch ID prompt (with its built-in password fallback).
        // Macs without Touch ID need a native LocalAuthentication call and are refused until then.
        if (!systemPreferences.canPromptTouchID()) return "unavailable";
        try {
          await systemPreferences.promptTouchID(reason);
          return "authenticated";
        } catch {
          return "failed";
        }
      }
      if (platform === "win32") {
        // Electron has no Windows Hello / credential prompt API; refuse rather than skip the gate.
        return "unavailable";
      }
      return "unavailable";
    }
  };
}

/** A successful authentication stays valid briefly so related actions do not each prompt. */
export const SYSTEM_AUTHENTICATION_GRACE_MS = 60_000;

export function createAuthenticationGate(options: { authenticator: SystemAuthenticator; graceMs?: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? SYSTEM_AUTHENTICATION_GRACE_MS;
  let validUntil = 0;
  let generation = 0;
  return {
    /** Throws unless the user is, or was just, confirmed by the operating system. */
    async require(reason: string) {
      if (now() < validUntil) return;
      const startedIn = generation;
      const outcome = await options.authenticator.authenticate(reason);
      if (outcome === "unavailable") throw new WebsiteCredentialError("authenticationUnavailable");
      // A lock or sleep during the prompt invalidates its result.
      if (outcome !== "authenticated" || startedIn !== generation) throw new WebsiteCredentialError("authenticationFailed");
      validUntil = now() + graceMs;
    },
    /** Called on lock screen and sleep. */
    clear() {
      validUntil = 0;
      generation += 1;
    }
  };
}

export type AuthenticationGate = ReturnType<typeof createAuthenticationGate>;
