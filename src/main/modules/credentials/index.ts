import path from "node:path";
import type { App, BrowserWindow } from "electron";
import { getDesktopConfigRoot, getSecretsRoot } from "../../infrastructure/filesystem/user-paths";
import { restrictDirectoryToCurrentUser } from "./access-control";
import { createLoginCapture } from "./capture/controller";
import { createAgentCredentialAccess, type AgentCredentialAccess } from "./fill/agent-access";
import { createSystemVaultKeyProtector } from "./key-protector";
import { createWebsiteCredentialStore } from "./store";
import { createAuthenticationGate, createSystemAuthenticator } from "./system-auth";

export { registerWebsiteCredentialIpc } from "./ipc";
export { restrictDirectoryToCurrentUser } from "./access-control";
export type { WebsiteCredentialStore } from "./store";
export { createAgentCredentialAccess } from "./fill/agent-access";
export type { AgentCredentialAccess, AgentCredentialAccount } from "./fill/agent-access";

let agentAccess: AgentCredentialAccess | null = null;

/** The vault as agents may use it; null until the vault has been created. */
export function getAgentCredentialAccess() {
  return agentAccess;
}

/**
 * Builds the website password vault under `<desktop-data-root>/secrets` and the login
 * capture that feeds it. Call after `app` is ready; register `capture` as a web guest observer.
 */
export function createWebsiteCredentials(app: App, options: { platform?: NodeJS.Platform; getMainWindow(): BrowserWindow | null }) {
  const platform = options.platform ?? process.platform;
  const secretsRoot = getSecretsRoot(app, platform);
  const store = createWebsiteCredentialStore({
    vaultDirectory: path.join(secretsRoot, "website-credentials"),
    policyFile: path.join(getDesktopConfigRoot(app, platform), "website-credentials.json"),
    protector: createSystemVaultKeyProtector(platform),
    hardenDirectory(directory) {
      // The whole secrets partition is owner-only, not just the vault.
      restrictDirectoryToCurrentUser(secretsRoot, platform);
      restrictDirectoryToCurrentUser(directory, platform);
    }
  });
  // Save prompts are shown by the main window's trusted UI and carry no password.
  const sendToMainWindow = (channel: string, payload: unknown) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  };
  const capture = createLoginCapture({
    store,
    presentOffer: offer => sendToMainWindow("credentials.saveOffer", offer),
    withdrawOffer: offerId => { sendToMainWindow("credentials.saveOfferWithdrawn", offerId); }
  });
  agentAccess = createAgentCredentialAccess(store);
  return { store, capture, gate: createAuthenticationGate({ authenticator: createSystemAuthenticator(platform) }) };
}
