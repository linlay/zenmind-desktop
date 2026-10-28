import type { FetchLike, OidcConfig } from "./sso-model";
import type { SsoCredentials } from "./sso-credentials";
import { getJwtPayload } from "./sso-claims";
import { validateIdToken } from "./sso-token-validation";
import { DesktopSsoRestoreRequestError } from "./sso-controller-model";

export class SsoTokenRequestError extends DesktopSsoRestoreRequestError {
  constructor(status?: number) {
    super(`SSO token request failed (${status || "network"}).`, status);
  }
}

export function isRetryableSsoTokenError(error: unknown) {
  return error instanceof SsoTokenRequestError && (error.status === undefined || error.status === 502);
}

/** A trusted same-origin HTTPS gateway validates the ID token upstream. Decoding
 * here only checks shape, expiry and account continuity; optional JWKS is verified too. */
export async function parseSsoTokenResponse(
  value: unknown, config: OidcConfig, fetchImpl: FetchLike, previous?: SsoCredentials | null
): Promise<SsoCredentials> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SSO token response must be JSON.");
  const body = value as Record<string, unknown>;
  const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
  if (idToken.split(".").length !== 3) throw new Error("SSO response has no valid id_token.");
  const claims = getJwtPayload(idToken);
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() ||
      typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.iss !== "string" || !claims.iss ||
      !(typeof claims.aud === "string" && claims.aud || Array.isArray(claims.aud) && claims.aud.length && claims.aud.every(x => typeof x === "string" && x))) {
    throw new Error("SSO ID token has invalid identity or expiry.");
  }
  const audience = JSON.stringify(Array.isArray(claims.aud) ? [...claims.aud].sort() : [claims.aud]);
  if (previous && (previous.subject !== claims.sub || previous.issuer !== claims.iss || previous.audience !== audience)) {
    throw new Error("SSO refreshed identity does not match the current account.");
  }
  if (config.jwksUrl || config.wellKnownUrl) await validateIdToken(idToken, fetchImpl, config);
  if (body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token.trim())) {
    throw new Error("SSO response contains an invalid refresh_token.");
  }
  return {
    schemaVersion: 1, gateway: new URL(config.tokenExchange!.url).origin,
    subject: claims.sub, issuer: claims.iss, audience, idToken,
    ...(previous?.accountId ? { accountId: previous.accountId } : {}),
    ...(body.refresh_token ? { refreshToken: String(body.refresh_token).trim() } :
      previous?.refreshToken ? { refreshToken: previous.refreshToken } : {})
  };
}

export async function requestSsoTokens(
  config: OidcConfig, fetchImpl: FetchLike, options: {
    previous?: SsoCredentials | null; cookie?: string; signal: AbortSignal;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }
) {
  const refreshToken = options.previous?.refreshToken;
  const url = refreshToken ? config.tokenRefresh!.url : config.tokenExchange!.url;
  const wait = options.wait || ((ms, signal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new SsoTokenRequestError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (options.signal.aborted) throw new SsoTokenRequestError();
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(5_000)]);
      let response;
      try {
        response = await fetchImpl(url, {
          method: refreshToken ? "POST" : "GET", redirect: "manual", credentials: "omit", signal,
          headers: { Accept: "application/json", ...(refreshToken
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : options.cookie ? { Cookie: options.cookie } : {}) },
          ...(refreshToken ? { body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString() } : {})
        });
      } catch { throw new SsoTokenRequestError(); }
      if (!response.ok) throw new SsoTokenRequestError(response.status);
      let body: unknown;
      try { body = await response.json(); } catch { throw new Error("SSO token response is not valid JSON."); }
      return await parseSsoTokenResponse(body, config, fetchImpl, options.previous);
    } catch (error) {
      if (!isRetryableSsoTokenError(error) || attempt === 2 || options.signal.aborted) throw error;
      await wait(attempt === 0 ? 1_000 : 3_000, options.signal);
    }
  }
  throw new SsoTokenRequestError();
}
