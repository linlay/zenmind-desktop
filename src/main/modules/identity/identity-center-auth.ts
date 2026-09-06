import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { t } from "../../support/i18n/main-i18n";
import type { IdentityCapabilityResolver } from "./agent-auth";
import { getServiceDataRoot } from "../../infrastructure/filesystem/user-paths";

const IDENTITY_CENTER_SERVICE_ID = "identity-center";

export function getIdentityCenterPublicKeyExportPath(app: App) {
  return path.join(getServiceDataRoot(app, IDENTITY_CENTER_SERVICE_ID), "keys", "publicKey.pem");
}

export async function ensureIdentityCenterJwk(app: App, resolveDesktopCapability: IdentityCapabilityResolver) {
  const capability = await resolveDesktopCapability(app, "auth.publicKey");
  const publicKeyPath = capability.filePath || getIdentityCenterPublicKeyExportPath(app);
  if (!fs.existsSync(publicKeyPath)) {
    throw new Error(t("identityCenterAuth.publicKeyMissing", { path: publicKeyPath }));
  }
  return {
    publicKeyPath,
    publicKeyPem: fs.readFileSync(publicKeyPath, "utf8")
  };
}
