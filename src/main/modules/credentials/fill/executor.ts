import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { LOGIN_OBSERVER_WORLD_ID } from "../capture/page-script";
import {
  buildLoginFillClearScript,
  buildLoginFillScript,
  buildLoginFillStateScript,
  type LoginFillFieldState,
  type LoginFillOutcome,
  type LoginFillRefusal
} from "./page-script";

/** After submitting, how long Desktop waits for the login form to go away. */
const SUBMIT_SETTLE_MS = 8_000;
/** After filling without submitting, how long the user has to finish the login. */
const USER_TAKEOVER_MS = 120_000;
const PROBE_INTERVAL_MS = 1_000;
const PROBE_TIMEOUT_MS = 1_500;
/** Erase attempts made before the action answers; later attempts continue in the background. */
const ERASE_ATTEMPTS = 3;
const ERASE_RETRY_MS = 2_000;

export type LoginFillTarget = {
  contents: Pick<WebContents, "executeJavaScriptInIsolatedWorld" | "isDestroyed">;
  /** Pauses the page's CDP and AWCP until `release` is called; see the web-surfaces gateway. */
  holdAutomation<T>(execute: (release: () => void) => Promise<T>): Promise<T>;
};

export type LoginFillResult =
  | { status: "filled" }
  /** `loginFormVisible` true means the page still asks for a password: rejected login or an extra verification step. */
  | { status: "submitted"; loginFormVisible: boolean }
  | { status: "username_only"; submitted: boolean }
  | { status: "no_login_form"; reason: LoginFillRefusal }
  | { status: "account_unavailable" }
  | { status: "page_changed" };

export type LoginFillOptions = {
  submit: boolean;
  /**
   * Runs inside the pause, immediately before anything is written: re-checks that the
   * request may still proceed and reads the secret. Null when the account may no longer
   * be used. Throwing aborts with nothing written.
   */
  prepare(): Promise<{ username: string; password: string } | null>;
  /** Re-checked inside the pause, immediately before the password is written. */
  isPageCurrent(): boolean;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Writes a saved login into the page while its automation is paused. The pause ends only
 * once the field Desktop wrote is confirmed empty or the document that held it is gone;
 * until then — however long erasing takes — no tool can read the page.
 */
export function fillLoginForm(target: LoginFillTarget, options: LoginFillOptions): Promise<LoginFillResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const { contents } = target;
  const token = randomUUID();
  const inWorld = (code: string) => Promise.race([
    contents.executeJavaScriptInIsolatedWorld(LOGIN_OBSERVER_WORLD_ID, [{ code }]),
    sleep(PROBE_TIMEOUT_MS).then(() => { throw new Error("probe timeout"); })
  ]);
  /** null when the page could not answer (navigating, hung). */
  const fieldState = async (): Promise<LoginFillFieldState | null> => {
    if (contents.isDestroyed()) return { document: "replaced", formVisible: false };
    try { return await inWorld(buildLoginFillStateScript(token)) as LoginFillFieldState; } catch { return null; }
  };
  /** True only when the written field is confirmed empty or its document no longer exists. */
  const erase = async () => {
    if (contents.isDestroyed()) return true;
    try {
      const state = await inWorld(buildLoginFillClearScript(token)) as LoginFillFieldState;
      return state.document === "replaced" || !state.pending;
    } catch {
      // Not answering is not proof of anything: the password may still be there.
      return false;
    }
  };
  const eraseWithRetries = async (attempts: number) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await erase()) return true;
      await sleep(ERASE_RETRY_MS);
    }
    return false;
  };
  /** Keeps trying for as long as the page lives; the pause lasts exactly as long. */
  const eraseEventually = async () => {
    while (!(await erase())) await sleep(ERASE_RETRY_MS);
  };
  /** Waits until the login has moved on: the document changed, the field went away, or the page emptied it. */
  const settle = async (limitMs: number) => {
    let state: LoginFillFieldState | null = null;
    for (let waited = 0; waited < limitMs; waited += PROBE_INTERVAL_MS) {
      await sleep(PROBE_INTERVAL_MS);
      state = await fieldState();
      if (state && (state.document === "replaced" || !state.fieldShown || !state.pending)) break;
    }
    return state?.formVisible ?? true;
  };

  return target.holdAutomation(async (release): Promise<LoginFillResult> => {
    // Until the outcome of a write is known, the pause stays.
    let releaseNow = true;
    try {
      const secret = await options.prepare();
      if (!secret) return { status: "account_unavailable" };
      if (contents.isDestroyed() || !options.isPageCurrent()) return { status: "page_changed" };
      let outcome: LoginFillOutcome;
      try {
        outcome = await inWorld(buildLoginFillScript({ token, ...secret, submit: options.submit })) as LoginFillOutcome;
      } catch {
        // The write may have landed before the page stopped answering.
        if (!(await eraseWithRetries(ERASE_ATTEMPTS))) {
          releaseNow = false;
          void eraseEventually().finally(release);
        }
        return { status: "page_changed" };
      }
      // Neither of these wrote a password.
      if (outcome.status === "no_login_form" || outcome.status === "username_only") return outcome;

      if (outcome.status === "submitted") {
        const loginFormVisible = await settle(SUBMIT_SETTLE_MS);
        if (!(await eraseWithRetries(ERASE_ATTEMPTS))) {
          releaseNow = false;
          void eraseEventually().finally(release);
        }
        return { status: "submitted", loginFormVisible };
      }

      // Not submitted: the user finishes the login while automation stays paused in the background.
      releaseNow = false;
      void (async () => {
        await settle(USER_TAKEOVER_MS);
        await eraseEventually();
      })().finally(release);
      return { status: "filled" };
    } finally {
      if (releaseNow) release();
    }
  });
}
