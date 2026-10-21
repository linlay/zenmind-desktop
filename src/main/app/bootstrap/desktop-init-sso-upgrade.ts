import fs from "node:fs";
import type { App } from "electron";
import {
  buildOidcConfigFromRecord,
  isConfigEnabled,
  parseDesktopSsoConfigContent,
  resolveDesktopSsoConfigPath,
  type OidcConfig
} from "../../modules/identity";
import { t } from "../../support/i18n/main-i18n";
import { isRecord } from "./desktop-init-state";

function trustedIdentity(config: OidcConfig) {
  const browserOrigin = config.browserOrigin || (config.browserSession
    ? new URL(config.browserSession.url).origin
    : config.loginUrl ? new URL(config.loginUrl).origin : "");
  if (config.authMode === "server") {
    if (!config.webSessionExchange) throw new Error(t("sso.config.serverAuthNeedsWebSession"));
    return {
      mode: "server",
      browserOrigin,
      issuer: new URL(config.webSessionExchange.url).origin,
      audience: config.claims!.audience
    };
  }
  if (config.browserSession || config.loginUrl) {
    return {
      mode: "browser-cookie",
      browserOrigin,
      issuer: browserOrigin,
      audience: config.claims!.audience,
      accessTokenIssuer: config.cookieAccessTokenExchange?.accessTokenIssuer || "",
      accessTokenAudience: config.cookieAccessTokenExchange?.accessTokenAudience || ""
    };
  }
  return {
    mode: "oidc",
    browserOrigin,
    // OIDC issuer paths distinguish realms on the same host.
    issuer: new URL(config.issuer).toString(),
    audience: config.clientId
  };
}

function describeIdentity(identity: ReturnType<typeof trustedIdentity>) {
  const urls = [identity.browserOrigin, identity.issuer, identity.accessTokenIssuer];
  return [...new Set(urls.filter((value): value is string => Boolean(value)).map((value) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  }))].join(", ");
}

// Automatic upgrades must not silently select another identity environment.
// Explicit manual env import deliberately does not call this preflight.
export function validateDesktopInitSsoEnvironmentUpgrade(
  app: App,
  defaultsValue: unknown,
  platform: NodeJS.Platform = process.platform
) {
  if (!isRecord(defaultsValue) || !isRecord(defaultsValue.sso) || !isConfigEnabled(defaultsValue.sso)) return;
  const currentPath = resolveDesktopSsoConfigPath(app, platform);
  let currentContent: string;
  try {
    currentContent = fs.readFileSync(currentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let current: Record<string, unknown>;
  try {
    current = parseDesktopSsoConfigContent(currentContent);
  } catch {
    // JSON parser errors can echo credential-bearing source text.
    throw new Error(t("sso.config.fileObjectOrIamHost"));
  }
  if (!isConfigEnabled(current)) return;
  const currentIdentity = trustedIdentity(buildOidcConfigFromRecord(current));
  const incomingIdentity = trustedIdentity(buildOidcConfigFromRecord(defaultsValue.sso));
  if (JSON.stringify(currentIdentity) !== JSON.stringify(incomingIdentity)) {
    throw new Error(t("startup.envImport.ssoEnvironmentMismatch", {
      current: describeIdentity(currentIdentity),
      incoming: describeIdentity(incomingIdentity)
    }));
  }
}
