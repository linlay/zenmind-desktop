/** Page-only session exchange; never returns credentials. */
export const WEBAPP_AUTH_CHANNEL = "webapp.auth.createSession";
export const WEBAPP_AUTH_GLOBAL = "__ZENMIND_AUTH__";
export interface WebappAuthSessionInput { exchangePath: string }
export type WebappAuthSessionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };
