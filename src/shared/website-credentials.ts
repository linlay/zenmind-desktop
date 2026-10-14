import type { EpochMilliseconds } from "./time-contract";

/** Design: docs/网站密码与登录协助.md. Passwords never appear in any type except the reveal result. */

export const WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH = 320;
export const WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH = 1024;
export const WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH = 500;
export const WEBSITE_CREDENTIAL_BACKUP_PASSWORD_MIN_LENGTH = 8;

export type WebsiteCredentialErrorCode =
  | "vaultUnavailable"
  | "invalidOrigin"
  | "invalidInput"
  | "notFound"
  | "duplicate"
  | "authenticationFailed"
  | "authenticationUnavailable"
  | "importUnrecognized"
  | "importTooLarge"
  | "backupPasswordRequired"
  | "backupPasswordIncorrect"
  | "storageFailed"
  /** The change would make the vault larger than Desktop can open again; nothing was written. */
  | "vaultFull";

export class WebsiteCredentialError extends Error {
  constructor(readonly code: WebsiteCredentialErrorCode) {
    super(code);
    this.name = "WebsiteCredentialError";
  }
}

/** Why the vault cannot be opened. An unreadable vault is never treated as an empty one. */
export type WebsiteCredentialVaultUnavailableReason =
  | "protectionUnavailable"
  | "keyMissing"
  | "keyRejected"
  | "vaultCorrupted"
  | "vaultTooNew";

export type WebsiteCredentialVaultStatus =
  | { state: "ready" }
  | { state: "unavailable"; reason: WebsiteCredentialVaultUnavailableReason };

export type WebsiteCredentialSummary = {
  id: string;
  origin: string;
  maskedUsername: string;
  note: string;
  agentAllowed: boolean;
  isSiteDefault: boolean;
  createdAt: EpochMilliseconds;
  updatedAt: EpochMilliseconds;
  lastUsedAt: EpochMilliseconds | null;
};

export type WebsiteCredentialInput = {
  origin: string;
  username: string;
  password: string;
  note?: string;
};

export type WebsiteCredentialPatch = {
  id: string;
  username?: string;
  password?: string;
  note?: string;
  agentAllowed?: boolean;
  isSiteDefault?: boolean;
};

export type WebsiteCredentialSecret = { id: string; origin: string; username: string; password: string };

export type WebsiteCredentialState = {
  captureEnabled: boolean;
  vault: WebsiteCredentialVaultStatus;
  credentials: WebsiteCredentialSummary[];
  /** Sites where the user chose never to be asked to save a password. */
  neverSaveOrigins: string[];
};

/** A login Desktop observed and may save. The password stays in Main; the prompt never receives it. */
export type WebsiteCredentialSaveOffer = {
  offerId: string;
  origin: string;
  username: string;
  kind: "save" | "update";
  /** False when Desktop could not tell whether the login succeeded. */
  verified: boolean;
};

export type WebsiteCredentialSaveDecision = "save" | "never" | "dismiss";

/** Existing accounts are never overwritten by an import; they are counted as skipped. */
export type WebsiteCredentialImportSummary = { added: number; skipped: number; invalid: number };

export type WebsiteCredentialResult =
  | ({ ok: true; cancelled?: boolean; imported?: WebsiteCredentialImportSummary } & WebsiteCredentialState)
  | { ok: false; error: WebsiteCredentialErrorCode };

export type WebsiteCredentialRevealResult =
  | { ok: true; secret: WebsiteCredentialSecret }
  | { ok: false; error: WebsiteCredentialErrorCode };

/**
 * Credentials are bound to an exact origin (scheme + host + port). Only HTTPS is storable:
 * Desktop never fills a password into a page it cannot authenticate.
 */
export function normalizeWebsiteCredentialOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.origin;
}

/** Enough to tell accounts apart without placing the full identifier in lists or model context. */
export function maskWebsiteCredentialUsername(username: string): string {
  const value = username.trim();
  if (!value) return "";
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    return `${local.slice(0, Math.min(2, local.length))}***${value.slice(at)}`;
  }
  if (value.length >= 7) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 1)}***`;
}
