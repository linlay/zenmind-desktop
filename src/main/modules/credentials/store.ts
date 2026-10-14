import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH,
  WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH,
  WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH,
  WebsiteCredentialError,
  maskWebsiteCredentialUsername,
  normalizeWebsiteCredentialOrigin,
  type WebsiteCredentialImportSummary,
  type WebsiteCredentialInput,
  type WebsiteCredentialPatch,
  type WebsiteCredentialSecret,
  type WebsiteCredentialState,
  type WebsiteCredentialSummary,
  type WebsiteCredentialVaultStatus
} from "../../../shared/website-credentials";
import type { EpochMilliseconds } from "../../../shared/time-contract";
import { openVaultFile, VaultCapacityError, writeVaultFile, type VaultKeyProtector } from "./vault-file";

type StoredCredential = {
  id: string;
  origin: string;
  username: string;
  password: string;
  note: string;
  agentAllowed: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};

/** Everything here is privacy-relevant (sites and account names included), so all of it lives inside the ciphertext. */
type VaultPayload = {
  credentials: StoredCredential[];
  siteDefaults: Record<string, string>;
  neverSaveOrigins: string[];
};

export type WebsiteCredentialStoreOptions = {
  /** `<secrets>/website-credentials`; created on first use. */
  vaultDirectory: string;
  /** Non-sensitive switches only. */
  policyFile: string;
  protector: VaultKeyProtector;
  /** Applies the platform's owner-only access control to the vault directory. */
  hardenDirectory(directory: string): void;
  now?: () => number;
};

const emptyPayload = (): VaultPayload => ({ credentials: [], siteDefaults: {}, neverSaveOrigins: [] });
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parsePayload(plaintext: Buffer): VaultPayload {
  const value = JSON.parse(plaintext.toString("utf8")) as Partial<VaultPayload>;
  if (!Array.isArray(value.credentials) || !Array.isArray(value.neverSaveOrigins) || !value.siteDefaults || typeof value.siteDefaults !== "object") {
    throw new Error("Invalid vault payload");
  }
  const ids = new Set<string>();
  for (const item of value.credentials) {
    const valid = item && typeof item.id === "string" && item.id && !ids.has(item.id)
      && normalizeWebsiteCredentialOrigin(item.origin) === item.origin
      && typeof item.username === "string" && typeof item.password === "string" && typeof item.note === "string"
      && typeof item.agentAllowed === "boolean" && isTime(item.createdAt) && isTime(item.updatedAt)
      && (item.lastUsedAt === null || isTime(item.lastUsedAt));
    if (!valid) throw new Error("Invalid vault payload");
    ids.add(item.id);
  }
  for (const [origin, id] of Object.entries(value.siteDefaults)) {
    if (typeof id !== "string" || normalizeWebsiteCredentialOrigin(origin) !== origin) throw new Error("Invalid vault payload");
  }
  if (value.neverSaveOrigins.some(origin => normalizeWebsiteCredentialOrigin(origin) !== origin)) throw new Error("Invalid vault payload");
  return value as VaultPayload;
}

function checkedText(value: unknown, maxLength: number, required: boolean) {
  if (typeof value !== "string" || value.length > maxLength || (required && !value)) throw new WebsiteCredentialError("invalidInput");
  return value;
}

