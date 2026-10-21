export type DesktopSsoLoginFailureReason =
  | "dns"
  | "offline"
  | "proxy"
  | "timeout"
  | "connection"
  | "certificate"
  | "process"
  | "unknown";

export type DesktopSsoLoginLoadFailure = {
  readonly reason: DesktopSsoLoginFailureReason;
  readonly code: number | null;
};

export type DesktopSsoLoginLoadState = {
  readonly attempt: number;
  readonly status: "loading" | "ready" | "failed";
  readonly failure: DesktopSsoLoginLoadFailure | null;
};

type LoginGuest = Pick<Electron.WebviewTag, "addEventListener" | "removeEventListener" | "getURL">;

export const DESKTOP_SSO_LOGIN_PAGE_TIMEOUT_MS = 30_000;

export function createDesktopSsoLoginLoadState(): DesktopSsoLoginLoadState {
  return { attempt: 0, status: "loading", failure: null };
}

export function classifyDesktopSsoLoginLoadFailure(errorCode: unknown): DesktopSsoLoginLoadFailure {
  const code = typeof errorCode === "number" && Number.isSafeInteger(errorCode) && errorCode < 0
    ? errorCode
    : null;
  // Chromium net error codes are shared by Electron on macOS and Windows.
  // https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h
  let reason: DesktopSsoLoginFailureReason = "unknown";
  if (code === -105 || code === -137) reason = "dns";
  else if (code === -106) reason = "offline";
  else if (code === -111 || code === -120 || code === -121 || code === -130 || code === -131) reason = "proxy";
  else if (code === -7 || code === -118) reason = "timeout";
  else if (code !== null && code <= -200 && code > -300) reason = "certificate";
  else if (code !== null && code <= -100 && code >= -109) reason = "connection";
  return { reason, code };
}

export function createDesktopSsoLoginLoadController(onChange: (state: DesktopSsoLoginLoadState) => void) {
  let state = createDesktopSsoLoginLoadState();
  let generation = 0;
  let activeGuest: LoginGuest | null = null;
  let removeListeners: (() => void) | null = null;
  let loadTimeout: ReturnType<typeof setTimeout> | null = null;
  let timeoutGeneration = 0;

  const publish = (next: DesktopSsoLoginLoadState) => {
    state = next;
    onChange(state);
  };
  const clearLoadTimeout = () => {
    timeoutGeneration += 1;
    if (loadTimeout !== null) clearTimeout(loadTimeout);
    loadTimeout = null;
  };
  const detach = () => {
    clearLoadTimeout();
    generation += 1;
    activeGuest = null;
    removeListeners?.();
    removeListeners = null;
  };
  const fail = (failure: DesktopSsoLoginLoadFailure) => {
    clearLoadTimeout();
    // A following stop/finish for Chromium's error document must not erase the
    // original failure. A late precise failure may refine the generic fallback.
    if (state.status === "failed" && (state.failure?.reason !== "unknown" || failure.reason === "unknown")) return;
    publish({ ...state, status: "failed", failure });
  };

  return {
    getState: () => state,
    detach,
    retry() {
      // Retire the old guest synchronously, before React mounts its replacement.
      detach();
      publish({ attempt: state.attempt + 1, status: "loading", failure: null });
    },
    bindGuest(guest: LoginGuest | null) {
      detach();
      if (!guest) return;
      activeGuest = guest;
      const currentGeneration = generation;
      const isCurrent = () => activeGuest === guest && generation === currentGeneration;
      const startLoadTimeout = () => {
        clearLoadTimeout();
        const currentTimeoutGeneration = timeoutGeneration;
        loadTimeout = setTimeout(() => {
          if (isCurrent() && timeoutGeneration === currentTimeoutGeneration && state.status === "loading") {
            fail({ reason: "timeout", code: null });
          }
        }, DESKTOP_SSO_LOGIN_PAGE_TIMEOUT_MS);
      };
      const started = (event: Event) => {
        const details = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
        // did-start-loading aggregates iframe/subresource activity. A dynamic
        // MFA frame must not cover an already usable top-level login form.
        if (details.isMainFrame !== true || details.isInPlace === true) return;
        if (isCurrent() && state.status !== "failed") {
          if (state.status !== "loading") publish({ ...state, status: "loading", failure: null });
          startLoadTimeout();
        }
      };
      const finished = () => {
        if (!isCurrent() || state.status === "failed") return;
        try {
          const url = guest.getURL();
          if (url.startsWith("chrome-error://")) {
            fail({ reason: "unknown", code: null });
          } else if (url && url !== "about:blank") {
            clearLoadTimeout();
            if (state.status !== "ready") publish({ ...state, status: "ready", failure: null });
          }
        } catch {
          fail({ reason: "unknown", code: null });
        }
      };
      const failed = (event: Event) => {
        const details = event as Event & { errorCode?: unknown; isMainFrame?: boolean };
        if (!isCurrent() || details.isMainFrame !== true || details.errorCode === -3) return;
        // Never retain the event's URL or errorDescription: they may contain
        // authorization codes, state values or other sensitive query fields.
        fail(classifyDesktopSsoLoginLoadFailure(details.errorCode));
      };
      const processGone = () => {
        if (isCurrent()) fail({ reason: "process", code: null });
      };
      const listeners: Array<[string, EventListener]> = [
        ["did-start-navigation", started],
        // The form is usable at DOM readiness even if an image or other
        // subresource keeps loading. This is page readiness, not SSO success.
        ["dom-ready", finished],
        ["did-finish-load", finished],
        ["did-stop-loading", finished],
        ["did-fail-load", failed],
        ["render-process-gone", processGone]
      ];
      for (const [name, listener] of listeners) guest.addEventListener(name, listener);
      removeListeners = () => {
        for (const [name, listener] of listeners) guest.removeEventListener(name, listener);
      };
      if (state.status === "loading") startLoadTimeout();
    }
  };
}
