import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH,
  WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH,
  normalizeWebsiteCredentialOrigin,
  type WebsiteCredentialSaveDecision,
  type WebsiteCredentialSaveOffer
} from "../../../../shared/website-credentials";
import type { WebsiteCredentialStore } from "../store";
import {
  LOGIN_OBSERVER_NEXT_SCRIPT,
  LOGIN_OBSERVER_PASSWORD_FIELD_SCRIPT,
  LOGIN_OBSERVER_WORLD_ID,
  buildLoginObserverInstallScript,
  type LoginObserverEvent
} from "./page-script";

/** How long a first-step identifier waits for the password page. */
const PENDING_USERNAME_TTL_MS = 120_000;
/** A submitted login is judged after the page has had time to answer. */
const OUTCOME_SETTLE_MS = 2_500;
const OUTCOME_RETRY_MS = 1_500;
const OUTCOME_MAX_PROBES = 4;
/** An unanswered save prompt is dropped together with its password. */
const OFFER_TTL_MS = 120_000;
const MAX_OPEN_OFFERS = 4;

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
type PendingOffer = WebsiteCredentialSaveOffer & { password: string; expiry: unknown };

export type LoginCaptureOptions = {
  store: Pick<WebsiteCredentialStore, "isCaptureEnabled" | "classifyCaptured" | "saveCaptured" | "setNeverSave">;
  /** Shows the save prompt in Desktop's trusted UI. Returns false when no window can show it. */
  presentOffer(offer: WebsiteCredentialSaveOffer): boolean;
  withdrawOffer(offerId: string): void;
  now?: () => number;
  timers?: Timers;
};

/**
 * Observes logins in web guests and turns them into save prompts.
 *
 * Captured passwords exist only in this controller's memory, bounded in number and
 * time, and are never logged or sent to a renderer.
 */
