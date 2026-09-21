import { DEFAULT_OIDC_CONFIG, DEFAULT_GOOGLE_OIDC_CONFIG, DESKTOP_SSO_CONFIG_FILE_NAME } from "./sso-defaults";
import {
  buildAuthorizeUrl,
  createPkceCodeChallenge,
  isDesktopSsoAuthorizeUrl,
  getIdentityProviderCookieHosts,
  buildLogoutUrl,
  buildConfiguredLoginUrl,
  buildTokenExchangeRequest
} from "./sso-authorization";
import { buildDesktopSsoProxyUrl, rewriteDesktopSsoProxyLocation, rewriteDesktopSsoProxySetCookieHeader } from "./sso-proxy-urls";
import { buildReturnToAppUrl, renderCallbackHtml } from "./sso-callback-page";
import { buildDesktopSsoBrowserCookieDetails, getDesktopSsoCookieMirrorOrigins } from "./sso-proxy";
import { loadDesktopSsoConfig, getDesktopSsoAvatarCacheConfig } from "./sso-config";
import { resolveDesktopSsoConfigPath, getDesktopSsoUserInfoFilePath } from "./sso-paths";
import { buildCookieAccessTokenExchangeRequest, readCookieAccessTokenFromResponse } from "./sso-cookie-token";
import { shouldUseSystemBrowser } from "./sso-config-values";
import {
  buildDesktopSsoAccessTokenCookieDetails,
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  completeDesktopSsoBrowserUserInfo,
  completeDesktopSsoCookieLogin,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoBrowserSessionConfig,
  getDesktopSsoCookieUserInfoConfig,
  resolveDesktopSsoAvatarRequest,
  getDesktopSsoAccessTokenCookieLookup,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoWebSessionClearCookies,
  isDesktopSsoLoginCompletionUrl
} from "./sso-browser-session";
import { cancelDesktopSsoLogin } from "./sso-login";
import { desktopSsoAccessTokenNeedsRefresh, saveAccessTokenFile } from "./sso-session";
import { getDesktopSsoAccessTokenFilePath } from "../../infrastructure/filesystem/user-paths";
import { normalizeCallbackRequest } from "./sso-callback-params";
import { getDefaultOidcFetch } from "./sso-http";
import { completeValidatedOidcLogin, exchangeCodeForTokenClaims, exchangeCodeForClaims, validateIdToken } from "./sso-token-validation";
import { closeCallbackServer } from "./callback-lifecycle";

export const __testInternals = {
  DEFAULT_OIDC_CONFIG,
  DEFAULT_GOOGLE_OIDC_CONFIG,
  DESKTOP_SSO_CONFIG_FILE_NAME,
  buildAuthorizeUrl,
  createPkceCodeChallenge,
  buildDesktopSsoProxyUrl,
  buildReturnToAppUrl,
  buildDesktopSsoBrowserCookieDetails,
  getDesktopSsoCookieMirrorOrigins,
  rewriteDesktopSsoProxyLocation,
  rewriteDesktopSsoProxySetCookieHeader,
  isDesktopSsoAuthorizeUrl,
  getIdentityProviderCookieHosts,
  loadDesktopSsoConfig,
  resolveDesktopSsoConfigPath,
  buildLogoutUrl,
  buildConfiguredLoginUrl,
  buildTokenExchangeRequest,
  buildCookieAccessTokenExchangeRequest,
  shouldUseSystemBrowser,
  buildDesktopSsoAccessTokenCookieDetails,
  cancelDesktopSsoLogin,
  completeDesktopSsoBrowserLogin,
  completeDesktopSsoBrowserSession,
  completeDesktopSsoBrowserSessionUserInfo,
  completeDesktopSsoBrowserUserInfo,
  completeDesktopSsoCookieLogin,
  desktopSsoAccessTokenNeedsRefresh,
  getDesktopSsoAccessTokenFilePath,
  getDesktopSsoUserInfoFilePath,
  getDesktopSsoCookieAccessTokenExchangeUrl,
  getDesktopSsoBrowserSessionConfig,
  getDesktopSsoCookieUserInfoConfig,
  getDesktopSsoAvatarCacheConfig,
  resolveDesktopSsoAvatarRequest,
  getDesktopSsoAccessTokenCookieLookup,
  getDesktopSsoAccessTokenCookieLookups,
  getDesktopSsoWebSessionExchangeConfig,
  getDesktopSsoWebSessionClearCookies,
  isDesktopSsoLoginCompletionUrl,
  readCookieAccessTokenFromResponse,
  saveAccessTokenFile,
  normalizeCallbackRequest,
  getDefaultOidcFetch,
  completeValidatedOidcLogin,
  exchangeCodeForTokenClaims,
  exchangeCodeForClaims,
  validateIdToken,
  renderCallbackHtml,
  closeCallbackServer
};
