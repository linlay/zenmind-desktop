import { t } from "../../support/i18n/main-i18n";

export type SsoFailureStage = "readCredentials" | "readCookie" | "tokenRequest" | "accountRequest" | "accountParse" | "saveCredentials" | "syncCookies" | "publishSession";
export type SsoFailureCode = "requestFailed" | "responseJson" | "responseObject" | "missingIdToken" | "invalidIdClaims" | "identityChanged" | "invalidRefreshToken" | "idValidation" | "encryptionUnavailable" | "credentialRead" | "credentialMismatch" | "credentialEncrypt" | "credentialSave" | "accountHttp" | "accountJson" | "accountMissing" | "accountChanged" | "unexpected";

/** Only fixed, translated reasons cross the credential boundary. Never include
 * native exception messages, response bodies, arbitrary JSON keys or token values. */
export class SsoKnownFailure extends Error {
  constructor(readonly code: SsoFailureCode, readonly status?: number) {
    super(t(`sso.failure.${code}`));
    this.name = "SsoKnownFailure";
  }
}

export function describeSsoFailure(stage: SsoFailureStage, error: unknown) {
  const known = error instanceof SsoKnownFailure ? error : new SsoKnownFailure("unexpected");
  const status = typeof known.status === "number" && known.status >= 100 && known.status <= 599 ? known.status : undefined;
  const reason = t(`sso.failure.${known.code}`) + (status ? ` (HTTP ${status})` : "");
  return { stage, code: known.code, ...(status ? { status } : {}), message: t("sso.failureStage", { stage: t(`sso.stage.${stage}`), reason }) };
}