export function createLoginCapture(options: LoginCaptureOptions) {
  const now = options.now ?? Date.now;
  const timers: Timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
  const installScript = buildLoginObserverInstallScript({ maxUsername: WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH, maxPassword: WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH });
  const offers = new Map<string, PendingOffer>();
  const guests = new Map<number, { start(): void; dispose(): void }>();

  function dropOffer(offerId: string, withdraw: boolean) {
    const offer = offers.get(offerId);
    if (!offer) return;
    offers.delete(offerId);
    timers.clear(offer.expiry);
    offer.password = "";
    if (withdraw) options.withdrawOffer(offerId);
  }

  function offer(candidate: { origin: string; username: string; password: string }, verified: boolean) {
    const relation = options.store.classifyCaptured(candidate.origin, candidate.username, candidate.password);
    if (relation !== "new" && relation !== "changed") return;
    // A repeated attempt for the same account replaces its earlier prompt.
    for (const existing of offers.values()) {
      if (existing.origin === candidate.origin && existing.username === candidate.username) dropOffer(existing.offerId, true);
    }
    if (offers.size >= MAX_OPEN_OFFERS) dropOffer(offers.keys().next().value!, true);
    const offerId = randomUUID();
    const summary: WebsiteCredentialSaveOffer = { offerId, origin: candidate.origin, username: candidate.username, kind: relation === "new" ? "save" : "update", verified };
    if (!options.presentOffer(summary)) return;
    offers.set(offerId, { ...summary, password: candidate.password, expiry: timers.set(() => dropOffer(offerId, true), OFFER_TTL_MS) });
  }

  function attach(guest: WebContents) {
    if (guests.has(guest.id) || guest.isDestroyed()) return;
    let disposed = false;
    // Each document gets its own pump; events from a superseded document are ignored.
    let generation = 0;
    let pendingUsername: { value: string; at: number } | null = null;
    let outcomeTimer: unknown = null;

    const inWorld = (code: string) => guest.executeJavaScriptInIsolatedWorld(LOGIN_OBSERVER_WORLD_ID, [{ code }]);

    /** Chrome's rule of thumb: the login worked if the page moved on and no longer shows a password field. */
    function judge(candidate: { origin: string; username: string; password: string }, probe: number) {
      outcomeTimer = timers.set(async () => {
        outcomeTimer = null;
        if (disposed || guest.isDestroyed() || !options.store.isCaptureEnabled()) return;
        let passwordFieldVisible: boolean | null = null;
        try {
          passwordFieldVisible = await inWorld(LOGIN_OBSERVER_PASSWORD_FIELD_SCRIPT);
        } catch {
          // The page is mid-navigation; probe again.
        }
        if (disposed) return;
        if (passwordFieldVisible === false) return offer(candidate, true);
        // Still on a password form: most likely a rejected login. Wait in case the page is slow, then give up.
        if (probe + 1 < OUTCOME_MAX_PROBES) return judge(candidate, probe + 1);
        if (passwordFieldVisible === null) offer(candidate, false);
      }, probe === 0 ? OUTCOME_SETTLE_MS : OUTCOME_RETRY_MS);
    }

    function handle(event: LoginObserverEvent | null) {
      if (!event || typeof event !== "object") return;
      const origin = normalizeWebsiteCredentialOrigin(event.origin);
      if (!origin || typeof event.username !== "string" || event.username.length > WEBSITE_CREDENTIAL_USERNAME_MAX_LENGTH) return;
      if (event.type === "username") {
        if (event.username) pendingUsername = { value: event.username, at: now() };
        return;
      }
      if (event.type !== "credential" || typeof event.password !== "string" || !event.password || event.password.length > WEBSITE_CREDENTIAL_PASSWORD_MAX_LENGTH) return;
      const remembered = pendingUsername && now() - pendingUsername.at <= PENDING_USERNAME_TTL_MS ? pendingUsername.value : "";
      pendingUsername = null;
      const username = event.username || remembered;
      // Without an account identifier there is nothing to match the password to later.
      if (!username) return;
      if (outcomeTimer !== null) timers.clear(outcomeTimer);
      judge({ origin, username, password: event.password }, 0);
    }

    async function pump() {
      const mine = ++generation;
      if (disposed || guest.isDestroyed() || !options.store.isCaptureEnabled()) return;
      // Only authenticated HTTPS pages: the same rule the vault uses for storable origins.
      if (!normalizeWebsiteCredentialOrigin(guest.getURL())) return;
      try {
        await inWorld(installScript);
        while (!disposed && mine === generation && !guest.isDestroyed()) {
          const event = await inWorld(LOGIN_OBSERVER_NEXT_SCRIPT) as LoginObserverEvent | null;
          if (disposed || mine !== generation) return;
          if (event === null) return;
          if (options.store.isCaptureEnabled()) handle(event);
        }
      } catch {
        // The document went away; the next dom-ready starts a new pump.
      }
    }

    const start = () => { void pump(); };
    const destroyed = () => detach(guest.id);
    guest.on("dom-ready", start);
    guest.once("destroyed", destroyed);
    guests.set(guest.id, {
      start,
      dispose() {
        disposed = true;
        generation += 1;
        pendingUsername = null;
        if (outcomeTimer !== null) timers.clear(outcomeTimer);
        guest.off("dom-ready", start);
        guest.off("destroyed", destroyed);
      }
    });
    start();
  }

  function detach(webContentsId: number) {
    const entry = guests.get(webContentsId);
    if (!entry) return;
    guests.delete(webContentsId);
    entry.dispose();
  }

  return {
    attach,
    detach,

    /** The user's answer to a save prompt. Unknown or expired offers are ignored. */
    resolveOffer(offerId: unknown, decision: WebsiteCredentialSaveDecision) {
      const pending = typeof offerId === "string" ? offers.get(offerId) : undefined;
      if (!pending) return false;
      const { origin, username, password } = pending;
      try {
        if (decision === "save") options.store.saveCaptured({ origin, username, password });
        else if (decision === "never") options.store.setNeverSave(origin, true);
      } finally {
        dropOffer(pending.offerId, false);
      }
      return true;
    },

    /** Recording was switched on: start observing the pages that are already open. */
    refresh() {
      for (const entry of guests.values()) entry.start();
    },

    /** Lock screen, sleep, or recording switched off: forget everything not yet saved. */
    clearPending() {
      for (const offerId of [...offers.keys()]) dropOffer(offerId, true);
    },

    pendingOfferCount: () => offers.size
  };
}

export type LoginCapture = ReturnType<typeof createLoginCapture>;
