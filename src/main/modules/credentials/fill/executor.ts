import type { WebContents } from "electron";
import { LOGIN_OBSERVER_WORLD_ID } from "../capture/page-script";
import { LOGIN_FILL_STATE_SCRIPT, buildLoginFillClearScript, buildLoginFillScript, type LoginFillOutcome } from "./page-script";

/** After submitting, how long Desktop waits for the login form to go away. */
const SUBMIT_SETTLE_MS = 8_000;
/** After filling without submitting, how long the user has to finish the login. */
const USER_TAKEOVER_MS = 120_000;
const PROBE_INTERVAL_MS = 1_000;
const PROBE_TIMEOUT_MS = 1_500;

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
  | { status: "no_login_form"; reason: "no_password_field" | "several_password_fields" }
  | { status: "page_changed" };

export type LoginFillOptions = {
  username: string;
  password: string;
  submit: boolean;
  /** Re-checked inside the hold, immediately before the password is written. */
  isPageCurrent(): boolean;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Writes a saved login into the page while its automation is paused, and keeps it paused
 * for as long as the password is readable in the form. A password that is still in the
 * form when the pause ends is erased first, so no later tool call can read it.
 */
export function fillLoginForm(target: LoginFillTarget, options: LoginFillOptions): Promise<LoginFillResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const { contents } = target;
  const inWorld = (code: string) => Promise.race([
    contents.executeJavaScriptInIsolatedWorld(LOGIN_OBSERVER_WORLD_ID, [{ code }]),
    sleep(PROBE_TIMEOUT_MS).then(() => { throw new Error("probe timeout"); })
  ]);
  /** null while the page is navigating or gone. */
  const fieldState = async () => {
    if (contents.isDestroyed()) return { visible: false, pending: false };
    try { return await inWorld(LOGIN_FILL_STATE_SCRIPT) as { visible: boolean; pending: boolean }; } catch { return null; }
  };
  const erase = async () => {
    if (contents.isDestroyed()) return;
    try { await inWorld(buildLoginFillClearScript(options.password)); } catch { /* The document is gone, and the field with it. */ }
  };
  /** Waits until no password field holds a value, erasing it when time runs out. Returns whether a field is still shown. */
  const settle = async (limitMs: number) => {
    let state: Awaited<ReturnType<typeof fieldState>> = null;
    for (let waited = 0; waited < limitMs; waited += PROBE_INTERVAL_MS) {
      await sleep(PROBE_INTERVAL_MS);
      state = await fieldState();
      if (state && !state.pending) return state.visible;
    }
    await erase();
    return state?.visible ?? true;
  };

  return target.holdAutomation(async (release) => {
    let holding = false;
    try {
      if (contents.isDestroyed() || !options.isPageCurrent()) return { status: "page_changed" };
      let outcome: LoginFillOutcome;
      try {
        outcome = await inWorld(buildLoginFillScript(options)) as LoginFillOutcome;
      } catch {
        // The write may have landed before the page went away.
        await erase();
        return { status: "page_changed" };
      }
      if (outcome.status === "no_login_form" || outcome.status === "username_only") return outcome;
      if (outcome.status === "submitted") return { status: "submitted", loginFormVisible: await settle(SUBMIT_SETTLE_MS) };
      // Not submitted: the user finishes the login. Automation stays paused in the background until they do.
      holding = true;
      void settle(USER_TAKEOVER_MS).finally(release);
      return { status: "filled" };
    } finally {
      if (!holding) release();
    }
  });
}
