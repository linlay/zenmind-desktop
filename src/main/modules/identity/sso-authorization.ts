import { randomBytes, createHash } from "node:crypto";
import type { OidcConfig, TokenExchangeRequest } from "./sso-model";
import { DEFAULT_OIDC_CONFIG, DEFAULT_GOOGLE_SCOPE } from "./sso-defaults";
import { t } from "../../support/i18n/main-i18n";
import { isGoogleOidcConfig } from "./sso-config-values";

export function createPkceCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

export function createPkceCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(
  state: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeChallenge?: string;
  } = {}
) {
  if (config.loginUrl) {
    return buildConfiguredLoginUrl(state, config.loginUrl, config.appendLoginState);
  }
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri || config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scope || DEFAULT_GOOGLE_SCOPE);
  if (options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const prompt = config.prompt?.trim();
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  return url.toString();
}

export function buildServerBrokerAuthorizeUrl(state: string, callbackUrl: string, config: OidcConfig) {
  if (!config.serverAuthorizeUrl) {
    throw new Error(t("sso.config.serverAuthorizeRequired"));
  }
  const url = new URL(config.serverAuthorizeUrl);
  url.searchParams.set("callback", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildConfiguredLoginUrl(state: string, loginUrl: string, appendState = true) {
  if (!appendState) {
    return new URL(loginUrl).toString();
  }
  const url = new URL(loginUrl);
  if (url.hash) {
    const hashValue = url.hash.slice(1);
    const queryStartIndex = hashValue.indexOf("?");
    const hashPath = queryStartIndex >= 0 ? hashValue.slice(0, queryStartIndex) : hashValue;
    const hashQuery = queryStartIndex >= 0 ? hashValue.slice(queryStartIndex + 1) : "";
    const hashParams = new URLSearchParams(hashQuery);
    hashParams.set("state", state);
    url.hash = `${hashPath}?${hashParams.toString()}`;
    return url.toString();
  }
  url.searchParams.set("state", state);
  return url.toString();
}

export function getIdentityProviderCookieHosts(config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  const hosts = new Set<string>();
  for (const value of [
    config.issuer,
    config.authorizeUrl,
    config.loginUrl,
    config.tokenUrl,
    config.wellKnownUrl,
    config.logoutUrl,
    config.cookieAccessTokenExchange?.url,
    config.browserSession?.url,
    config.userInfo?.url
  ]) {
    if (!value) {
      continue;
    }
    try {
      const host = new URL(value).hostname.trim().toLowerCase();
      if (host) {
        hosts.add(host);
      }
    } catch {
      // Ignore malformed optional URLs; required URLs fail later when used.
    }
  }
  return [...hosts];
}

export function isDesktopSsoAuthorizeUrl(value: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  try {
    const url = new URL(value);
    const authorizeUrl = new URL(config.authorizeUrl);
    return url.origin === authorizeUrl.origin && url.pathname === authorizeUrl.pathname;
  } catch {
    return false;
  }
}

export function buildTokenExchangeRequest(
  code: string,
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: {
    redirectUri?: string;
    codeVerifier?: string;
  } = {}
): TokenExchangeRequest {
  const tokenUrl = new URL(config.tokenUrl);
  if (isGoogleOidcConfig(config)) {
    const bodyParams = new URLSearchParams();
    bodyParams.set("client_id", config.clientId);
    if (config.clientSecret?.trim()) {
      bodyParams.set("client_secret", config.clientSecret.trim());
    }
    bodyParams.set("redirect_uri", options.redirectUri || config.redirectUri);
    bodyParams.set("grant_type", "authorization_code");
    bodyParams.set("code", code);
    if (options.codeVerifier) {
      bodyParams.set("code_verifier", options.codeVerifier);
    }
    return {
      url: tokenUrl.toString(),
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyParams.toString()
    };
  }
  const bodyParams = new URLSearchParams();
  bodyParams.set("client_id", config.clientId);
  if (config.clientSecret?.trim()) {
    bodyParams.set("client_secret", config.clientSecret.trim());
  }
  bodyParams.set("redirect_uri", options.redirectUri || config.redirectUri);
  bodyParams.set("grant_type", "authorization_code");
  bodyParams.set("code", code);
  if (options.codeVerifier) {
    bodyParams.set("code_verifier", options.codeVerifier);
  }
  return {
    url: tokenUrl.toString(),
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  };
}

export function buildLogoutUrl(
  config: OidcConfig = DEFAULT_OIDC_CONFIG,
  options: { idTokenHint?: string } = {}
) {
  const url = new URL(config.logoutUrl);
  const idTokenHint = options.idTokenHint?.trim();
  if (idTokenHint) {
    url.searchParams.set("id_token_hint", idTokenHint);
    url.searchParams.set("post_logout_redirect_uri", config.logoutCallbackUri);
  }
  return url.toString();
}