export function createWebsiteCredentialStore(options: WebsiteCredentialStoreOptions) {
  const now = options.now ?? Date.now;

  type Session = { payload: VaultPayload; commit(): void };

  /** Each operation decrypts afresh, so plaintext passwords are not held between operations. */
  function open(): { status: WebsiteCredentialVaultStatus; session: Session | null } {
    const opened = openVaultFile(options.vaultDirectory, options.protector);
    if (opened.status.state !== "ready" || !("key" in opened)) return { status: opened.status, session: null };
    let payload: VaultPayload;
    try {
      payload = opened.plaintext ? parsePayload(opened.plaintext) : emptyPayload();
    } catch {
      return { status: { state: "unavailable", reason: "vaultCorrupted" }, session: null };
    }
    return {
      status: opened.status,
      session: {
        payload,
        commit() {
          try {
            fs.mkdirSync(options.vaultDirectory, { recursive: true });
            options.hardenDirectory(options.vaultDirectory);
            writeVaultFile(options.vaultDirectory, options.protector, opened, Buffer.from(JSON.stringify(payload), "utf8"));
          } catch (error) {
            throw new WebsiteCredentialError(error instanceof VaultCapacityError ? "vaultFull" : "storageFailed");
          }
        }
      }
    };
  }

  function requireSession() {
    const { session } = open();
    if (!session) throw new WebsiteCredentialError("vaultUnavailable");
    return session;
  }

  function find(payload: VaultPayload, id: unknown) {
    const credential = typeof id === "string" ? payload.credentials.find(item => item.id === id) : undefined;
    if (!credential) throw new WebsiteCredentialError("notFound");
    return credential;
  }

  const summarize = (payload: VaultPayload, item: StoredCredential): WebsiteCredentialSummary => ({
    id: item.id,
    origin: item.origin,
    maskedUsername: maskWebsiteCredentialUsername(item.username),
    note: item.note,
    agentAllowed: item.agentAllowed,
    isSiteDefault: payload.siteDefaults[item.origin] === item.id,
    createdAt: item.createdAt as EpochMilliseconds,
    updatedAt: item.updatedAt as EpochMilliseconds,
    lastUsedAt: item.lastUsedAt as EpochMilliseconds | null
  });

  const summaries = (payload: VaultPayload) => [...payload.credentials]
    .sort((left, right) => left.origin.localeCompare(right.origin) || left.username.localeCompare(right.username))
    .map(item => summarize(payload, item));

  function readCaptureEnabled() {
    try {
      return (JSON.parse(fs.readFileSync(options.policyFile, "utf8")) as { captureEnabled?: unknown }).captureEnabled === true;
    } catch {
      // Recording is opt-in: a missing or unreadable policy means disabled.
      return false;
    }
  }

  function state(): WebsiteCredentialState {
    const { status, session } = open();
    return {
      captureEnabled: readCaptureEnabled(),
      vault: status,
      credentials: session ? summaries(session.payload) : [],
      neverSaveOrigins: session ? [...session.payload.neverSaveOrigins].sort() : []
    };
  }

  /** Accounts usable on `origin`, the site default first, then the most recently used. */
  function orderedForOrigin(payload: VaultPayload, origin: string, agentOnly: boolean) {
    const defaultId = payload.siteDefaults[origin];
    return payload.credentials
      .filter(item => item.origin === origin && (!agentOnly || item.agentAllowed))
      .sort((left, right) => Number(right.id === defaultId) - Number(left.id === defaultId)
        || (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
        || right.updatedAt - left.updatedAt);
  }

  return {
    state,

    setCaptureEnabled(enabled: unknown): WebsiteCredentialState {
      if (typeof enabled !== "boolean") throw new WebsiteCredentialError("invalidInput");
      try {
        fs.mkdirSync(path.dirname(options.policyFile), { recursive: true });
        const temporary = `${options.policyFile}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify({ captureEnabled: enabled })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, options.policyFile);
      } catch {
        throw new WebsiteCredentialError("storageFailed");
      }
      return state();
    },

    isCaptureEnabled: readCaptureEnabled,

    /**
     * How a login just observed on `origin` relates to the vault. "unavailable" and
     * "never" mean no save prompt; "same" means there is nothing to save.
     */
    classifyCaptured(origin: string, username: string, password: string): "new" | "changed" | "same" | "never" | "unavailable" {
      const { session } = open();
      if (!session) return "unavailable";
      if (session.payload.neverSaveOrigins.includes(origin)) return "never";
      const existing = session.payload.credentials.find(item => item.origin === origin && item.username === username);
      return !existing ? "new" : existing.password === password ? "same" : "changed";
    },

    /** Saves a login the user confirmed in the save prompt: a new account, or a new password for a saved one. */
    saveCaptured(input: { origin: string; username: string; password: string }) {
      const origin = normalizeWebsiteCredentialOrigin(input.origin);
      if (!origin || origin !== input.origin) throw new WebsiteCredentialError("invalidOrigin");
      const username = checkedText(input.username, WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH, true);
      const password = checkedText(input.password, WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH, true);
      const session = requireSession();
      const time = now();
      const existing = session.payload.credentials.find(item => item.origin === origin && item.username === username);
      if (existing) Object.assign(existing, { password, updatedAt: time, lastUsedAt: time });
      else session.payload.credentials.push({ id: randomUUID(), origin, username, password, note: "", agentAllowed: true, createdAt: time, updatedAt: time, lastUsedAt: time });
      session.commit();
    },

    setNeverSave(origin: unknown, never: unknown): WebsiteCredentialState {
      const normalized = normalizeWebsiteCredentialOrigin(origin);
      if (!normalized || normalized !== origin) throw new WebsiteCredentialError("invalidOrigin");
      if (typeof never !== "boolean") throw new WebsiteCredentialError("invalidInput");
      const session = requireSession();
      const origins = new Set(session.payload.neverSaveOrigins);
      if (never) origins.add(normalized); else origins.delete(normalized);
      session.payload.neverSaveOrigins = [...origins];
      session.commit();
      return state();
    },

    add(input: WebsiteCredentialInput): WebsiteCredentialState {
      const origin = normalizeWebsiteCredentialOrigin(input?.origin);
      if (!origin) throw new WebsiteCredentialError("invalidOrigin");
      const username = checkedText(input.username, WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH, true);
      const password = checkedText(input.password, WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH, true);
      const note = checkedText(input.note ?? "", WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH, false);
      const session = requireSession();
      if (session.payload.credentials.some(item => item.origin === origin && item.username === username)) throw new WebsiteCredentialError("duplicate");
      const time = now();
      session.payload.credentials.push({ id: randomUUID(), origin, username, password, note, agentAllowed: true, createdAt: time, updatedAt: time, lastUsedAt: null });
      session.commit();
      return state();
    },

    /** Adds every usable entry in one commit. An account that already exists keeps its saved password. */
    importMany(entries: Array<WebsiteCredentialInput & { agentAllowed?: unknown }>): WebsiteCredentialImportSummary {
      const session = requireSession();
      const summary = { added: 0, skipped: 0, invalid: 0 };
      const time = now();
      for (const entry of entries) {
        const origin = normalizeWebsiteCredentialOrigin(entry?.origin);
        const note = typeof entry?.note === "string" ? entry.note.slice(0, WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH) : "";
        if (!origin || typeof entry.username !== "string" || !entry.username || entry.username.length > WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH
          || typeof entry.password !== "string" || !entry.password || entry.password.length > WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH) {
          summary.invalid += 1;
        } else if (session.payload.credentials.some(item => item.origin === origin && item.username === entry.username)) {
          summary.skipped += 1;
        } else {
          session.payload.credentials.push({ id: randomUUID(), origin, username: entry.username, password: entry.password, note, agentAllowed: entry.agentAllowed !== false, createdAt: time, updatedAt: time, lastUsedAt: null });
          summary.added += 1;
        }
      }
      if (summary.added) session.commit();
      return summary;
    },

    /** Every saved account in full, for an encrypted backup. Callers gate it with system authentication. */
    exportAll() {
      return requireSession().payload.credentials.map(({ origin, username, password, note, agentAllowed }) => ({ origin, username, password, note, agentAllowed }));
    },

    update(patch: WebsiteCredentialPatch): WebsiteCredentialState {
      const session = requireSession();
      const credential = find(session.payload, patch?.id);
      if (patch.username !== undefined) {
        const username = checkedText(patch.username, WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH, true);
        if (session.payload.credentials.some(item => item !== credential && item.origin === credential.origin && item.username === username)) throw new WebsiteCredentialError("duplicate");
        credential.username = username;
      }
      if (patch.password !== undefined) credential.password = checkedText(patch.password, WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH, true);
      if (patch.note !== undefined) credential.note = checkedText(patch.note, WEBSITE_CREDENTIAL_NOTE_MAX_LENGTH, false);
      if (patch.agentAllowed !== undefined) {
        if (typeof patch.agentAllowed !== "boolean") throw new WebsiteCredentialError("invalidInput");
        credential.agentAllowed = patch.agentAllowed;
      }
      if (patch.isSiteDefault !== undefined) {
        if (typeof patch.isSiteDefault !== "boolean") throw new WebsiteCredentialError("invalidInput");
        if (patch.isSiteDefault) session.payload.siteDefaults[credential.origin] = credential.id;
        else if (session.payload.siteDefaults[credential.origin] === credential.id) delete session.payload.siteDefaults[credential.origin];
      }
      credential.updatedAt = now();
      session.commit();
      return state();
    },

    remove(id: unknown): WebsiteCredentialState {
      const session = requireSession();
      const credential = find(session.payload, id);
      session.payload.credentials = session.payload.credentials.filter(item => item !== credential);
      if (session.payload.siteDefaults[credential.origin] === credential.id) delete session.payload.siteDefaults[credential.origin];
      session.commit();
      return state();
    },

    /** The only read path that yields a password. Callers gate it (system authentication, or a fill into the matching page). */
    reveal(id: unknown): WebsiteCredentialSecret {
      const { id: credentialId, origin, username, password } = find(requireSession().payload, id);
      return { id: credentialId, origin, username, password };
    },

    /** `origin` must already be the page origin resolved by Main; it is not re-derived from caller input here. */
    listForOrigin(origin: string, scope: { agentOnly: boolean }): WebsiteCredentialSummary[] {
      const session = requireSession();
      return orderedForOrigin(session.payload, origin, scope.agentOnly).map(item => summarize(session.payload, item));
    },

    /**
     * Resolves the account to fill on `origin`: the site default (or most recent) unless an
     * id is requested. A requested id outside that origin and scope resolves to nothing.
     */
    resolveForOrigin(origin: string, scope: { agentOnly: boolean; id?: string }): WebsiteCredentialSecret | null {
      const candidates = orderedForOrigin(requireSession().payload, origin, scope.agentOnly);
      const chosen = scope.id === undefined ? candidates[0] : candidates.find(item => item.id === scope.id);
      return chosen ? { id: chosen.id, origin: chosen.origin, username: chosen.username, password: chosen.password } : null;
    },

    markUsed(id: string) {
      const session = requireSession();
      find(session.payload, id).lastUsedAt = now();
      session.commit();
    }
  };
}

export type WebsiteCredentialStore = ReturnType<typeof createWebsiteCredentialStore>;
