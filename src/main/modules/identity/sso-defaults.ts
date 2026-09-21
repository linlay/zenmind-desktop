import type { DesktopSsoClaimsConfig, OidcConfig } from "./sso-model";
import { STORAGE_NAMESPACE, BRAND_ID } from "../../../shared/brand";

// Zero requests an available port from the OS; never publish this placeholder as a callback.
export const CALLBACK_PORT = 0;

export const CALLBACK_HOST = "localhost";

export const GOOGLE_LOOPBACK_HOST = "127.0.0.1";

export const CALLBACK_PATH = "/api/auth/oidc/callback";

export const LOGOUT_CALLBACK_PATH = "/api/auth/oidc/logout-callback";

export const RETURN_TO_APP_PATH = "/api/auth/oidc/return-to-app";

export const SESSION_FILE_NAME = "sso-session.json";

export const USER_INFO_FILE_NAME = "sso-user-info.json";

export const LEGACY_SITE_TOKEN_FILE_NAME = "sso-site-token.json";

export const DESKTOP_SSO_ACCESS_TOKEN_REFRESH_SKEW_MS = 15 * 60_000;

export const DESKTOP_SSO_CONFIG_FILE_NAME = "sso.json";

export const IDENTITY_PROVIDER_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "tokenUrl",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl"
] as const;

export const OIDC_CONFIG_STRING_FIELDS = [
  "provider",
  "providerLabel",
  "issuer",
  "authorizeUrl",
  "serverAuthorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
  "redirectUri",
  "scope",
  "prompt",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;

export const OIDC_CONFIG_URL_FIELDS = [
  "issuer",
  "authorizeUrl",
  "serverAuthorizeUrl",
  "loginUrl",
  "loginCompletionUrl",
  "tokenUrl",
  "redirectUri",
  "wellKnownUrl",
  "jwksUrl",
  "logoutUrl",
  "logoutCallbackUri"
] as const;

export const DEFAULT_COOKIE_ACCESS_TOKEN_PATH = "access_token";

export const DEFAULT_COOKIE_ACCESS_TOKEN_ACCEPT = "text/plain,application/json,*/*";

export const DEFAULT_ACCESS_TOKEN_COOKIE_NAME = "access_token";

export const DEFAULT_GOOGLE_SCOPE = "openid email profile";

export const DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG: DesktopSsoClaimsConfig = {
  audience: STORAGE_NAMESPACE,
  webSessionSubPrefix: `${BRAND_ID}-user:`,
  ticketPlaceholderSub: "desktop-sso-ticket",
  cookieFallbackSub: "desktop-sso-cookie",
  browserFallbackSub: "desktop-sso-browser"
};

export const DEFAULT_OIDC_CONFIG: OidcConfig = {
  issuer: "https://iam.example.com/auth/oidc/example-app",
  authorizeUrl: "https://iam.example.com/auth/oauth2/authorize",
  tokenUrl: "https://iam.example.com/auth/oauth2/token",
  clientId: "desktop-test-client",
  redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
  wellKnownUrl: "https://iam.example.com/auth/oidc/example-app/.well-known/openid-configuration",
  logoutUrl: "https://iam.example.com/auth/ssoLogout",
  logoutCallbackUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${LOGOUT_CALLBACK_PATH}`,
  appendLoginState: true
};

export const DEFAULT_GOOGLE_OIDC_CONFIG: OidcConfig = {
  provider: "google",
  issuer: "https://accounts.google.com",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "",
  clientSecret: "",
  redirectUri: `http://${GOOGLE_LOOPBACK_HOST}${CALLBACK_PATH}`,
  scope: DEFAULT_GOOGLE_SCOPE,
  wellKnownUrl: "https://accounts.google.com/.well-known/openid-configuration",
  logoutUrl: "",
  logoutCallbackUri: `http://${GOOGLE_LOOPBACK_HOST}${LOGOUT_CALLBACK_PATH}`,
  appendLoginState: true,
  usePkce: true
};
