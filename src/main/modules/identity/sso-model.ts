import type { DesktopSsoStatus, DesktopSsoClaims } from "../../../shared/contracts";

export type DesktopSsoSessionMetadata = {
  issuer?: string;
  audience?: string;
  authMode?: "oidc" | "browser-cookie" | "server";
};

export type OidcConfig = {
  provider?: string;
  providerLabel?: string;
  authMode?: "server" | "oidc";
  browserMode?: "system" | "embedded";
  issuer: string;
  authorizeUrl: string;
  serverAuthorizeUrl?: string;
  loginUrl?: string;
  appendLoginState: boolean;
  loginCompletionUrl?: string;
  loginCompletionUrls?: string[];
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  prompt?: string;
  wellKnownUrl?: string;
  jwksUrl?: string;
  logoutUrl: string;
  logoutCallbackUri: string;
  browserOrigin?: string;
  usePkce?: boolean;
  cookieAccessTokenExchange?: CookieAccessTokenExchangeConfig;
  accessTokenCookie?: AccessTokenCookieConfig;
  accessTokenCookies?: AccessTokenCookieConfig[];
  browserSession?: DesktopSsoBrowserSessionConfig;
  // Recovery and runtime renewal use the same credential source; interactive login is unchanged.
  sessionRestore?: { authMode: "cookie" | "bearer" };
  userInfo?: DesktopSsoUserInfoConfig;
  avatarCache?: DesktopSsoAvatarCacheConfig;
  claims?: DesktopSsoClaimsConfig;
  webSessionExchange?: DesktopSsoWebSessionExchangeConfig;
};

export type CookieAccessTokenExchangeConfig = {
  url: string;
  csrfUrl?: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  accessTokenPath: string;
  validationMode: "identity" | "remote";
  accessTokenIssuer?: string;
  accessTokenAudience?: string;
};

export type DesktopSsoBrowserSessionConfig = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  successStatuses: number[];
  userInfoHeaders?: DesktopSsoBrowserSessionUserInfoHeaders;
};

export type DesktopSsoBrowserSessionUserInfoHeaders = {
  sub: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
};

export type AccessTokenCookieSameSite = "lax" | "strict" | "no_restriction";

export type AccessTokenCookieConfig = {
  url: string;
  name: string;
  path: string;
  domain?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: AccessTokenCookieSameSite;
};

export type DesktopSsoWebSessionClearCookieConfig = {
  url: string;
  name: string;
};

export type DesktopSsoClaimsConfig = {
  audience: string;
  webSessionSubPrefix: string;
  ticketPlaceholderSub: string;
  cookieFallbackSub: string;
  browserFallbackSub: string;
};

export type DesktopSsoUserInfoConfig = {
  enabled: boolean;
  required: boolean;
  authMode: "bearer" | "cookie";
  url: string;
  subPath: string;
  namePath: string;
  emailPath: string;
  avatarUrlPath: string;
};

export type DesktopSsoAvatarCacheConfig = {
  enabled: true;
  trustedOrigin: string;
};

export type DesktopSsoWebSessionExchangeConfig = {
  url: string;
  provider: string;
  claims: DesktopSsoClaimsConfig;
  cookieOrigins: string[];
  clearCookies: DesktopSsoWebSessionClearCookieConfig[];
};

export type DesktopSsoConfigLoadResult =
  | {
    configured: false;
    configPath: string;
    message: string;
    error?: undefined;
    config?: undefined;
  }
  | {
    configured: true;
    configPath: string;
    config: OidcConfig;
    message?: undefined;
    error?: undefined;
  }
  | {
    configured: true;
    configPath: string;
    error: string;
    message?: undefined;
    config?: undefined;
  };

export type TokenExchangeRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: string;
};

export type CookieAccessTokenExchangeRequest = {
  url: string;
  method: CookieAccessTokenExchangeConfig["method"];
  headers: Record<string, string>;
  body?: string;
};

export type FetchResponseLike = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: {
    get(name: string): string | null;
  };
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export type FetchLike = (url: string, init?: {
  credentials?: "omit" | "same-origin" | "include";
  redirect?: "manual" | "follow" | "error";
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export type ElectronFetchRuntime = {
  net?: {
    fetch?: FetchLike;
  };
};

export type CallbackHooks = {
  onBeforeStatusChanged?: (
    status: DesktopSsoStatus,
    context?: DesktopSsoStatusChangeContext
  ) => void | DesktopSsoClaims | Promise<void | DesktopSsoClaims>;
  onAfterStatusChanged?: (
    status: DesktopSsoStatus,
    context?: DesktopSsoStatusChangeContext
  ) => void | Promise<void>;
  onStatusChanged?: (status: DesktopSsoStatus) => void;
  onReturnToAppRequested?: () => void | Promise<void>;
};

export type DesktopSsoStatusChangeContext = {
  provider?: string;
  idToken?: string;
  ticket?: string;
};

export type PendingLogin = {
  state: string;
  startedAt: string;
  config: OidcConfig;
  redirectUri: string;
  codeVerifier?: string;
};

export type DesktopSsoProxyState = {
  config: OidcConfig;
  cookies: Map<string, string>;
};

export type CallbackServerInfo = {
  host: string;
  port: number;
  origin: string;
  redirectUri: string;
  logoutCallbackUri: string;
  closeAfterCallback: boolean;
};

export type CallbackServerOptions = {
  host: string;
  port: number;
  closeAfterCallback: boolean;
};

export type DesktopSsoBrowserCookieDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "lax";
};

export type DesktopSsoAccessTokenCookieDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  domain?: string;
  expirationDate?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: AccessTokenCookieSameSite;
};
