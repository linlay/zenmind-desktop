import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { t } from "./i18n/main-i18n";
import { resolveDesktopCapability } from "./services/manager/capabilities";
import { getService } from "./services/service-registry";
import { getServiceDataRoot } from "./user-paths";

const IDENTITY_CENTER_SERVICE_ID = "identity-center";

export function getIdentityCenterPublicKeyExportPath(app: App) {
  const service = getService(IDENTITY_CENTER_SERVICE_ID);
  return path.join(getServiceDataRoot(app, service.id, service.kind), "keys", "publicKey.pem");
}

export async function ensureIdentityCenterJwk(app: App) {
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
